/**
 * The strip above the account card that answers "where are the settings, and
 * is Cuter Intra even running on this tab?".
 *
 * Chrome does not inject content scripts into tabs that were open before the
 * extension was installed or updated, so a new user clicks the icon on an
 * Intra tab where nothing changed and nothing says why. The popup pings the
 * tab's content script (FT_PING, answered by features/account/popup-bridge.ts)
 * and shows one of:
 *  - no receiver at all: "not running on this tab yet" and a Reload button,
 *    never an automatic reload (the tab may hold an evaluation form or a
 *    forum post being typed);
 *  - an answer from a page where the hub opens: "Open settings";
 *  - an answer from a v2 page: a way to the v3 profile, where the gear is.
 * Anything else (no host access yet, the tab still loading, an older content
 * script that does not know FT_PING) shows nothing rather than a wrong hint.
 */
import { html, render } from "lit-html";
import { t } from "../core/i18n/i18n.ts";
import {
  OPEN_HUB_MESSAGE,
  PING_MESSAGE,
  isPingAnswer,
} from "../features/account/popup-bridge.ts";

export type TabStatus = "none" | "not-running" | "hub" | "v2";

const INTRA_ORIGINS = ["https://*.intra.42.fr/*"];
const V3_PROFILE_URL = "https://profile-v3.intra.42.fr/";

export function isIntraUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    return hostname === "intra.42.fr" || hostname.endsWith(".intra.42.fr");
  } catch {
    return false;
  }
}

/**
 * What both browsers say when no content script listens in the tab: "Could
 * not establish connection. Receiving end does not exist." A listener that
 * answers nothing is a different error (or no error), and means it runs.
 */
function isNoReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|could not establish connection/i.test(
    message,
  );
}

export async function probeTab(
  tab: chrome.tabs.Tab | undefined,
): Promise<TabStatus> {
  if (!tab?.id || !isIntraUrl(tab.url)) return "none";
  // Mid-load the content script may not be listening yet.
  if (tab.status === "loading") return "none";
  try {
    // Without host access (Firefox, until granted) no content script runs:
    // the permission banner is the fix, a reload would change nothing.
    if (!(await chrome.permissions.contains({ origins: INTRA_ORIGINS }))) {
      return "none";
    }
  } catch {
    return "none";
  }
  try {
    const answer = await chrome.tabs.sendMessage(tab.id, {
      type: PING_MESSAGE,
    });
    if (!isPingAnswer(answer)) return "none";
    return answer.hub ? "hub" : "v2";
  } catch (error) {
    return isNoReceiver(error) ? "not-running" : "none";
  }
}

async function openSettings(tabId: number, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    // Waits for the hub to be open: closing the popup first could cut the
    // message off before the page gets it.
    await chrome.tabs.sendMessage(tabId, { type: OPEN_HUB_MESSAGE });
  } catch {
    /* the tab went away: nothing to open */
  }
  window.close();
}

export function renderTabStatus(
  container: HTMLElement,
  status: TabStatus,
  tabId: number | undefined,
): void {
  if (status === "none" || tabId === undefined) {
    render(html``, container);
    return;
  }
  if (status === "not-running") {
    render(
      html`
        <div
          role="status"
          class="flex items-center justify-between gap-3 px-4 py-2 bg-warning text-warning-content text-sm"
        >
          <span>
            <strong>${t("Cuter Intra is not running on this tab yet.")}</strong>
            ${t("It was installed or updated after the tab was opened.")}
          </span>
          <button
            type="button"
            class="btn btn-xs font-bold"
            data-reload-tab
            @click="${() => {
              void chrome.tabs.reload(tabId);
              window.close();
            }}"
          >
            ${t("Reload tab")}
          </button>
        </div>
      `,
      container,
    );
    return;
  }
  if (status === "hub") {
    render(
      html`
        <div class="flex justify-end px-4 pt-3">
          <button
            type="button"
            class="btn btn-sm btn-primary font-bold"
            data-open-settings
            @click="${(e: Event) =>
              void openSettings(tabId, e.currentTarget as HTMLButtonElement)}"
          >
            ${t("Open settings")}
          </button>
        </div>
      `,
      container,
    );
    return;
  }
  render(
    html`
      <div
        class="flex items-center justify-between gap-3 px-4 pt-3 text-sm"
      >
        <span class="opacity-70"
          >${t("The settings are on the Intra v3 profile page.")}</span
        >
        <button
          type="button"
          class="btn btn-sm btn-primary font-bold"
          data-open-v3
          @click="${() => {
            void chrome.tabs.create({ url: V3_PROFILE_URL });
            window.close();
          }}"
        >
          ${t("Open profile")}
        </button>
      </div>
    `,
    container,
  );
}
