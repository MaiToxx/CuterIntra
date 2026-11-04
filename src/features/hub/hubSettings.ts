/**
 * The Cuter Intra entries in the Intra's left sidebar: the gear that opens
 * the settings hub (loaded on demand) and the Clusters button that opens the
 * live cluster map. Mounted when React renders the sidebar, not on a timer.
 */
import { html, render } from "lit-html";
import { FeatureId } from "./hubSettings.data.ts";
import { getConfig } from "../../core/config.ts";
import { t } from "../../core/i18n/i18n.ts";
import GEAR_SVG from "../../assets/svg/settings_gear.svg?raw";
import GLOBE_OUTLINE_SVG from "../../assets/svg/globe-outline.svg?raw";
import { getIsLight } from "../../core/theme/theme-manager.ts";
import { getActiveFeatures } from "./hubSettings.storage.ts";
import { svgFromMarkup } from "../../core/dom/svg.ts";
import { openClusterDialog } from "../clusters/map-dialog.ts";
import { gearClicked } from "../eggs/eggs.ts";
import { watchDom } from "../../core/dom/dom-wait.ts";

function findSidebarMainGroup(): HTMLDivElement | null {
  const profileLink = document.querySelector<HTMLAnchorElement>(
    'a[href="https://profile-v3.intra.42.fr"]',
  );
  return (
    profileLink?.closest<HTMLDivElement>("div.flex.flex-col.w-full") ||
    document.querySelector<HTMLDivElement>(
      "div.flex.flex-col.w-full:not(.pb-16)",
    )
  );
}

/**
 * The sidebar entries are links around an icon: a screen reader has nothing
 * to announce but the aria-label, and the icon itself is decoration. They are
 * <a href>, so Tab reaches them and Enter fires the click already.
 */
function renderGearButton(
  onClick: (e: Event) => void,
): ReturnType<typeof html> {
  return html`<a
    id="hub-gear-btn"
    class="py-5 w-full flex justify-center hover:opacity-100 opacity-40"
    href="#"
    aria-label="${t("Cuter Intra settings")}"
    data-tip="${t("Cuter Intra settings")}"
    data-tip-pos="right"
    @click="${(e: Event) => {
      e.preventDefault();
      onClick(e);
    }}"
  >
    ${svgFromMarkup(GEAR_SVG, { "aria-hidden": "true" })}
  </a>`;
}

function renderClustersButton(
  onClick: (e: Event) => void,
  color: string,
): ReturnType<typeof html> {
  return html`<a
    id="ft-clusters-btn"
    class="py-5 w-full flex justify-center hover:opacity-100 opacity-40"
    href="#"
    aria-label="${t("Cluster map")}"
    data-tip="${t("Clusters")}"
    data-tip-pos="right"
    @click="${(e: Event) => {
      e.preventDefault();
      onClick(e);
    }}"
  >
    ${svgFromMarkup(GLOBE_OUTLINE_SVG, {
      width: "25",
      height: "25",
      stroke: color,
      "aria-hidden": "true",
    })}
  </a>`;
}

/**
 * CLUSTERS_CAMPUS, read once per page instead of once per mount attempt.
 *
 * WHY: mountGearButton() used to run every 500 ms for 10 s, and every run
 * awaited this key - 21 storage round-trips on every Intra page just to decide
 * whether the Clusters button belongs in the sidebar. The value only changes
 * when the campus is detected, which the listener below picks up.
 */
let campusPromise: Promise<string> | null = null;
/** The campus id once read ("" = not detected yet); undefined before that. */
let campusId: string | undefined;
let campusListenerInstalled = false;

const readCampus = (): Promise<string> => {
  if (!campusPromise) {
    campusPromise = getConfig("CLUSTERS_CAMPUS")
      .then((campus) => {
        campusId = campus;
        return campus;
      })
      .catch(() => {
        campusId = "";
        return "";
      });
  }
  return campusPromise;
};

/**
 * The campus is only known once the page fetches it (42_CAMPUS_DETECTED), so
 * it can be detected after the sidebar was already mounted without it. The
 * poll used to catch that; a storage listener catches it without waking up 20
 * times.
 */
