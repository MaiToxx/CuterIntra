/**
 * "Lighten the Intra" (features/performance).
 *
 * Every other feature of Cuter Intra *adds* something to the Intra. This one
 * is the opposite: it makes the Intra's own pages cheaper for the browser.
 *
 *   1. PERF_DEFER_OFFSCREEN - the long repeated lists (project rows,
 *      achievement tiles, logtime month cards; never the evaluation rows,
 *      see PERF_NEVER_TARGETS) get
 *      `content-visibility: auto`, so the browser skips layout, style and
 *      paint for the ones that are off screen.
 *   2. PERF_PAUSE_HIDDEN - a hidden tab stops burning CPU on animations and
 *      transitions nobody can see.
 *   3. PERF_PRECONNECT - the avatar CDN connection is opened before the page
 *      asks for the first avatar, so that request does not pay DNS + TLS.
 *
 * There is no image pass any more (PERF_LAZY_IMAGES, 1.10 to 1.13). It added
 * `loading="lazy"` to the page's <img> elements once they were in the
 * document, but the browser picks lazy or eager when the request starts, which
 * is when React sets `src` on the element, before it is inserted and before
 * any MutationObserver callback. Measured in Chrome 153 and Firefox 156: every
 * image marked that way was fetched anyway. What was left was a document-wide
 * observer and a forced layout per pass. The key stays in the schema so stored
 * settings and backups remain valid; nothing reads it.
 *
 * WHY it is written this way:
 *   - the stylesheet is built from the constants in this file only. No user
 *     value ever reaches it, so there is nothing to sanitize and the output is
 *     byte-stable for a given set of flags (cheap to diff before writing).
 *   - the selectors are NOT invented: each one is the selector our own feature
 *     code already relies on, and each TARGET says which file it comes from.
 *     If the Intra renames a class our features break first and loudly; this
 *     stylesheet then simply matches nothing, which is the safe failure.
 *   - nothing is applied above the fold (header, name, avatar): a wrong
 *     `contain-intrinsic-size` there would make the page jump on load.
 *   - every browser API used here is feature-detected. A missing one costs the
 *     optimisation, never the page.
 */
import { getConfigMany, type BetterIntraConfig } from "../../core/config.ts";
import { waitForElement } from "../../core/dom/dom-wait.ts";

/** The three settings of the "Lighten the Intra" block, in one storage read. */
export const PERF_KEYS = [
  "PERF_DEFER_OFFSCREEN",
  "PERF_PAUSE_HIDDEN",
  "PERF_PRECONNECT",
] as const;

export type PerfFlags = Pick<BetterIntraConfig, (typeof PERF_KEYS)[number]>;

/** Namespaced so it can never collide with a class of the Intra or of Tailwind. */
export const HIDDEN_CLASS = "ft-perf-hidden";
/** id of the <style> element in <head>. */
export const PERF_STYLE_ID = "better-intra-perf";
/** Marks the <link> elements we own, so turning the setting off removes ours only. */
const PRECONNECT_ATTR = "data-ft-perf-preconnect";

/**
 * A block of the Intra that repeats enough to be worth deferring.
 *
 * `size` is the guessed block size in px used until the browser has measured
 * the element once (`contain-intrinsic-size: auto <len>` then remembers the
 * real one). Guessing low is the safe direction here: every target below lives
 * inside a card that is `md:h-96` (a fixed 24rem box with its own scrollbar),
 * so a wrong guess moves the card's scrollbar, never the page.
 */
export type PerfTarget = {
  readonly selector: string;
  readonly size: number;
  /** Which of our own files this selector is taken from, and why it is safe. */
  readonly why: string;
};

/**
 * Card-internal targets. Gated on `min-width: 768px` (Tailwind's `md`) because
 * below that breakpoint `md:h-96` does not apply: the cards grow with their
 * content and a wrong intrinsic size would move the rest of the page.
 */
export const PERF_TARGETS: readonly PerfTarget[] = [
  {
    // src/features/profile/cards/projects-sort.ts extractItems()
    selector: ".flex.flex-row.justify-between.hover\\:bg-gray-300.p-2",
    size: 32,
    why: "Intra's own Marks/Projects rows: one per finished project, 60+ on an old account.",
  },
  {
    // src/features/profile/cards/marks.ts injectFinishedProjects()
    selector: "#ft-marks-injected .flex.flex-row.justify-between.hover\\:bg-gray-300",
    size: 26,
    why: "Our finished-projects list: the longest list on the dashboard.",
  },
  {
    // src/features/profile/cards/achievements.ts renderList() (h-24 tiles)
    selector: "#ft-achievements-injected .grid > div",
    size: 96,
    why: "Our achievement tiles; they carry an explicit h-24 so the guess cannot be wrong.",
  },
  {
    // src/features/profile/cards/achievements.ts findCard() + customize/cards.ts tagging
    selector: '[data-ft-card="achievements"] .grid > div',
    size: 96,
    why: "The Intra's own achievement grid, addressed through our data-ft-card tag.",
  },
];

