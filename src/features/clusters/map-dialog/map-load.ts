import type { ClusterInfo, DialogState } from "./context";
import { WORKER_URL, SEAT_TARGET_PX, keyOf, clusterLabel } from "./context";
import { getClusterData, getCampusExits } from "../clusters.data.ts";
import {
  getCachedCluster,
  setCachedCluster,
  scrapeCampusSVGUrls,
} from "./cache";
import { sanitizeAndParseSeats, getSvgTitle, applyMarkers } from "./seats";
import { applyExitSigns } from "./exit-markers";
import { renderActiveList } from "./render";
import {
  loadOccupancy,
  reapplyOccupancy,
  registerClusterLoader,
} from "./occupancy";
import { updateActiveSortControls } from "./active-sort";
import { clearSeatGlow, flashSeat, getSeatGlowTarget } from "./glow";
import { rebuildHeader, updateCampusTime, updateDefaultSelect } from "./header";
import { getCampusFlag } from "../../campus/campus-flags.ts";
import { campusDisplayName, seatCluster } from "./helpers";
import { t } from "../../../core/i18n/i18n.ts";

// occupancy.ts switches to another tab when the Active one disappears: it
// gets loadCluster() from here instead of importing it (no import cycle).
registerClusterLoader(loadCluster);

export function renderNoClusterData(state: DialogState, campusId: string) {
  const mapArea = state.shadow.getElementById("map-area");
  if (!mapArea) return;
  const div = document.createElement("div");
  div.className =
    "flex items-center justify-center p-12 text-center text-base-content/50";
  div.id = "no-cluster-data";
  div.textContent = t("No cluster map for {campus}", {
    campus: campusDisplayName(state.campusOptions, campusId),
  });
  mapArea.replaceChildren(div);
}

export async function buildClusters(campusId: string): Promise<ClusterInfo[]> {
  let repoClusters: { id: string; name: string }[] = [];
  // No id means "the viewer's campus" to meta.intra.42.fr, but the campus
  // files are fetched by id: an empty one would resolve to whichever campus
  // has a file first and mix its cluster names into this one's maps.
  if (campusId) {
    try {
      const data = await getClusterData(campusId);
      repoClusters = data.clusters;
    } catch {
      repoClusters = [];
    }
  }
  const svgs = await scrapeCampusSVGUrls(campusId);
  const list: ClusterInfo[] = [];
  for (const c of repoClusters) {
    const svg = svgs[c.id];
    if (svg) list.push({ id: c.id, name: c.name || "", svg });
  }
  for (const [id, svg] of Object.entries(svgs)) {
    if (!list.some((c) => c.id === id)) list.push({ id, name: "", svg });
  }
  return list;
}

export async function ensureClusterData(
  state: DialogState,
  c: ClusterInfo,
  campusId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!c.svg) {
    return null;
  }
  const key = keyOf(campusId, c.id);
  try {
    if (state.seatPosCache.has(key) && state.svgViewBoxes.has(key)) {
      return "cached";
    }
    const cached = await getCachedCluster(campusId, c.id);
    let svgText = cached?.svg;
    // An expired map served because the worker failed: shown, but not saved
    // back as fresh, so the next open asks the worker again.
    let stale = false;
    if (!svgText) {
      const url = `${WORKER_URL}/api/v1/cluster/svg?url=${encodeURIComponent(c.svg)}`;
      try {
        const res = await fetch(url, { signal });
        if (res.ok) svgText = await res.text();
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      if (!svgText) {
        svgText = (await getCachedCluster(campusId, c.id, { allowStale: true }))?.svg;
        if (!svgText) return null;
        stale = true;
      }
    }
    if (!state.svgViewBoxes.has(key)) {
      const svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const seatMap = sanitizeAndParseSeats(svgDoc);
      state.parsedDocs.set(key, svgDoc);
      const title = getSvgTitle(svgDoc);
      if (title && !c.name.trim()) c.name = title;
      const vb = (svgDoc.querySelector("svg")?.getAttribute("viewBox") ?? "")
        .split(/\s+/)
        .map(Number);
      state.svgViewBoxes.set(key, { w: vb[2] || 1200, h: vb[3] || 800 });
      state.seatPosCache.set(key, seatMap);
      if (!stale) setCachedCluster(campusId, c.id, {
        svg: svgText,
        seats: [...seatMap],
        viewBox: state.svgViewBoxes.get(key)!,
        cachedAt: 0,
      }).catch(warnOnQuota);
    }
    return svgText;
  } catch {
    return null;
  }
}

