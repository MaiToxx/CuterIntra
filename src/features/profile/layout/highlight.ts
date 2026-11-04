import { CLUSTERS, ensureCampusData } from "../../clusters/clusters.data.ts";
import { openClusterDialog } from "../../clusters/map-dialog.ts";
import { normalizeSeatId } from "../../clusters/map-dialog/seats.ts";
import { getConfig } from "../../../core/config.ts";
import { watchDom } from "../../../core/dom/dom-wait.ts";
import { css } from "../../../core/dom/css.ts";

/** The unique ID for the injected stylesheet. */
const GLOW_STYLE_ID = "ft-glow-styles";
/** The CSS class applied to a highlighted seat. */
const GLOWING_CLASS = "ft-glowing-seat";
/** A data attribute to mark an element as highlighted. */
const HIGHLIGHT_ATTR = "data-highlighted";
/** The URL query parameter used to specify a seat to highlight. */
const SEAT_PARAM = "seat";
/** The path for the cluster map pages. */
const CLUSTERS_PATH = "/clusters";
/** The scale factor to apply to a highlighted seat. */
const HIGHLIGHT_SCALE = 1.4;
/**
 * How long a freshly loaded map gets to render the requested seat: the old
 * loop checked 31 times, 500 ms apart.
 */
const SEAT_WAIT_MS = 15_500;

/** Stops the watcher started by the last checkRouteAndHighlight(). */
let stopSeatWatch: (() => void) | null = null;

/**
 * Set once a seat is highlighted on this page. Until then there is nothing to
 * clear, so the check that follows every click on every Intra page skips its
 * scan of the whole document.
 */
let highlightApplied = false;

/**
 * Injects the CSS styles for the seat highlight animation into the document head.
 * The styles are only injected once.
 */
function injectHighlightStyles() {
  if (document.getElementById(GLOW_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = GLOW_STYLE_ID;
  style.textContent = css`
    @keyframes ft-pulsate {
      0%, 100% {
        filter: drop-shadow(0 0 2px #ff0055) drop-shadow(0 0 5px #ff0055);
      }
      50% {
        filter: drop-shadow(0 0 8px #ff0055) drop-shadow(0 0 15px #ff0055);
      }
    }
    .${GLOWING_CLASS} {
      animation: ft-pulsate 2s infinite ease-in-out !important;
    }
    /* Without motion the seat still glows, at the pulse's brightest. */
    @media (prefers-reduced-motion: reduce) {
      .${GLOWING_CLASS} {
        animation: none !important;
        filter: drop-shadow(0 0 8px #ff0055) drop-shadow(0 0 15px #ff0055) !important;
      }
    }
    html.ft-glow-still .${GLOWING_CLASS} {
      animation: none !important;
      filter: drop-shadow(0 0 8px #ff0055) drop-shadow(0 0 15px #ff0055) !important;
    }
  `;
  const target = document.head || document.documentElement;
  target.appendChild(style);
  void getConfig("DISABLE_ANIMATIONS").then((disabled) => {
    if (disabled) document.documentElement.classList.add("ft-glow-still");
  });
}

/**
 * Finds and removes all active highlight effects from any seat on the page.
 */
function clearExistingHighlight() {
  if (!highlightApplied) return;
  document.querySelectorAll(`[${HIGHLIGHT_ATTR}='true']`).forEach((el) => {
    el.removeAttribute(HIGHLIGHT_ATTR);
    el.removeAttribute("transform");
    el.classList.remove(GLOWING_CLASS);
  });
}

/**
 * Retrieves the SVG elements corresponding to a given seat identifier.
 * Matches regardless of campus seat-id formatting (dashes vs concatenated).
 * @param seatId The seat identifier (e.g., "e1r1p1", "shi-r5-p6", "c1r17s2").
 * @returns An array of matching SVG elements.
 */
function getSeatElements(seatId: string): SVGGraphicsElement[] {
  // seatId comes from the URL: escape it or a quote makes querySelectorAll throw
  const exact = document.querySelectorAll<SVGGraphicsElement>(
    `[id="${CSS.escape(seatId)}"]`,
  );
  if (exact.length > 0) return Array.from(exact);

  const key = normalizeSeatId(seatId);
  const matches: SVGGraphicsElement[] = [];
  for (const el of document.querySelectorAll<SVGGraphicsElement>("[id]")) {
    if (normalizeSeatId(el.getAttribute("id") || "") === key) {
      matches.push(el);
    }
  }
  return matches;
}

/**
 * Reads the 'seat' URL parameter and applies the highlight effect to the corresponding seat.
 * If no parameter is found, it clears any existing highlight.
 */
export function highlightSeatFromURL() {
  const urlParams = new URLSearchParams(window.location.search);
  const targetSeat = urlParams.get(SEAT_PARAM)?.toLowerCase();

  if (!targetSeat) {
    clearExistingHighlight();
    return;
  }

  const elements = getSeatElements(targetSeat);
  if (elements.length === 0) return;

  const firstEl = elements[0];
  if (firstEl.classList.contains(GLOWING_CLASS)) return;

  clearExistingHighlight();

  const x = parseFloat(firstEl.getAttribute("x") || "0");
  const y = parseFloat(firstEl.getAttribute("y") || "0");
  const w = parseFloat(firstEl.getAttribute("width") || "30");
  const h = parseFloat(firstEl.getAttribute("height") || "30");

  const transX = (x + w / 2) * (1 - HIGHLIGHT_SCALE);
  const transY = (y + h / 2) * (1 - HIGHLIGHT_SCALE);
  const transformString = `translate(${transX}, ${transY}) scale(${HIGHLIGHT_SCALE})`;

  highlightApplied = true;
  elements.forEach((el) => {
    el.setAttribute(HIGHLIGHT_ATTR, "true");
    el.setAttribute("transform", transformString);
    el.classList.add(GLOWING_CLASS);
    el.parentNode?.appendChild(el); // Bring to front
  });

  setTimeout(() => {
    firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 200);
}

/**
 * Removes the 'seat' parameter from the URL in the browser's history.
 */
function cleanUrlParam() {
  const url = new URL(window.location.href);
  if (url.searchParams.has(SEAT_PARAM)) {
    url.searchParams.delete(SEAT_PARAM);
    window.history.replaceState({}, document.title, url.toString());
    // Without the parameter the seat watcher has nothing left to look for:
    // its next check would stop it anyway.
    stopSeatWatch?.();
  }
}

/**
 * Checks if the current page is a cluster map and triggers the highlight logic.
 * The map's seats are rendered later: the check runs again on every DOM burst
 * until the seat is there, the parameter is gone, or SEAT_WAIT_MS has passed
 * (it used to poll every 500 ms, whether anything had changed or not).
 */
function checkRouteAndHighlight() {
  if (!window.location.pathname.includes(CLUSTERS_PATH)) {
    clearExistingHighlight();
    return;
  }

  highlightSeatFromURL();

  // One watcher at a time: a second one would only repeat the same checks.
  stopSeatWatch?.();
  stopSeatWatch = watchDom(
    () => {
      const urlParams = new URLSearchParams(window.location.search);
      const targetSeat = urlParams.get(SEAT_PARAM)?.toLowerCase();
      if (!targetSeat) return true;

      try {
        if (getSeatElements(targetSeat).length > 0) {
          highlightSeatFromURL();
          return true;
        }
      } catch (err) {
        // never let a bad seat id keep this watcher alive
        console.warn("Cuter Intra: could not highlight seat", err);
        return true;
      }
      return false;
    },
    { timeoutMs: SEAT_WAIT_MS },
  );
}

/** A WeakSet to keep track of labels that have already been processed. */
const processedLabels = new WeakSet<HTMLElement>();

const isSeatLike = (t: string) =>
  !!t &&
  t !== "unavailable" &&
  (CLUSTERS.some((c) => c.name && t.startsWith(c.name.toLowerCase())) ||
    /^[a-z0-9]+-\w+/.test(t));

/**
 * Intercepts clicks on the profile seat badge (and any link to the native
 * clusters page carrying a `?seat=` param) and opens the cluster map dialog
 * instead, preventing the default new-tab navigation.
 */
let seatClickGuardInstalled = false;
function installSeatClickGuard() {
  if (seatClickGuardInstalled) return;
  seatClickGuardInstalled = true;

  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const path = e.composedPath();
      for (const node of path) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.classList.contains("value")) {
          const t = node.textContent?.trim().toLowerCase() || "";
          if (isSeatLike(t)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            openClusterDialog({ seatId: t });
            return;
          }
        }

        if (node.tagName === "A") {
          const href = (node as HTMLAnchorElement).href || "";
          if (href.includes("/clusters") && href.includes("seat=")) {
            try {
              const seat = new URLSearchParams(new URL(href).search).get("seat");
              if (seat) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openClusterDialog({ seatId: seat.toLowerCase() });
                return;
              }
            } catch {}
          }
        }
      }
    },
    true,
  );
}

