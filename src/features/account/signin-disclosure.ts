/**
 * The notice shown before the first sign-in on a browser.
 *
 * Signing in sends the Intra session token to a server that is not 42's. The
 * Chrome Web Store user data policy wants that said on screen before it
 * happens and accepted with an explicit click, wherever the sign-in starts:
 * the popup, the hub footer and its Reconnect banner, the friends widget, the
 * profile editor and the calendar panel. They all go through loginWith42(),
 * which asks here, so no entry point can skip it. Accepting is remembered on
 * this browser only (SIGNIN_DISCLOSURE_ACCEPTED is a LOCAL_ONLY key): a later
 * sign-in or a Reconnect does not ask again.
 *
 * The popup shows the same text inline (a modal in a 320 px popup would be
 * cut off) and stores the acceptance itself before calling loginWith42().
 */
import { html, render, type TemplateResult } from "lit-html";
import { getConfig } from "../../core/config.ts";
import { sharedStylesLink } from "../../core/styles/shared-styles.ts";
import { WORKER_HOST } from "../../core/worker.ts";
import { t } from "../../core/i18n/i18n.ts";

export const PRIVACY_POLICY_URL = `${__REPO_URL__}/blob/main/PRIVACY.md`;

const DIALOG_ID = "ft-signin-disclosure";

export async function hasAcceptedSignInDisclosure(): Promise<boolean> {
  try {
    return (await getConfig("SIGNIN_DISCLOSURE_ACCEPTED")) === true;
  } catch {
    return false;
  }
}

export async function acceptSignInDisclosure(): Promise<void> {
  await chrome.storage.local.set({ SIGNIN_DISCLOSURE_ACCEPTED: true });
}

/**
 * What signing in sends and what the server keeps, checked against the worker
 * (handlers/intra-auth.ts) and PRIVACY.md. Change them together.
 */
export function signInDisclosureText(): TemplateResult {
  // One sentence for the translation, {host} drawn in bold where it falls.
  const [beforeHost, afterHost = ""] = t(
    "Signing in sends the Intra session token this page already holds, once, to {host}, the Cuter Intra server. It checks the token against 42's public keys and does not keep it.",
  ).split("{host}");
  return html`
    <p>${beforeHost}<strong>${WORKER_HOST}</strong>${afterHost}</p>
    <p>
      ${t(
        "The server stores a hash of your login and the date you first signed in, nothing else about you.",
      )}
    </p>
    <p>
      ${t(
        "Once you are signed in, other Cuter Intra users see the profile visuals, look and public profile you set, project pages you open report their subject link to the community tracker, and the settings you push are stored under your login hash. You can clear or switch off each of these in the settings.",
      )}
    </p>
    <p>
      ${t("Optional: everything else works without signing in.")}
      <a
        class="underline font-semibold text-primary"
        href="${PRIVACY_POLICY_URL}"
        target="_blank"
        rel="noopener noreferrer"
        >${t("Privacy policy")}</a
      >
    </p>
  `;
}

/** light or dark only: the two themes the shared sheet carries. */
async function dialogTheme(): Promise<"light" | "dark"> {
  try {
    const pref = await getConfig("BETTER_INTRA_THEME");
    if (pref === "light" || pref === "dark") return pref;
  } catch {
    /* fall through to the system preference */
  }
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

let pending: Promise<boolean> | null = null;

function showDisclosureDialog(theme: "light" | "dark"): Promise<boolean> {
  document.getElementById(DIALOG_ID)?.remove();

  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.setAttribute("aria-labelledby", "ft-signin-disclosure-title");
  dialog.className = "bg-transparent backdrop:bg-black/50";
  Object.assign(dialog.style, {
    padding: "0",
    border: "none",
    borderRadius: "1rem",
    maxWidth: "30rem",
    width: "calc(100dvw - 2rem)",
    maxHeight: "calc(100dvh - 1rem)",
  });

  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(accepted);
    };

    render(
      html`
        ${sharedStylesLink()}
        <div
          data-theme="${theme}"
          class="bg-base-100 text-base-content p-5 flex flex-col gap-3 text-sm"
          style="border-radius:1rem;"
        >
          <h2 id="ft-signin-disclosure-title" class="text-lg font-bold">
            ${t("Before you sign in")}
          </h2>
          <div class="flex flex-col gap-2 opacity-90">
            ${signInDisclosureText()}
          </div>
          <div class="flex justify-end gap-2 mt-1">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              @click="${() => finish(false)}"
            >
              ${t("Cancel")}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-primary font-bold"
              data-accept
              @click="${() => finish(true)}"
            >
              ${t("Sign in")}
            </button>
          </div>
        </div>
      `,
      shadow,
    );

    dialog.appendChild(host);
    // Escape closes a modal dialog by itself: that is a refusal too, and the
    // promise must not be left hanging with the sign-in button disabled.
    dialog.addEventListener("close", () => finish(false));
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) finish(false);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * True once the user has accepted the notice on this browser, asking now if
 * they never did. False when they cancel: nothing is sent.
 */
export async function confirmSignInDisclosure(): Promise<boolean> {
  if (await hasAcceptedSignInDisclosure()) return true;
  if (!pending) {
    pending = (async () => {
      const accepted = await showDisclosureDialog(await dialogTheme());
      if (accepted) await acceptSignInDisclosure();
      return accepted;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}