let quotaWarned = false;

/**
 * A map that cannot be cached is not an error for the user, but a full
 * chrome.storage.local (Chrome caps it at 10 MB) also makes every later
 * settings write fail: say so once, instead of nothing at all.
 */
export function warnOnQuota(err: unknown): void {
  if (quotaWarned) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (!/quota/i.test(msg)) return;
  quotaWarned = true;
  console.warn("[Cuter Intra] cluster map not cached: storage is full", msg);
}

/**
 * "Failed to load map" with a Retry button. Shown when the worker and the
 * stale cache both had nothing: an empty pane looked like a blank map.
 */
export function renderMapError(
  state: DialogState,
  cluster: ClusterInfo,
  signal?: AbortSignal,
) {
  const mapArea = state.shadow.getElementById("map-area");
  if (!mapArea) return;
  const errorDiv = document.createElement("div");
  errorDiv.className =
    "flex flex-col items-center justify-center gap-3 p-12 text-base-content/50";
  errorDiv.id = "map-error";
  const text = document.createElement("span");
  text.textContent = t("Failed to load map");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-sm";
  retry.id = "map-retry";
  retry.textContent = t("Retry");
  retry.addEventListener("click", () => {
    void loadCluster(state, cluster, signal);
  });
  errorDiv.append(text, retry);
  mapArea.replaceChildren(errorDiv);
}