function installCampusListener(): void {
  if (campusListenerInstalled) return;
  if (!chrome.storage.onChanged?.addListener) return;
  campusListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("CLUSTERS_CAMPUS" in changes)) return;
    const campus = String(changes.CLUSTERS_CAMPUS.newValue ?? "");
    campusId = campus;
    campusPromise = Promise.resolve(campus);
    mountGearButton();
  });
}

/** Everything this feature has to put in the sidebar is in place. */
function isSidebarComplete(): boolean {
  if (!document.getElementById("hub-gear-btn")) return false;
  // Campus still being read: keep watching, the Clusters button may be due.
  if (campusId === undefined) return false;
  // Not detected yet: nothing more to mount now; the listener takes over.
  if (!campusId) return true;
  return !!document.getElementById("ft-clusters-btn");
}

/**
 * True when this script outlived its extension. Chrome keeps the old content
 * script running in open tabs after an update, a reload or a disable, but its
 * extension APIs are gone (runtime.id is cleared), so the gear and Clusters
 * clicks failed silently. Firefox tears the old script down instead and
 * injects the new one (see core/lifecycle/stale-instance.ts).
 */
function extensionWasReloaded(): boolean {
  try {
    return typeof chrome === "undefined" || !chrome.runtime?.id;
  } catch {
    return true;
  }
}

/** Say why nothing opens, and offer the reload that fixes it. */
function offerReload(): void {
  // A native dialog: our own ones read settings, which is exactly what an
  // orphaned script can no longer do.
  // t() only reads the language this script already knows: no settings read.
  if (window.confirm(t("Cuter Intra was updated. Reload the page to use it?"))) {
    location.reload();
  }
}

/**
 * Opens the settings hub: the gear's click, and the popup's "Open settings"
 * (popup-bridge.ts FT_OPEN_HUB).
 */
export async function openHub(): Promise<void> {
  if (extensionWasReloaded()) {
    offerReload();
    return;
  }
  const { openHubModal } = await import("./hubSettings.ui.ts");
  const active = await getActiveFeatures();
  await openHubModal(active);
}

export function mountGearButton(): void {
  const open = async () => {
    // the easter egg counts gear clicks, not popup opens
    if (!extensionWasReloaded()) void gearClicked();
    await openHub();
  };

  const sidebar = findSidebarMainGroup();

  const openClusters = () => {
    if (extensionWasReloaded()) {
      offerReload();
      return;
    }
    try {
      openClusterDialog();
    } catch (err) {}
  };

  void (async () => {
    // The cluster map reads meta.intra.42.fr and has a selector for every
    // campus, so the button shows as soon as the user's campus is known.
    if (!(await readCampus())) return;
    if (!sidebar) return;

    // Where the Students button (removed: its worker endpoints need a 42 API
    // application) used to sit, so Clusters keeps its place in the sidebar.
    // The anchor is taken before the await, like the Students slot was, so the
    // gear button appended meanwhile cannot shift it.
    if (!document.getElementById("ft-clusters-btn")) {
      const anchor = sidebar.children[1] ?? sidebar.firstElementChild;
      const isLight = await getIsLight();
      // Overlapping calls (the DOM watcher and the campus listener) all pass
      // the check above before any of them gets here: only the first inserts.
      if (document.getElementById("ft-clusters-btn")) return;
      const color = isLight ? "#1a1d24" : "#fff";
      const container = document.createElement("div");
      render(renderClustersButton(openClusters, color), container);
      if (anchor) {
        anchor.after(container.firstElementChild!);
      } else {
        sidebar.prepend(container.firstElementChild!);
      }
    }
  })();

  if (document.getElementById("hub-gear-btn")) return;

  if (sidebar) {
    const container = document.createElement("div");
    render(renderGearButton(open), container);
    sidebar.appendChild(container.firstElementChild!);
  }
}

/** Same budget as the old 500 ms x 20 poll. */
const SIDEBAR_WATCH_MS = 10000;

export async function initHubSettings(): Promise<FeatureId[]> {
  const active = await getActiveFeatures();
  installCampusListener();
  // The sidebar is rendered by React, so we mount when it actually appears
  // instead of re-trying twice a second for ten seconds. watchDom stops as
  // soon as everything is in place, on pagehide, and at the deadline.
  watchDom(
    () => {
      mountGearButton();
      return isSidebarComplete();
    },
    { timeoutMs: SIDEBAR_WATCH_MS, debounceMs: 50 },
  );
  return active;
}
