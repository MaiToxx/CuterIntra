/**
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as perf from "../src/features/performance/perf";
import {
  HIDDEN_CLASS,
  PERF_KEYS,
  PERF_SHADOW_TARGETS,
  PERF_STYLE_ID,
  PERF_TARGETS,
  PERF_NEVER_TARGETS,
  PRECONNECT_ORIGINS,
  applyPreconnect,
  buildPerfCss,
  buildShadowPerfCss,
  initPerfStyles,
  setHiddenClass,
  stopPerformance,
  type PerfFlags,
} from "../src/features/performance/perf";
import { CONFIG_DEFAULT } from "../src/core/config";
import { ADVANCED_SETTINGS } from "../src/features/hub/settings/advanced";

const ALL_OFF: PerfFlags = {
  PERF_DEFER_OFFSCREEN: false,
  PERF_PAUSE_HIDDEN: false,
  PERF_PRECONNECT: false,
};
const ALL_ON: PerfFlags = {
  PERF_DEFER_OFFSCREEN: true,
  PERF_PAUSE_HIDDEN: true,
  PERF_PRECONNECT: true,
};

function setStore(values: Partial<PerfFlags>) {
  return chrome.storage.local.set(values as Record<string, unknown>);
}

beforeEach(async () => {
  await chrome.storage.local.clear();
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.classList.remove(HIDDEN_CLASS);
});

afterEach(() => {
  stopPerformance();
  vi.unstubAllGlobals();
});

describe("the three settings exist", () => {
  it("are declared with a default of on", () => {
    for (const key of PERF_KEYS) {
      expect(CONFIG_DEFAULT[key]).toBe(true);
    }
  });

  it("are exactly the switches the hub offers under Lighten the Intra", () => {
    // "Load images when needed" promised deferred downloads that never
    // happened (loading=lazy set after React set src): it must not come back
    // as a switch that does nothing.
    const offered = ADVANCED_SETTINGS.map((d) => d.key).filter((k) => k?.startsWith("PERF_"));
    expect(offered.sort()).toEqual([...PERF_KEYS].sort());
    expect(offered).not.toContain("PERF_LAZY_IMAGES");
  });
});

describe("buildPerfCss", () => {
  it("emits nothing when every setting is off", () => {
    expect(buildPerfCss(ALL_OFF)).toBe("");
    expect(buildShadowPerfCss(ALL_OFF)).toBe("");
  });

  it("emits the deferral rules only for PERF_DEFER_OFFSCREEN", () => {
    const css = buildPerfCss({ ...ALL_OFF, PERF_DEFER_OFFSCREEN: true });
    expect(css).toContain("@supports (content-visibility: auto)");
    // Firefox < 125 has no content-visibility, and below Tailwind's md the
    // cards are not height-capped, so both guards must be there.
    expect(css).toContain("@media (min-width: 768px)");
    for (const target of PERF_TARGETS) {
      expect(css).toContain(target.selector);
      expect(css).toContain(`contain-intrinsic-size: ${target.size}px;`);
      expect(css).toContain(`contain-intrinsic-size: auto ${target.size}px;`);
    }
    expect(css).not.toContain(HIDDEN_CLASS);
  });

  it("never defers a block that hosts an inline position:fixed tooltip", () => {
    // The pending-evaluation rows render their date-and-time tooltip inside
    // the row; content-visibility would make the row its containing block
    // and clip it (1.12.0 regression, seen on the live dashboard).
    const css = buildPerfCss({ ...ALL_OFF, PERF_DEFER_OFFSCREEN: true });
    for (const never of PERF_NEVER_TARGETS) {
      expect(css).not.toContain(never.selector);
      expect(PERF_TARGETS.some((t) => t.selector === never.selector)).toBe(false);
    }
    expect(css).not.toContain("evaluations");
  });

  it("emits the hidden-tab rule only for PERF_PAUSE_HIDDEN", () => {
    const css = buildPerfCss({ ...ALL_OFF, PERF_PAUSE_HIDDEN: true });
    expect(css).toContain(`html.${HIDDEN_CLASS} body *`);
    expect(css).toContain("animation-play-state: paused !important;");
    expect(css).toContain("transition: none !important;");
    expect(css).not.toContain("content-visibility");
  });

  it("emits the shadow rules only for PERF_DEFER_OFFSCREEN", () => {
    const css = buildShadowPerfCss({ ...ALL_OFF, PERF_DEFER_OFFSCREEN: true });
    for (const target of PERF_SHADOW_TARGETS) {
      expect(css).toContain(target.selector);
    }
    expect(buildShadowPerfCss({ ...ALL_ON, PERF_DEFER_OFFSCREEN: false })).toBe("");
  });

  it("is stable: same input, same text", () => {
    expect(buildPerfCss(ALL_ON)).toBe(buildPerfCss(ALL_ON));
    expect(buildShadowPerfCss(ALL_ON)).toBe(buildShadowPerfCss(ALL_ON));
    // built from constants only: nothing a user can type may appear in it
    expect(buildPerfCss(ALL_ON)).not.toMatch(/undefined|NaN|\[object/);
  });

  it("never targets the profile header, the name or the avatar", () => {
    const css = buildPerfCss(ALL_ON) + buildShadowPerfCss(ALL_ON);
    // AVATAR_SELECTOR / BANNER_SELECTOR / BACKGROUND_SELECTOR of
    // features/profile/selectors.ts must stay out of the deferral rules.
    for (const above of ["rounded-full", "w-52", "h-52", "bg-ft-black", "bg-ft-gray", "header", "h1"]) {
      expect(css).not.toContain(above);
    }
  });
});

describe("preconnect", () => {
  it("adds the hints once and removes only its own", () => {
    const foreign = document.createElement("link");
    foreign.rel = "preconnect";
    foreign.href = "https://example.com";
    document.head.appendChild(foreign);

    applyPreconnect(true);
    const mine = document.head.querySelectorAll("link[data-ft-perf-preconnect]");
    expect(mine.length).toBe(3 * PRECONNECT_ORIGINS.length);
    expect(document.head.querySelector('link[rel="preconnect"][crossorigin]')).not.toBeNull();
    expect(document.head.querySelector('link[rel="dns-prefetch"]')).not.toBeNull();
    for (const link of mine) {
      expect((link as HTMLLinkElement).href).toContain("cdn.intra.42.fr");
    }

    applyPreconnect(true); // idempotent
    expect(document.head.querySelectorAll("link[data-ft-perf-preconnect]").length).toBe(3);

    applyPreconnect(false);
    expect(document.head.querySelectorAll("link[data-ft-perf-preconnect]").length).toBe(0);
    expect(document.head.contains(foreign)).toBe(true);
  });

  it("does not duplicate a hint the Intra already has", () => {
    const own = document.createElement("link");
    own.rel = "preconnect";
    own.href = PRECONNECT_ORIGINS[0];
    document.head.appendChild(own);
    applyPreconnect(true);
    expect(document.head.querySelectorAll("link[data-ft-perf-preconnect]").length).toBe(0);
  });
});

describe("hidden tab", () => {
  it("toggles the namespaced class on <html>", () => {
    setHiddenClass(true);
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(true);
    setHiddenClass(false);
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(false);
  });

  it("follows visibilitychange once initialised", async () => {
    await setStore(ALL_ON);
    await initPerfStyles();
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(false);

    const hide = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    hide("hidden");
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(true);
    hide("visible");
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(false);
  });
});

describe("init", () => {
  it("installs the stylesheet and the hints when everything is on", async () => {
    await setStore(ALL_ON);

    await initPerfStyles();

    const style = document.getElementById(PERF_STYLE_ID);
    expect(style?.textContent).toContain("content-visibility: auto");
    expect(document.head.querySelectorAll("link[data-ft-perf-preconnect]").length).toBe(3);
  });

  it("is a complete no-op when the three settings are off", async () => {
    await setStore(ALL_OFF);

    await initPerfStyles();

    expect(document.getElementById(PERF_STYLE_ID)).toBeNull();
    expect(document.head.querySelectorAll("link[data-ft-perf-preconnect]").length).toBe(0);
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(false);
  });

  it("leaves the page's images alone, even with the old image switch still stored on", async () => {
    // Every start-up entry point the module exports, as main.ts would call
    // them, with a store written by 1.13 (PERF_LAZY_IMAGES: true).
    await chrome.storage.local.set({ ...ALL_ON, PERF_LAZY_IMAGES: true });
    const early = document.createElement("img");
    early.src = "https://cdn.intra.42.fr/users/early.jpg";
    document.body.appendChild(early);

    for (const [name, fn] of Object.entries(perf)) {
      if (name.startsWith("init") && typeof fn === "function") await (fn as () => unknown)();
    }
    const late = document.createElement("img");
    late.src = "https://cdn.intra.42.fr/users/late.jpg";
    document.body.appendChild(late);
    // longer than the old idle pass (requestIdleCallback timeout 500 ms,
    // setTimeout 100 ms without it)
    await new Promise((r) => setTimeout(r, 150));

    for (const img of [early, late]) {
      expect(img.hasAttribute("loading")).toBe(false);
      expect(img.hasAttribute("decoding")).toBe(false);
      expect(img.hasAttribute("data-ft-perf")).toBe(false);
    }
  });

  it("stopPerformance clears the hidden class", async () => {
    await setStore(ALL_ON);
    await initPerfStyles();
    setHiddenClass(true);

    stopPerformance();
    expect(document.documentElement.classList.contains(HIDDEN_CLASS)).toBe(false);
  });
});

/**
 * A page the size of a real Intra dashboard, to put numbers on the feature.
 *
 * jsdom has no layout and no paint, so what is MEASURED here is only the reach
 * of the content-visibility rules: how many elements they cover. The rendering
 * saving that number buys is reasoned about in the report, not measured here.
 */