/**
 * Blocks that must NEVER be deferred, and why. Kept as data so a test can
 * make sure they stay out of PERF_TARGETS.
 *
 * The pending-evaluation rows were a target until 1.12.1. The Intra renders
 * the date-and-time tooltip of each row's clock button INSIDE the row (no
 * portal to <body>), as a position:fixed box. content-visibility: auto
 * implies layout and paint containment, which makes the row the containing
 * block of that box (it lands 200 px below the row) and clips it to the
 * row's bounds: the tooltip never showed. Checked in Chrome on the live
 * dashboard; the same holds for any Intra tooltip rendered inline.
 */
export const PERF_NEVER_TARGETS: readonly { selector: string; why: string }[] = [
  {
    selector: '[data-ft-card="evaluations"] .flex.justify-between.w-full.items-center',
    why: "Each row hosts its own inline position:fixed tooltip; containment clips it.",
  },
];

/**
 * Targets that live inside a shadow root of ours, which a document stylesheet
 * cannot reach. Applied with adoptedStyleSheets instead (see adoptShadowCss).
 */
export const PERF_SHADOW_TARGETS: readonly PerfTarget[] = [
  {
    // src/features/logtime/logtime.css: .month-card is width:280px flex-shrink:0
    selector: ".month-card",
    size: 320,
    why: "Logtime month cards: ~35 day cells each, most of them scrolled off to the side. Their width is fixed in CSS, so the horizontal scroller cannot resize.",
  },
];

/** The only image origin of the Intra we can confirm from our own code. */
export const PRECONNECT_ORIGINS = ["https://cdn.intra.42.fr"] as const;

/* ------------------------------------------------------------------ CSS -- */

/**
 * The document stylesheet. Deterministic: same flags in, same text out, so
 * applyPerfStyle() can skip the DOM write when nothing changed.
 */
export function buildPerfCss(flags: Partial<PerfFlags>): string {
  const out: string[] = [];

  if (flags.PERF_DEFER_OFFSCREEN) {
    const rules = PERF_TARGETS.map(
      (t) =>
        `  ${t.selector} {\n` +
        `    content-visibility: auto;\n` +
        // Two declarations on purpose: the plain one is the fallback for
        // engines that do not know the `auto` form, which would otherwise drop
        // the whole declaration and leave the block with a zero intrinsic size.
        `    contain-intrinsic-size: ${t.size}px;\n` +
        `    contain-intrinsic-size: auto ${t.size}px;\n` +
        `  }`,
    ).join("\n");
    // @supports so Firefox < 125 (no content-visibility) skips the block
    // entirely instead of applying a bare contain-intrinsic-size.
    out.push(
      "@supports (content-visibility: auto) {\n" +
        "  @media (min-width: 768px) {\n" +
        rules.replace(/^/gm, "  ") +
        "\n  }\n}",
    );
  }

  if (flags.PERF_PAUSE_HIDDEN) {
    // Only ever active while the tab is hidden, so the universal selector
    // costs one style recalc on visibilitychange and nothing afterwards.
    out.push(
      `html.${HIDDEN_CLASS} body,\n` +
        `html.${HIDDEN_CLASS} body *,\n` +
        `html.${HIDDEN_CLASS} body *::before,\n` +
        `html.${HIDDEN_CLASS} body *::after {\n` +
        "  animation-play-state: paused !important;\n" +
        "  transition: none !important;\n" +
        "}",
    );
  }

  return out.join("\n\n");
}

/** The same rules for the shadow roots a document stylesheet cannot reach. */
export function buildShadowPerfCss(flags: Partial<PerfFlags>): string {
  if (!flags.PERF_DEFER_OFFSCREEN) return "";
  const rules = PERF_SHADOW_TARGETS.map(
    (t) =>
      `  ${t.selector} {\n` +
      `    content-visibility: auto;\n` +
      `    contain-intrinsic-size: ${t.size}px;\n` +
      `    contain-intrinsic-size: auto ${t.size}px;\n` +
      `  }`,
  ).join("\n");
  return `@supports (content-visibility: auto) {\n${rules}\n}`;
}

