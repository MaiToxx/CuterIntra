// FIRST, and keep it first: it removes what an earlier instance of the
// extension left in this tab (Firefox injects the new content.js into open
// tabs on update) and it does so at import time, so it must run before any
// other module's top-level code. See the module's comment.
import "./core/lifecycle/stale-instance.ts";
import { initLogtime } from "./features/logtime/logtime.ts";
import { initClusters } from "./features/clusters/clusters.ts";
import { initProfile } from "./features/profile/profile.ts";
import { initHubSettings, openHub } from "./features/hub/hubSettings.ts";
import { answerPopupMessage } from "./features/account/popup-bridge.ts";
import { injectIntraShellFix } from "./core/intra/shell-fix.ts";
import { initShortcuts } from "./features/shortcuts/shortcuts.ts";
import { initSubjectTracker } from "./features/subjects/tracker.ts";
import {
  initThemeManager,
  getIsLight,
} from "./core/theme/theme-manager.ts";
import { maybePromptRestore } from "./features/account/account.ts";
import { initGlobalTooltips } from "./core/dom/tooltip.ts";
import { ensureCampusData } from "./features/campus/campus.ts";
import { updateNavAvatar } from "./features/profile/header/visuals.ts";
import {
  holdAvatar,
  injectAvatarPendingRule,
  releaseAvatar,
} from "./features/profile/header/visuals-apply.ts";
import { AVATAR_SELECTOR } from "./core/intra/selectors.ts";
import { initAnnouncementBanner } from "./features/announcement/announcement.ts";
import { consumeAuthFlow } from "./features/account/auth-callback.ts";
import { initCustomize } from "./features/customize/customize.ts";
import { publishDefaultLookOnce } from "./features/customize/publish.ts";
import { initPerfStyles } from "./features/performance/perf.ts";
import { initEasterEggs } from "./features/eggs/eggs.ts";
import { maybeSyncCalendar } from "./features/calendar/calendar-sync.ts";
import { initI18n, t } from "./core/i18n/i18n.ts";
import { installOrphanErrorFilter } from "./core/lifecycle/orphan-errors.ts";

// The toolbar popup asks this page: sign in with its Intra token (the popup
// cannot see it), "is Cuter Intra running here?", and open the hub.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  answerPopupMessage(message, sendResponse, { openHub }),
);
import { html, render } from "lit-html";

installOrphanErrorFilter();

// The language (UI_LANGUAGE, or the browser's) before any text is drawn:
// everything that renders at start-up waits for it (one settings read).
const i18nReady = initI18n();

initThemeManager();
// the Intra's transparent fixed column eats taps on phones, on every v3 app
injectIntraShellFix();
// user look & feel tweaks (accent, font, size, custom CSS): always on, like the theme
void initCustomize();
void publishDefaultLookOnce();
// "Lighten the Intra": the stylesheet and the preconnect hints have to be in
// place before the React app paints, so they go here with the other styles.
void initPerfStyles();
void initEasterEggs();
void i18nReady.then(() => initAnnouncementBanner());
initGlobalTooltips(getIsLight);

// hook.js is declared in the manifests as a content script running in the
// page's own world ("world": "MAIN", document_start): the browser runs it
// before any page script. It used to be a <script src> appended from here,
// which loads asynchronously and, measured in Firefox 156, was in place
// before the Intra's cached bundle on only 5 of 30 warm reloads.

// The custom avatar must not be preceded by a flash of the Intra picture, so
// the avatar is held (hidden by a class rule) from document_start on the
// profile origin, where initProfile() paints it and releases the hold when its
// watcher stops. A document-wide observer used to do this with an inline
// `opacity: 0` and a 5 s timer: it never disconnected on the other Intra
// hosts, and with the Profile feature off nothing but that timer revealed the
// avatar (see the release below).
if (location.hostname === "profile-v3.intra.42.fr") {
  injectAvatarPendingRule();
  holdAvatar();
}

/**
 * A map that links feature ID strings to their initialization functions.
 * This prevents the need for a long list of if-statements and makes adding
 * new features cleaner.
 */
const featureInitializers: { [key: string]: () => Promise<void> } = {
  profile: initProfile,
  logtime: initLogtime,
  clusters: initClusters,
  shortcuts: initShortcuts,
};