describe("benchmark on an Intra-sized page", () => {
  it("reports how much of the page the feature reaches", () => {
    // 400 list rows, built with the classes our own features already read.
    // Each row carries the handful of children a real one has (link, date,
    // score, star span), because what the browser saves is proportional to the
    // nodes inside the deferred block, not to the number of blocks.
    const CHILDREN_PER_ROW = 6;
    const mk = (parent: Element, n: number, cls: string) => {
      for (let i = 0; i < n; i++) {
        const row = document.createElement("div");
        row.className = cls;
        for (let c = 0; c < CHILDREN_PER_ROW; c++) {
          const child = document.createElement("span");
          child.textContent = `cell ${c}`;
          row.appendChild(child);
        }
        parent.appendChild(row);
      }
    };
    const marks = document.createElement("div");
    marks.id = "ft-marks-injected";
    mk(marks, 150, "flex flex-row justify-between hover:bg-gray-300 py-1 px-2");
    const native = document.createElement("div");
    mk(native, 100, "flex flex-row justify-between hover:bg-gray-300 p-2");
    const achievements = document.createElement("div");
    achievements.dataset.ftCard = "achievements";
    const grid = document.createElement("div");
    grid.className = "grid";
    achievements.appendChild(grid);
    mk(grid, 100, "w-full h-24");
    const evals = document.createElement("div");
    evals.dataset.ftCard = "evaluations";
    mk(evals, 50, "flex justify-between w-full items-center");
    document.body.append(marks, native, achievements, evals);

    // ---- measure ----
    // A deferred block costs the browser nothing while it is off screen, so
    // the useful number is the DOM weight inside the covered blocks, not the
    // number of blocks.
    const totalNodes = document.body.querySelectorAll("*").length;
    let covered = 0;
    let coveredNodes = 0;
    const perTarget: Record<string, string> = {};
    for (const t of PERF_TARGETS) {
      const hits = document.querySelectorAll(t.selector);
      let nodes = 0;
      for (const el of hits) nodes += 1 + el.querySelectorAll("*").length;
      perTarget[t.selector] = `${String(hits.length).padStart(3)} blocks / ${String(nodes).padStart(4)} nodes`;
      covered += hits.length;
      coveredNodes += nodes;
    }
    const pct = ((coveredNodes / totalNodes) * 100).toFixed(1);

    console.log(
      [
        "",
        "  Cuter Intra - Lighten the Intra, synthetic jsdom page",
        "  ---------------------------------------------------------------",
        `  list rows on the page ......... ${covered}`,
        `  elements in <body> ............ ${totalNodes}`,
        `  inside a deferred block ....... ${coveredNodes}  (${pct}% of the page)`,
        ...Object.entries(perTarget).map(([sel, n]) => `      ${n}  ${sel}`),
        "  measured: reach of the deferral rules. Not measured: paint and layout",
        "  time - jsdom has neither.",
        "",
      ].join("\n"),
    );

    // 150 + 100 + 100: the 50 evaluation rows are on purpose left out
    expect(covered).toBe(350);
    // the rows are the bulk of the page: that is the point of the feature
    expect(coveredNodes / totalNodes).toBeGreaterThan(0.6);
  });
});