/** Write (or remove) the <style> element, only when its text actually changed. */
function applyPerfStyle(css: string): void {
  let el = document.getElementById(PERF_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    // document_start: <head> may not be parsed yet, <html> always is
    const host = document.head || document.documentElement;
    if (!host) return;
    el = document.createElement("style");
    el.id = PERF_STYLE_ID;
    host.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/* --------------------------------------------------- logtime shadow root -- */

const SHADOW_HOST_ID = "logtime-shadow-wrapper";
/** Same budget as the old 20 x 500 ms poll. */
const SHADOW_WAIT_MS = 10000;

let shadowSheet: CSSStyleSheet | null = null;
/** Bumped on every call: a pending wait from an earlier settings state is stale. */
let shadowGen = 0;

/**
 * Adopt the shadow rules into the logtime widget once it exists.
 *
 * adoptedStyleSheets rather than a <style> child: logtime re-renders its
 * shadow root with lit on every view change, and an adopted sheet is the only
 * way to add CSS there without ever touching the nodes lit manages.
 * The widget only ever mounts on the profile origin (logtime.ts), so the other
 * Intra hosts do not even look for it: the old 500 ms poll woke 20 times on
 * every page without a logtime widget. Unsupported engine, missing widget or a
 * logtime the user turned off: the wait lapses and the page is simply not
 * optimised.
 */
function adoptShadowCss(css: string): void {
  const gen = ++shadowGen;
  if (typeof CSSStyleSheet !== "function") return;

  if (shadowSheet) {
    // The setting can be flipped while the page is open: rewriting the sheet
    // in place adds or removes the rules without re-adopting anything.
    try {
      shadowSheet.replaceSync(css);
    } catch {
      return;
    }
  } else {
    if (!css) return; // nothing to install, and nothing installed yet
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadowSheet = sheet;
    } catch {
      return; // no constructable stylesheets: skip this optimisation
    }
  }
  if (!css) return; // emptied in place; no need to hunt for the widget
  if (location.hostname !== "profile-v3.intra.42.fr") return;

  void waitForElement<HTMLElement>(`#${SHADOW_HOST_ID}`, {
    timeoutMs: SHADOW_WAIT_MS,
  }).then((host) => {
    if (gen !== shadowGen || !host || !shadowSheet) return;
    // The host is inserted before logtime attaches its shadow root: that
    // happens in the same task, so it is there by this microtask.
    const root = host.shadowRoot;
    if (!root) return;
    const current = root.adoptedStyleSheets;
    if (current && !current.includes(shadowSheet)) {
      try {
        root.adoptedStyleSheets = [...current, shadowSheet];
      } catch {
        /* read-only in this engine: give up quietly */
      }
    }
  });
}

/* ------------------------------------------------------------ preconnect -- */

/**
 * Open the connection to the avatar CDN before the page asks for an avatar.
 *
 * Two preconnects per origin on purpose: a plain <img src> uses the browser's
 * credentialed socket pool while a fetch() (our achievement icons, the friends
 * widget) uses the anonymous one, and a preconnect only warms the pool that
 * matches its `crossorigin`. dns-prefetch is the fallback for engines that
 * ignore preconnect. Three tiny link elements, no bytes downloaded.
 */
export function applyPreconnect(enabled: boolean): void {
  const existing = document.querySelectorAll(`link[${PRECONNECT_ATTR}]`);
  if (!enabled) {
    existing.forEach((l) => l.remove());
    return;
  }
  if (existing.length > 0) return;

  const head = document.head || document.documentElement;
  if (!head) return;

  const HINTS: readonly { rel: string; anonymous: boolean }[] = [
    { rel: "preconnect", anonymous: false }, // <img src> (credentialed pool)
    { rel: "preconnect", anonymous: true }, // fetch()/CORS (anonymous pool)
    { rel: "dns-prefetch", anonymous: false }, // fallback
  ];

  for (const origin of PRECONNECT_ORIGINS) {
    // The Intra may already warm this origin itself; do not duplicate it.
    if (document.querySelector(`link[rel="preconnect"][href^="${origin}"]`)) {
      continue;
    }
    for (const hint of HINTS) {
      const link = document.createElement("link");
      link.rel = hint.rel;
      link.href = origin;
      if (hint.anonymous) link.crossOrigin = "anonymous";
      link.setAttribute(PRECONNECT_ATTR, "1");
      head.appendChild(link);
    }
  }
}

/* ----------------------------------------------------------- hidden tab -- */

export function setHiddenClass(hidden: boolean): void {
  document.documentElement?.classList.toggle(HIDDEN_CLASS, hidden);
}

let visibilityHandler: (() => void) | null = null;

function applyHiddenTab(enabled: boolean): void {
  if (enabled) {
    if (visibilityHandler) return;
    visibilityHandler = () =>
      setHiddenClass(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", visibilityHandler);
    visibilityHandler();
    return;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  setHiddenClass(false);
}

/* ------------------------------------------------------------------ init -- */

/** The content script is declared for *.intra.42.fr only; belt and braces. */
function isIntraPage(): boolean {
  const h = location.hostname;
  return h === "intra.42.fr" || h.endsWith(".intra.42.fr");
}

let stylesWired = false;

/**
 * Styles, preconnect and the hidden-tab listener. Called at document_start so
 * the rules are in place before the React app paints.
 */
export async function initPerfStyles(): Promise<void> {
  if (!isIntraPage()) return;

  const apply = async () => {
    const flags = await getConfigMany(PERF_KEYS);
    applyPerfStyle(buildPerfCss(flags));
    adoptShadowCss(buildShadowPerfCss(flags));
    applyPreconnect(flags.PERF_PRECONNECT === true);
    applyHiddenTab(flags.PERF_PAUSE_HIDDEN === true);
  };

  await apply();

  if (stylesWired) return;
  stylesWired = true;
  // Same contract as initCustomize(): flipping a switch in the hub takes
  // effect on the open tabs without a reload.
  chrome?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (PERF_KEYS.some((k) => k in changes)) void apply();
  });
}

/** Undo the listener and the pending shadow-root wait. Used by the tests. */
export function stopPerformance(): void {
  // A pending host wait resolves to nothing (dom-wait stops on pagehide).
  shadowGen++;
  applyHiddenTab(false);
}