/**
 * Enhances the user profile page by making the seat location label a clickable
 * link that opens the cluster map dialog on the matching cluster.
 */
export async function handleProfileRedirect() {
  const label =
    Array.from(document.querySelectorAll<HTMLElement>(".value")).find((el) =>
      isSeatLike(el.textContent?.trim().toLowerCase() || ""),
    ) ||
    document.querySelector<HTMLElement>(
      ".absolute.px-2.py-1.border.rounded-full.border-neutral-600.bg-ft-gray.top-2.right-4",
    );

  if (!label || processedLabels.has(label)) return;

  const seatText = label.textContent?.trim().toLowerCase();
  if (!seatText || seatText === "unavailable") return;

  processedLabels.add(label);

  const onLabelClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openClusterDialog({ seatId: seatText });
  };

  label.style.cursor = "pointer";
  label.addEventListener("mouseenter", () => {
    label.style.textDecoration = "underline";
  });
  label.addEventListener("mouseleave", () => {
    label.style.textDecoration = "";
  });
  label.addEventListener("click", onLabelClick);
}

/**
 * Initializes all features related to seat highlighting and profile redirection.
 * Sets up event listeners to handle navigation and dynamic content.
 */
async function init() {
  // ensureCampusData() loads a known campus only. getClusterData() with the
  // empty id of a campus not detected yet probed every campus file and loaded
  // the first one (Paris) into the shared list, on every Intra page: the
  // cluster pickers then offered Paris's clusters, and the detection handler
  // and ensureCampusData(), seeing a list, never loaded the real campus.
  try {
    await ensureCampusData();
  } catch {}

  injectHighlightStyles();
  installSeatClickGuard();

  if (
    window.location.pathname.includes(CLUSTERS_PATH) &&
    window.location.search.includes(`${SEAT_PARAM}=`)
  ) {
    setTimeout(cleanUrlParam, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkRouteAndHighlight);
  } else {
    checkRouteAndHighlight();
  }

  window.addEventListener("popstate", checkRouteAndHighlight);
  window.addEventListener("hashchange", checkRouteAndHighlight);
  document.addEventListener(
    "click",
    () => setTimeout(checkRouteAndHighlight, 100),
    true,
  );
}

void init();
