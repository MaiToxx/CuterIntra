/**
 * The "new version available" banner of the popup, from what the background's
 * GitHub release check stored.
 *
 * Not in the Chrome Web Store build: Chrome updates a store install by itself
 * once Google has reviewed the upload, and during the review (hours to days
 * after the GitHub tag) the banner would send store users to a zip they can
 * only side-load, as a second copy with another extension id.
 */
import { html, render } from "lit-html";
import { t } from "../core/i18n/i18n.ts";
import { UPDATE_KEY, type UpdateInfo } from "../core/update-check";

/** Compiled in by every Vite config (and vitest's) from CHROME_STORE. */
export const STORE_BUILD: boolean = __STORE_BUILD__;

/** Banner shown above the popup content when a newer GitHub release exists. */
export async function renderUpdateBanner(
  root: HTMLElement,
  storeBuild: boolean = STORE_BUILD,
): Promise<void> {
  if (storeBuild) {
    // A NEW badge an earlier store version (which still ran the check) left
    // on the icon, should the background's onInstalled clean-up have missed.
    try {
      await chrome.action?.setBadgeText?.({ text: "" });
    } catch {
      /* no action API here */
    }
    return;
  }
  const store = await chrome.storage.local.get(UPDATE_KEY);
  const info = store[UPDATE_KEY] as UpdateInfo | undefined;
  if (!info?.version || !info.url) return;
  const current = chrome.runtime.getManifest().version;
  const banner = document.createElement("div");
  banner.id = "update-banner";
  root.parentElement?.insertBefore(banner, root);
  render(
    html`
      <div
        class="flex items-center justify-between gap-3 px-4 py-2 bg-[#00babc] text-white text-sm"
      >
        <span>
          <strong>Cuter Intra ${info.version}</strong> ${t("is available")}
          <span class="opacity-80"
            >${t("(you have {version})", { version: current })}</span
          >
        </span>
        <a
          class="btn btn-xs bg-white text-[#00babc] border-none hover:bg-gray-100 font-bold"
          href="${info.url}"
          target="_blank"
          rel="noopener noreferrer"
          >${t("Download")}</a
        >
      </div>
    `,
    banner,
  );
}