export function trimSvgToContent(state: DialogState) {
  const mapArea = state.shadow.getElementById("map-area");
  const svg = mapArea?.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  try {
    const bbox = svg.getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      const pad = 10;
      const minX = bbox.x - pad;
      const minY = bbox.y - pad;
      const maxX = bbox.x + bbox.width + pad;
      const maxY = bbox.y + bbox.height + pad;
      svg.setAttribute(
        "viewBox",
        `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      );
    }
  } catch {}
}

export function updateZoom(state: DialogState) {
  const mapArea = state.shadow.getElementById("map-area");
  const svg = mapArea?.querySelector("svg") as SVGSVGElement | null;
  if (mapArea && svg) {
    svg.style.width = `${Math.max(
      1,
      Math.round(mapArea.clientWidth * state.zoomLevel),
    )}px`;
    svg.style.height = "auto";
  }
  const pct = state.shadow.querySelector(".zoom-pct") as HTMLElement | null;
  if (pct) pct.textContent = `${Math.round(state.zoomLevel * 100)}%`;
  requestAnimationFrame(() => reapplyOccupancy(state));
}

export async function loadCluster(
  state: DialogState,
  cluster: ClusterInfo,
  signal?: AbortSignal,
  retry = false,
) {
  state.activeCluster = cluster;
  state.zoomLevel = 1.0;
  clearSeatGlow(state);
  const isOverview = cluster.id === "active";
  const badge = state.shadow.getElementById("seat-count-badge");
  if (badge) badge.style.display = isOverview ? "none" : "";
  const zoomCtrls = state.shadow.getElementById("zoom-controls");
  if (zoomCtrls) zoomCtrls.style.display = isOverview ? "none" : "";
  const sortCtrls = state.shadow.getElementById("active-sort");
  if (sortCtrls)
    sortCtrls.style.display = cluster.id === "active" ? "" : "none";
  const topBadges = state.shadow.getElementById("top-left-badges");
  topBadges?.classList.toggle("active-tab", cluster.id === "active");
  const id = ++state.loadId;
  // A retry keeps its count: resetting it here made a load that failed every
  // time (a map the browser cannot lay out) retry itself forever.
  if (!retry) state.retryCount = 0;

  state.shadow.querySelectorAll("[data-cluster-id]").forEach((el) => {
    const active = (el as HTMLElement).dataset.clusterId === cluster.id;
    (el as HTMLElement).classList.toggle("tab-active", active);
    (el as HTMLElement).classList.toggle("menu-active", active);
  });

  const summaryLabel = state.shadow.querySelector<HTMLElement>(
    ".clusters-nav-summary-label",
  );
  if (summaryLabel) summaryLabel.textContent = clusterLabel(cluster);

  const tabsRow = state.shadow.querySelector<HTMLElement>(".tabs-scroll");
  const activeTab = tabsRow?.querySelector<HTMLElement>(
    `[data-cluster-id="${CSS.escape(cluster.id)}"]`,
  );
  activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });

  const mapArea = state.shadow.getElementById("map-area");
  if (!mapArea) return;

  {
    const spinnerContainer = document.createElement("div");
    spinnerContainer.className = "flex items-center justify-center p-12";
    const spinner = document.createElement("span");
    spinner.className = "loading loading-spinner loading-lg";
    spinnerContainer.appendChild(spinner);
    mapArea.replaceChildren(spinnerContainer);
  }

  if (cluster.id === "active") {
    updateActiveSortControls(state);
    renderActiveList(state);
    return;
  }

  try {
    const svgText = await ensureClusterData(
      state,
      cluster,
      state.activeCampusId,
      signal,
    );
    if (!svgText) {
      if (id !== state.loadId) return;
      renderMapError(state, cluster, signal);
      return;
    }
    if (id !== state.loadId) return;

    let svgDoc = state.parsedDocs.get(keyOf(state.activeCampusId, cluster.id));
    if (!svgDoc) {
      // never import an unsanitized document into the page
      svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      sanitizeAndParseSeats(svgDoc);
    }

    mapArea.style.position = "relative";
    const imported = document.importNode(svgDoc.documentElement, true);
    const centeringWrap = document.createElement("div");
    centeringWrap.style.cssText =
      "display:flex;align-items:flex-start;min-height:100%;padding-top:2rem;";
    centeringWrap.appendChild(imported);
    mapArea.replaceChildren(centeringWrap);
    const svgEl = mapArea.querySelector("svg") as SVGSVGElement | null;
    const zp = state.shadow.querySelector(".zoom-pct") as HTMLElement | null;
    if (zp) zp.textContent = "100%";
    mapArea.scrollTop = 0;
    mapArea.scrollLeft = 0;
    applyMarkers(mapArea, state.showMarkers);
    applyExitSigns(state);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    trimSvgToContent(state);
    mapArea.scrollTop = 0;
    mapArea.scrollLeft = 0;

    const seats = state.seatPosCache.get(
      keyOf(state.activeCampusId, cluster.id),
    );
    if (seats && seats.size > 0 && svgEl) {
      const vb = (svgEl.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      const rect = svgEl.getBoundingClientRect();
      if (rect.width > 0) {
        const scaleX = rect.width / (vb[2] || 1200);
        const ws = [...seats.values()].map((s) => s.w).sort((a, b) => a - b);
        const hs = [...seats.values()].map((s) => s.h).sort((a, b) => a - b);
        const unit = Math.max(
          ws[Math.floor(ws.length / 2)],
          hs[Math.floor(hs.length / 2)],
        );
        state.zoomLevel = Math.min(
          3,
          Math.max(0.4, SEAT_TARGET_PX / (unit * scaleX)),
        );
        state.defaultZoomLevel = state.zoomLevel;
      }
    }
    updateZoom(state);

    if (id !== state.loadId) return;

    reapplyOccupancy(state);
  } catch {
    if (id !== state.loadId) return;
    state.retryCount++;
    if (state.retryCount <= 1) {
      loadCluster(state, state.activeCluster, signal, true);
    } else {
      state.retryCount = 0;
      renderMapError(state, cluster, signal);
    }
  }
}

/**
 * Opens the map that holds `seat` and makes the seat glow, as opening the
 * dialog on a friend's seat does (the Active list's seat buttons and Enter
 * in its search box). Focus moves to the seat itself: the button or the box
 * that was focused disappears with the Active tab, and would drop keyboard
 * users at the top of the page. A seat with no avatar link over it (its
 * position is not in the map) sends focus to the cluster's tab instead.
 */
export async function jumpToSeat(
  state: DialogState,
  seat: string,
  signal?: AbortSignal,
): Promise<void> {
  const cluster = seatCluster(state.clusters, seat);
  if (!cluster) return;
  await loadCluster(state, cluster, signal);
  // closed, or another tab picked while the map loaded
  if (signal?.aborted || state.activeCluster !== cluster) return;
  flashSeat(state, seat);
  const target = getSeatGlowTarget(state, seat);
  const tabs = state.shadow.querySelectorAll<HTMLElement>(
    `[data-cluster-id="${CSS.escape(cluster.id)}"]`,
  );
  // the tab row or, when the tabs overflow, the menu: whichever is shown
  for (const el of target instanceof HTMLElement ? [target, ...tabs] : tabs) {
    el.focus({ preventScroll: true });
    if (state.shadow.activeElement === el) break;
  }
}

export async function loadCampus(
  state: DialogState,
  campusId: string,
  signal?: AbortSignal,
) {
  const { shadow } = state;
  state.activeCampusId = campusId;
  state.zoomLevel = 1.0;
  // If another campus is selected (or the dialog closed) while this one is
  // loading, the stale result must not overwrite state nor be cached under the
  // newer campus id. Keyed on the campus id: loadCluster() bumps loadId itself,
  // so a generation token on that counter would always look stale here.
  state.loadId++;
  const stale = () =>
    state.activeCampusId !== campusId || signal?.aborted === true;
  const exits = await getCampusExits(campusId);
  if (stale()) return;
  state.campusExits = exits ?? null;
  const clusters = await buildClusters(campusId);
  if (stale()) return;
  state.clusters = clusters;
  const trigger = shadow.getElementById("campus-trigger");
  if (trigger) {
    const name = campusDisplayName(state.campusOptions, campusId);
    const flagEl = shadow.getElementById("campus-trigger-flag");
    if (flagEl) flagEl.textContent = getCampusFlag(name);
    const nameEl = shadow.getElementById("campus-trigger-name");
    if (nameEl) nameEl.textContent = name.toUpperCase();
    // the name screen readers hear followed the first campus only
    trigger.setAttribute("aria-label", t("Campus: {name}", { name }));
  }
  if (!state.clusters.some((c) => c.svg)) {
    renderNoClusterData(state, campusId);
    // keep the header in sync, otherwise the previous campus' tabs stay clickable
    rebuildHeader(state);
    return;
  }
  state.activeCluster =
    state.defaultId === "active"
      ? { id: "active", name: "Active" }
      : state.clusters.find((c) => c.id === state.defaultId) ||
        state.clusters[0] || { id: "active", name: "Active" };
  rebuildHeader(state);
  updateDefaultSelect(state);
  updateCampusTime(state);
  await loadCluster(state, state.activeCluster, signal);
  if (stale()) return;
  await loadOccupancy(state, signal);
  if (stale()) return;
  (async () => {
    const rest = state.clusters.filter(
      (c) => c.id !== state.activeCluster.id && c.svg,
    );
    for (const c of rest) {
      if (stale()) return;
      await ensureClusterData(state, c, campusId, signal);
    }
    if (!stale()) reapplyOccupancy(state);
  })();
}