void i18nReady.then(function v2Warning() {
  if (window.location.hostname !== "profile.intra.42.fr") return;
  if (window.location.pathname !== "/") return;
  if (sessionStorage.getItem("ft-v2-dismissed") === "1") return;

  const dismiss = () => {
    const el = document.getElementById("ft-v2-warning");
    if (el) el.remove();
    sessionStorage.setItem("ft-v2-dismissed", "1");
  };

  const banner = document.createElement("div");
  banner.id = "ft-v2-warning";
  // One sentence for the word order; the bold "v3" goes where {v3} stands.
  const [beforeV3, afterV3 = ""] = t(
    "Cuter Intra is designed for the {v3} profile. You are on the old v2.",
  ).split("{v3}");

  render(
    html`
      <style>
        #ft-v2-warning {
          position: relative;
          z-index: 999999;
        }
        .ft-v2-bnr {
          background: #ff9800;
          color: #fff;
          padding: 10px 20px;
          text-align: center;
          font-family:
            system-ui,
            -apple-system,
            sans-serif;
          font-size: 14px;
          font-weight: 500;
          line-height: 1.4;
          position: relative;
        }
        .ft-v2-bnr a {
          color: #fff;
          font-weight: 700;
        }
        .ft-v2-dismiss {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 20px;
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: inherit;
          opacity: 0.6;
          line-height: 1;
          padding: 4px 8px;
        }
        .ft-v2-dismiss:hover {
          opacity: 1;
        }
      </style>
      <div class="ft-v2-bnr">
        ${beforeV3}<strong>v3</strong>${afterV3}
        <a href="https://profile.intra.42.fr/v3_early_access">${t("Switch to v3")}</a>
        <button class="ft-v2-dismiss" @click="${dismiss}" data-tip="${t("Dismiss")}">
          &times;
        </button>
      </div>
    `,
    banner,
  );

  const tryInject = () => {
    if (document.body) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      requestAnimationFrame(tryInject);
    }
  };
  tryInject();
});

(async function runBetterIntra() {
  // The worker currently returns the result in the query string. Also accept
  // it in the URL fragment (#token=...&login=...): fragments never reach the
  // intra servers or their logs, so the worker can switch to them at any time.
  const oauthParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const oauthToken = oauthParams.get("token") ?? hashParams.get("token");
  const oauthLogin = oauthParams.get("login") ?? hashParams.get("login");
  if (oauthToken && oauthLogin) {
    // Only trust the callback if this extension started a login recently.
    // Otherwise any intra link with ?token=&login= could hijack the account.
    if (!(await consumeAuthFlow("cloud"))) {
      console.warn(
        "Cuter Intra: ignoring unexpected auth callback (no login in progress).",
      );
      history.replaceState(null, "", window.location.pathname);
      return;
    }
    await chrome.storage.local.set({
      CLOUD_TOKEN: oauthToken,
      CLOUD_LOGIN: oauthLogin,
      PENDING_SETTINGS_RESTORE: true,
    });
    await chrome.storage.local.remove("CLOUD_AUTH_FAILED");
    history.replaceState(null, "", window.location.pathname);
    window.opener?.postMessage(
      { type: "42_AUTH_SUCCESS", token: oauthToken, login: oauthLogin },
      window.location.origin,
    );
    window.close();
    return;
  }

  const waitForIntra = async () => {
    const target =
      document.getElementById("root") ||
      document.querySelector(AVATAR_SELECTOR) ||
      document.querySelector("body");

    if (target) {
      try {
        await i18nReady;
        // The subject tracker always runs: badges/data are local. Sharing
        // with the collaborative registry is an opt-in setting instead.
        void initSubjectTracker();
        // The .ics feed follows your own profile visits, not the Logtime
        // switch: it returns at once on other pages and without a link.
        void maybeSyncCalendar();

        // Hub settings are always initialized for the settings page.
        // initHubSettings returns the active feature list.
        const activeScripts = await initHubSettings();
        // Only the profile watcher paints and reveals the held avatar.
        if (!activeScripts.includes("profile")) releaseAvatar();

        // Not awaited: the features that need CLUSTERS (clusters, the hub's
        // context, the profile card, the seat highlight) await their own load,
        // and the others must not wait on the worker. Once an hour, when the
        // cache had lapsed, every Intra page stalled here for two round trips.
        ensureCampusData().catch(() => {});
        updateNavAvatar();

        // Loop through the user's active scripts and initialize them if they exist in our map.
        for (const scriptId of activeScripts) {
          const init = featureInitializers[scriptId];
          if (init) {
            try {
              await init();
            } catch (e) {
              console.error(`Feature "${scriptId}" failed to initialize:`, e);
            }
          }
        }

        await maybePromptRestore();
      } catch (error) {
        console.error("Error during init of Cuter Intra :", error);
        // A failed start-up must not leave the avatar hidden.
        releaseAvatar();
      }
    } else {
      setTimeout(() => {
        void waitForIntra();
      }, 100);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => waitForIntra());
  } else {
    waitForIntra();
  }
})();
