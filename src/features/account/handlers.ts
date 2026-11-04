import {
  clearAuthFailed,
  hasCloudData,
  loginWith42,
  logoutCloud,
  pullSettings,
  pushSettings,
  wipeAllCloudData,
  type CloudFailure,
} from "./account";
import { AccountState, resetButtonState } from "./state";
import { WORKER_ORIGIN_PATTERN } from "../../core/worker.ts";
import { acceptSignInDisclosure } from "./signin-disclosure.ts";
import { t } from "../../core/i18n/i18n.ts";

/** Hosts the extension must be allowed on for the login flow to complete. */
const REQUIRED_ORIGINS = [
  "https://*.intra.42.fr/*",
  WORKER_ORIGIN_PATTERN,
];

/**
 * Firefox treats the host permissions of a Manifest V3 extension as optional:
 * until the user grants them, no content script runs, including the one that
 * finishes the login on the worker's callback page. Ask from the click
 * handler (a user gesture is required); on Chrome, and once granted, this
 * resolves immediately without any prompt.
 */
async function ensureHostPermissions(): Promise<void> {
  try {
    await chrome.permissions.request({ origins: REQUIRED_ORIGINS });
  } catch {
    /* API unavailable or refused: the opener path may still work */
  }
}

/**
 * The button label for a failed Push or Pull; the sentence under the card
 * (describeCloudFailure) and the sign-in banner say the rest.
 */
function failureLabel(reason: CloudFailure): string {
  if (reason === "auth") return t("Session expired");
  if (reason === "network") return t("Connection Failed");
  if (reason === "busy") return t("Too many requests");
  if (reason === "too-large") return t("Too large");
  // a conflict too: the line under the card says what happened and what to do
  return t("Sync Failed");
}

/**
 * @param updateUI Re-renders from storage and `state`; never talks to the worker.
 */
export function createHandlers(state: AccountState, updateUI: () => void) {
  const reloadActiveTab = async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) chrome.tabs.reload(tab.id);
  };

  const onSignedIn = async () => {
    await clearAuthFailed();
    void chrome.runtime
      .sendMessage({ type: "FT_RELOAD_INTRA_TABS" })
      .catch(() => reloadActiveTab());
    window.close();
  };

  /**
   * Runs the sign-in, from "Sign in" on the notice or straight from the sign-in
   * button once the notice was accepted. The button stays disabled until it
   * ends, so a second click cannot open a second worker session.
   */
  const handleLogin42 = async () => {
    if (state.signingIn) return;
    // Before any await: the browser only shows the permission prompt from
    // within the click's user gesture.
    const permission = ensureHostPermissions();
    const accepting = state.disclosureOpen;
    state.signingIn = true;
    state.loginError = "";
    state.disclosureOpen = false;
    updateUI();
    try {
      if (accepting) {
        await acceptSignInDisclosure();
        state.disclosureAccepted = true;
      }
      await permission;
      await loginWith42(onSignedIn, {
        onFailure: (message) => {
          state.loginError = message;
        },
      });
    } catch (e) {
      state.loginError = String(e);
    } finally {
      state.signingIn = false;
      updateUI();
    }
  };

  /**
   * "Sign in with 42" and "Sign in again": the notice comes first, the first
   * time on this browser. The popup shows it in place of the card (a modal
   * would be cut off at the popup's height) and records the acceptance
   * itself, so loginWith42 then goes straight to the sign-in.
   */
  const startLogin = () => {
    if (state.signingIn) return;
    state.loginError = "";
    if (!state.disclosureAccepted) {
      state.disclosureOpen = true;
      updateUI();
      return;
    }
    void handleLogin42();
  };

  const cancelDisclosure = () => {
    state.disclosureOpen = false;
    updateUI();
  };

  const handleDelete = async () => {
    // Revokes this browser's session only: the worker's DELETE without
    // ?all=true keeps the pushed settings.
    if (
      confirm(
        t("Sign out on this browser? Your settings stay here and in the cloud."),
      )
    ) {
      await logoutCloud();
      await reloadActiveTab();
    }
  };

  const handleWipe = async () => {
    if (
      !confirm(
        t(
          "This permanently deletes everything the Cuter Intra server holds for you: your pushed settings, every signed-in session, your calendar link and your entry in the community counter. Your local settings stay. Continue?",
        ),
      )
    )
      return;

    const success = await wipeAllCloudData();
    if (success) {
      alert(t("All cloud data successfully wiped."));
      await reloadActiveTab();
    } else {
      alert(t("Failed to delete cloud data. Please try again."));
    }
  };

  const handlePush = async () => {
    if (state.buttons.push.loading) return;

    // After a conflict (the line under the card says it), the next click
    // asks, and "yes" pushes without the revision check: Push anyway.
    const force = state.pushFailure?.reason === "conflict";
    if (force && !confirm(t("Replace your cloud settings with this browser's?"))) {
      return;
    }
    // One POST, no probe first: the request's own outcome tells network from
    // session from worker error, and the button reacts on the click itself.
    state.buttons.push = { loading: true, text: t("Connecting...") } as any;
    updateUI();

    const result = await pushSettings({ force });
    if (result === "ok") {
      await clearAuthFailed();
      state.cloud = "online";
      state.buttons.push = {
        loading: false,
        success: true,
        text: t("Synced!"),
      } as any;
    } else {
      if (result === "network") state.cloud = "offline";
      state.buttons.push = {
        loading: false,
        error: true,
        text: failureLabel(result),
      } as any;
    }
    updateUI();
    setTimeout(() => {
      resetButtonState(state, "push", t("Push Settings"));
      updateUI();
    }, 2500);
  };

  const handlePull = async () => {
    if (state.buttons.pull.loading) return;
    if (!confirm(t("Overwrite current local settings with cloud backup?"))) {
      return;
    }

    state.buttons.pull = { loading: true, text: t("Connecting...") } as any;
    updateUI();

    // The one GET serves the restore and the session count alike.
    const result = await pullSettings();
    if (result.ok) {
      state.cloud = "online";
      state.activeSessions = result.activeSessions;
    } else if (result.reason === "network") {
      state.cloud = "offline";
    }

    if (result.ok && hasCloudData(result.settings)) {
      state.buttons.pull = {
        loading: false,
        success: true,
        text: t("Restored!"),
      } as any;
      updateUI();
      setTimeout(() => reloadActiveTab(), 1500);
      return;
    }

    // An empty document is a real answer, not a failure to reach the worker:
    // "No Data Found" used to cover a flaky connection as well.
    state.buttons.pull = {
      loading: false,
      error: true,
      text: result.ok ? t("No backup yet") : failureLabel(result.reason),
    } as any;
    updateUI();
    setTimeout(() => {
      resetButtonState(state, "pull", t("Pull Settings"));
      updateUI();
    }, 2000);
  };

  return {
    startLogin,
    cancelDisclosure,
    handleLogin42,
    handleDelete,
    handleWipe,
    handlePush,
    handlePull,
  };
}
