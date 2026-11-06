/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The last polling timers of the content script, measured.
 *
 * For every timer changed in this round, the number of timer wake-ups over
 * 60 s of a visible tab and of a hidden one, before and after:
 *   - "before" runs a replica of the old loop, copied from the code it
 *     replaced; "after" runs the real module code;
 *   - "hidden" hides the tab right after the set-up, on raw fake timers;
 *     "hidden, throttled" keeps the tab hidden from the start and applies
 *     what browsers do there: no timer more often than once a second, no
 *     animation frames at all. That column is the realistic one.
 * A wake-up is one timer callback (setTimeout, setInterval or animation
 * frame) firing. The table is printed at the end of the run and every row is
 * asserted, so a regression shows up as a failing test.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { tickWhileVisible, watchDom } from "../src/core/dom/dom-wait.ts";
import type { DialogState } from "../src/features/clusters/map-dialog/context.ts";
import { EXTRAS_IDENTITY_ID } from "../src/features/profile/extras/extras.ts";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const WINDOW_MS = 60_000;

let hidden = false;
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => (hidden ? "hidden" : "visible"),
});
Object.defineProperty(document, "hidden", {
  configurable: true,
  get: () => hidden,
});
function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

// Modules subscribe to storage.onChanged; the shared mock has no such thing.
(chrome.storage as { onChanged?: unknown }).onChanged ??= {
  addListener: () => {},
  removeListener: () => {},
};

/** Timer callbacks run since the last countWakeups() started. */
let fired = 0;

/**
 * jsdom queues the `storage` event of every Web Storage write through
 * setTimeout; a browser wakes no timer in the writing page for it.
 */
const isJsdomStorageEvent = () => /Storage-impl/.test(new Error().stack ?? "");

/**
 * Fake clock whose setTimeout / setInterval / requestAnimationFrame count
 * every callback they run (window === globalThis in this environment, so
 * `window.setTimeout` is covered too). vi.useRealTimers() puts the real
 * functions back.
 */
function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>;
  const counted = (fn: unknown) =>
    typeof fn === "function" && !isJsdomStorageEvent()
      ? (...args: unknown[]) => {
          fired++;
          return (fn as (...a: unknown[]) => unknown)(...args);
        }
      : fn;
  const throttling = () => throttleHidden && hidden;
  for (const name of ["setTimeout", "setInterval"]) {
    const fake = g[name];
    g[name] = (fn: unknown, delay?: unknown, ...rest: unknown[]) =>
      fake(
        counted(fn),
        throttling() ? Math.max(Number(delay) || 0, 1000) : delay,
        ...rest,
      );
  }
  const fakeFrame = g.requestAnimationFrame;
  g.requestAnimationFrame = (fn: unknown) =>
    throttling() ? 0 : fakeFrame(counted(fn));
}

/** Model a background tab's timer throttling (see useFakeClock). */
let throttleHidden = false;

/**
 * Advance `ms` of fake time and return how many timer callbacks ran - the
 * wake-ups. Timers due at exactly the end of the window count. Microtasks
 * (observer callbacks, awaited promises) run between timers.
 */
async function countWakeups(ms = WINDOW_MS): Promise<number> {
  fired = 0;
  await vi.advanceTimersByTimeAsync(ms);
  return fired;
}

/** Let observer callbacks and promise chains settle. */
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

interface Counts {
  visible: number;
  hidden: number;
  throttled: number;
}
interface Row {
  timer: string;
  before: Counts;
  after: Counts;
}
const rows: Row[] = [];
function report(timer: string, before: Counts, after: Counts): void {
  rows.push({ timer, before, after });
}

afterAll(() => {
  const pad = (v: string | number, n: number) => String(v).padStart(n);
  const lines = [
    "",
    "Timer wake-ups over 60 s (before -> after)",
    `${"timer".padEnd(34)}${pad("visible", 16)}${pad("hidden", 16)}${pad("hidden, throttled", 22)}`,
  ];
  const zero = (): Counts => ({ visible: 0, hidden: 0, throttled: 0 });
  const total: Row = { timer: "TOTAL", before: zero(), after: zero() };
  const line = (r: Row) =>
    `${r.timer.padEnd(34)}${(["visible", "hidden", "throttled"] as const)
      .map((k, i) => pad(`${r.before[k]} -> ${r.after[k]}`, i === 2 ? 22 : 16))
      .join("")}`;
  for (const r of rows) {
    lines.push(line(r));
    for (const k of ["visible", "hidden", "throttled"] as const) {
      total.before[k] += r.before[k];
      total.after[k] += r.after[k];
    }
  }
  lines.push(line(total));
  console.log(lines.join("\n"));
});

beforeEach(async () => {
  hidden = false;
  await (chrome.storage.local.clear as () => Promise<void>)();
  document.body.replaceChildren();
  document.head.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState({}, "", "/");
});

afterEach(() => {
  // Stop whatever a test left running, the way leaving the page would.
  window.dispatchEvent(new Event("pagehide"));
  hidden = false;
  throttleHidden = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../src/core/config.ts");
  vi.doUnmock("../src/features/account/account.ts");
  vi.doUnmock("../src/core/crypto.ts");
  vi.resetModules();
});

/**
 * Run `scenario` twice - tab visible for the whole window, then tab hidden
 * right after the set-up - and count the wake-ups of each run.
 */
async function measure(
  setup: () => Promise<void> | void,
  { mountVisible = false } = {},
): Promise<Counts> {
  const out: Counts = { visible: 0, hidden: 0, throttled: 0 };
  for (const mode of ["visible", "hidden", "throttled"] as const) {
    useFakeClock();
    throttleHidden = mode === "throttled";
    // mountVisible: the feature only mounts in a visible tab (it waits on
    // animation frames), so the throttled run mounts it, then hides the tab.
    hidden = mode === "throttled" && !mountVisible;
    document.body.replaceChildren();
    await setup();
    if (mode === "hidden" || (mode === "throttled" && mountVisible)) {
      setHidden(true);
    }
    out[mode] = await countWakeups();
    window.dispatchEvent(new Event("pagehide"));
    hidden = false;
    throttleHidden = false;
    vi.useRealTimers();
    vi.resetModules();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Replicas of the old loops (copied from the code they replaced)      */
/* ------------------------------------------------------------------ */

const old = {
  /** highlight.ts checkRouteAndHighlight(): 500 ms, 31 checks. */
  seatPoll(seatPresent: () => boolean) {
    let attempts = 0;
    const interval = setInterval(() => {
      const targetSeat = new URLSearchParams(location.search).get("seat");
      if (!targetSeat || attempts++ > 30) {
        clearInterval(interval);
        return;
      }
      if (seatPresent()) clearInterval(interval);
    }, 500);
  },

  /** freeze.ts / roulette-stats.ts: a 1 s countdown, forever. */
  countdown(update: () => void) {
    setInterval(update, 1000);
  },

  /** freeze.ts waitForProfileCard(): 60 animation frames. */
  profileCardFrames(): Promise<Element | null> {
    return new Promise((resolve) => {
      let attempts = 0;
      const poll = () => {
        const card = document.querySelector("#never-there")?.firstElementChild;
        if (card) return resolve(card);
        if (++attempts > 60) return resolve(null);
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  },

  /** account.ts loginWith42(): 500 ms until the auth window closes. */
  loginPoll(popup: { closed: boolean }) {
    const poll = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(poll);
    }, 500);
  },

  /** extras-apply.ts watchNavigation(): 1.5 s, for as long as extras show. */
  extrasNavigation(appliedPath: string) {
    setInterval(() => {
      if (location.pathname !== appliedPath) {
        /* clearProfileExtras() */
      }
    }, 1500);
  },

  /** eggs.ts checkTimeAndDay(): 500 ms, 31 tries. */
  thursdayTitle() {
    let tries = 0;
    const timer = setInterval(() => {
      const title = document.querySelector('[data-ft-card="roulette"] [class*="uppercase"]');
      if (title) clearInterval(timer);
      if (++tries > 30) clearInterval(timer);
    }, 500);
  },

  /** eggs.ts checkFortyTwoHours(): 500 ms, 41 tries. */
  fortyTwoBadge() {
    let tries = 0;
    const timer = setInterval(() => {
      const root = document.getElementById("logtime-shadow-wrapper")?.shadowRoot;
      const badges = root ? Array.from(root.querySelectorAll(".badge")) : [];
      if (badges.some((b) => /^\s*42h00\b/.test(b.textContent ?? ""))) clearInterval(timer);
      if (++tries > 40) clearInterval(timer);
    }, 500);
  },

  /** eggs.ts matrixRain(): canvas removed after 7 s, 45 ms frames. */
  matrixRain() {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    setTimeout(() => canvas.remove(), 7000);
    const timer = setInterval(() => {
      if (!canvas.isConnected) clearInterval(timer);
    }, 45);
  },

  /** map-dialog.ts: occupancy poll, campus clock, countdown badge. */
  mapDialog() {
    setInterval(() => {}, 60_000);
    setInterval(() => {}, 30_000);
    setInterval(() => {}, 1000);
  },
};

/** Measure a replica the same three ways. */
async function measureOld(start: () => unknown): Promise<Counts> {
  const out: Counts = { visible: 0, hidden: 0, throttled: 0 };
  for (const mode of ["visible", "hidden", "throttled"] as const) {
    useFakeClock();
    throttleHidden = mode === "throttled";
    hidden = mode === "throttled";
    document.body.replaceChildren();
    void start();
    if (mode === "hidden") setHidden(true);
    out[mode] = await countWakeups();
    vi.clearAllTimers();
    hidden = false;
    throttleHidden = false;
    vi.useRealTimers();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The helper itself                                                   */
/* ------------------------------------------------------------------ */

describe("tickWhileVisible", () => {
  it("ticks like setInterval while visible, not at all while hidden", async () => {
    useFakeClock();
    const tick = vi.fn();
    const stop = tickWhileVisible(tick, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(5);

    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(5);

    // Back in view: redrawn at once, then the normal cadence.
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(9);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a poll's phase: back in view, it only fetches if one fell due", async () => {
    useFakeClock();
    const tick = vi.fn();
    const stop = tickWhileVisible(tick, 60_000, { resyncOnVisible: false });
    await vi.advanceTimersByTimeAsync(20_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(false);
    expect(tick).not.toHaveBeenCalled(); // 30 s since the last fetch
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1); // at 60 s, as before

    setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000);
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(2); // overdue: fetched right away
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not start in a background tab until the tab is shown", async () => {
    useFakeClock();
    hidden = true;
    const tick = vi.fn();
    const stop = tickWhileVisible(tick, 1000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops once its element has left the DOM, or when the tick says so", async () => {
    useFakeClock();
    const el = document.createElement("span");
    document.body.appendChild(el);
    const tick = vi.fn();
    tickWhileVisible(tick, 1000, { element: el });
    await vi.advanceTimersByTimeAsync(2000);
    el.remove();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    let n = 0;
    tickWhileVisible(() => ++n === 3, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer on pagehide and resumes after a bfcache restore", async () => {
    useFakeClock();
    const tick = vi.fn();
    const stop = tickWhileVisible(tick, 1000);
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);

    const show = new Event("pageshow") as Event & { persisted?: boolean };
    Object.defineProperty(show, "persisted", { value: true });
    window.dispatchEvent(show);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("watchDom can report text changes and tell when it stops", async () => {
    useFakeClock();
    const text = document.createTextNode("41h59");
    document.body.appendChild(text);
    const seen = vi.fn(() => false);
    const onStop = vi.fn();
    const stop = watchDom(seen, {
      root: document.body,
      immediate: false,
      characterData: true,
      timeoutMs: 1000,
      onStop,
    });
    text.data = "42h00";
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onStop).toHaveBeenCalledTimes(1);
    stop();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Countdowns and clocks                                               */
/* ------------------------------------------------------------------ */

describe("milestone ring", () => {
  /** milestones.ts: --angle written on every animation frame while connected. */
  function oldRing(current: HTMLElement) {
    let angle = 0;
    function animate() {
      if (!current.isConnected) return;
      angle = (angle + 2.4) % 360;
      current.style.setProperty("--angle", `${angle}deg`);
      requestAnimationFrame(animate);
    }
    animate();
  }

  const mountMilestone = () => {
    const el = document.createElement("div");
    el.className = "bg-legacy-main-muted h-10";
    el.dataset.state = "current";
    document.body.appendChild(el);
    return el;
  };

  it("turns in CSS, without a script wake-up per frame", async () => {
    const before = await measureOld(() => oldRing(mountMilestone()));
    const after = await measure(async () => {
      const el = mountMilestone();
      const { initMilestones } = await import("../src/features/profile/cards/milestones.ts");
      initMilestones();
      expect(el.classList.contains("fire-animated")).toBe(true);
      const css = document.getElementById("fire-milestone-style")!.textContent!;
      // the ring is a keyframe on a registered property, stoppable by the
      // motion settings, not an inline --angle
      expect(el.style.getPropertyValue("--angle")).toBe("");
      expect(css).toMatch(/@property --angle \{[^}]*syntax: "<angle>"/);
      expect(css).toMatch(/\.fire-animated::before \{[^}]*animation: ft-fire-spin 2\.5s linear infinite/);
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.fire-animated::before \{ animation: none; \}/);
      expect(css).toContain("html.ft-fire-still .fire-animated::before { animation: none; }");
    });
    report("milestones: ring angle", before, after);
    // one callback per frame at the fake clock's 16 ms: 3750 over 60 s
    expect(before.visible).toBeGreaterThanOrEqual(3600);
    expect(after).toEqual({ visible: 0, hidden: 0, throttled: 0 });
  });

  it("also polls no more when the dashboard has no milestone", async () => {
    const after = await measure(async () => {
      const { initMilestones } = await import("../src/features/profile/cards/milestones.ts");
      initMilestones();
    });
    // the 300-frame retry is gone: the profile pass re-runs initMilestones
    expect(after).toEqual({ visible: 0, hidden: 0, throttled: 0 });
  });
});

describe("freeze card", () => {
  const mountRow = () => {
    const row = document.createElement("div");
    row.className = "flex flex-col lg:flex-row gap-6 md:gap-8";
    const card = document.createElement("div");
    card.id = "profile-card";
    row.appendChild(card);
    document.body.appendChild(row);
  };

  async function startFreezeCard() {
    history.replaceState({}, "", "/users/bob");
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    sessionStorage.setItem("ft_intrapy_token", "token");
    await chrome.storage.local.set({ FREEZE_CACHE: JSON.stringify({ bob: until }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [{ freeze_until: until }] })),
    );
    mountRow();
    const { initFreezeCard } = await import("../src/features/profile/cards/freeze.ts");
    await initFreezeCard();
    await flush();
    expect(document.getElementById("ft-freeze-card")).not.toBeNull();
  }

  it("countdown: 1 s while visible, asleep while hidden", async () => {
    const before = await measureOld(() => old.countdown(() => {}));
    const after = await measure(startFreezeCard);
    report("freeze: countdown (1 s)", before, after);
    expect(before).toEqual({ visible: 60, hidden: 60, throttled: 60 });
    expect(after).toEqual({ visible: 60, hidden: 0, throttled: 0 });
  });

  it("countdown: right again on the first frame back, gone with the card", async () => {
    useFakeClock();
    await startFreezeCard();
    const seconds = () => {
      const host = Array.from(
        document.getElementById("ft-freeze-card")!.querySelectorAll("span"),
      ).find((el) => el.shadowRoot);
      return host!.shadowRoot!.querySelectorAll(".countdown > span")[3].textContent;
    };
    setHidden(true);
    const shown = seconds();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seconds()).toBe(shown); // nothing painted in the background
    setHidden(false);
    expect(seconds()).not.toBe(shown); // resynchronised immediately

    document.getElementById("ft-freeze-card")!.remove();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("profile card wait: observer and one deadline instead of 60 frames", async () => {
    // Element absent: the worst case, where each wait runs to its end. A
    // freeze card waits twice (cached draw, then the confirmed one).
    const before = await measureOld(async () => {
      await old.profileCardFrames();
      await old.profileCardFrames();
    });
    const after = await measure(async () => {
      history.replaceState({}, "", "/users/bob");
      sessionStorage.setItem("ft_intrapy_token", "token");
      const until = new Date(Date.now() + 86400000).toISOString();
      await chrome.storage.local.set({ FREEZE_CACHE: JSON.stringify({ bob: until }) });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => [{ freeze_until: until }] })),
      );
      const { initFreezeCard } = await import("../src/features/profile/cards/freeze.ts");
      void initFreezeCard(); // no profile row: both waits run to their deadline
    });
    report("freeze: profile card wait (x2)", before, after);
    // Animation frames do not run in a background tab: there the old wait
    // cost nothing, it simply never finished until the tab was shown.
    expect(before).toEqual({ visible: 122, hidden: 122, throttled: 0 });
    expect(after).toEqual({ visible: 2, hidden: 2, throttled: 2 });
  });
});

describe("roulette card", () => {
  async function startRouletteCard() {
    vi.doMock("../src/core/config.ts", () => ({
      getConfig: vi.fn(async (key: string) =>
        key === "PROFILE_SHOW_ROULETTE" || key === "PROFILE_SHOW_ROULETTE_HISTORY"
          ? true
          : "token",
      ),
    }));
    vi.doMock("../src/features/account/account.ts", () => ({
      getCloudLogin: vi.fn(async () => "me"),
    }));
    vi.doMock("../src/core/crypto.ts", () => ({
      hashLogin: vi.fn(async () => "hashed"),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ roulette: { entries: [] }, evalStats: null }),
      })),
    );
    const grid = document.createElement("div");
    grid.className = "dash-main";
    const intraCard = document.createElement("div");
    intraCard.className = "bg-white md:h-96";
    grid.appendChild(intraCard);
    document.body.appendChild(grid);

    const { initRouletteStats } = await import(
      "../src/features/profile/cards/roulette-stats.ts"
    );
    await initRouletteStats();
    await vi.advanceTimersByTimeAsync(100); // the grid wait and the worker answer
    expect(document.getElementById("ft-roulette-countdown")).not.toBeNull();
  }

  it("countdown: stops ticking in a hidden tab", async () => {
    const before = await measureOld(() => old.countdown(() => {}));
    const after = await measure(startRouletteCard, { mountVisible: true });
    report("roulette: countdown (1 s)", before, after);
    expect(before).toEqual({ visible: 60, hidden: 60, throttled: 60 });
    expect(after).toEqual({ visible: 60, hidden: 0, throttled: 0 });
  });
});

describe("cluster map dialog", () => {
  async function dialogState(): Promise<DialogState> {
    const { ACTIVE_SORT_DEFAULT } = await import(
      "../src/features/clusters/map-dialog/render.ts"
    );
    const dialog = document.createElement("dialog");
    const host = document.createElement("div");
    dialog.appendChild(host);
    document.body.appendChild(dialog);
    const shadow = host.attachShadow({ mode: "open" });
    for (const id of ["updated-badge", "badge-text", "campus-time", "campus-time-text"]) {
      const el = document.createElement("span");
      el.id = id;
      shadow.appendChild(el);
    }
    return {
      shadow,
      dialog,
      tabsState: { wired: new WeakSet(), overflowing: false, resizeObserver: null },
      timers: { poll: null, clock: null, countdown: null },
      campusOptions: [{ id: "1", name: "Paris", timezone: "Europe/Paris" }],
      activeCampusId: "1",
      detectedCampus: "1",
      currentTheme: "dark",
      clusters: [],
      activeCluster: { id: "e1", name: "E1" },
      defaultId: "e1",
      campusExits: null,
      zoomLevel: 1,
      defaultZoomLevel: 1,
      showMarkers: false,
      seatPosCache: new Map(),
      svgViewBoxes: new Map(),
      parsedDocs: new Map(),
      loadId: 0,
      retryCount: 0,
      lastUpdated: Date.now(),
      occupancyCache: null,
      wifiUsers: [],
      seatedUsers: [],
      activeUsers: [],
      flashingSeat: null,
      activeSortMode: ACTIVE_SORT_DEFAULT.mode,
      activeNameDir: ACTIVE_SORT_DEFAULT.nameDir,
      activeSinceDir: ACTIVE_SORT_DEFAULT.sinceDir,
      activeWifiOnly: false,
    };
  }

  let fetches = 0;
  async function openDialogTimers(): Promise<DialogState> {
    fetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetches++;
        return { ok: true, json: async () => ({}) };
      }),
    );
    const state = await dialogState();
    const occupancy = await import("../src/features/clusters/map-dialog/occupancy.ts");
    const header = await import("../src/features/clusters/map-dialog/header.ts");
    // What openClusterDialog() starts once the first occupancy is painted.
    occupancy.applyOccupancy(state, new Map());
    occupancy.startOccupancyPoll(state, new AbortController().signal);
    header.startCampusClock(state);
    await vi.advanceTimersByTimeAsync(20); // the tabs-overflow frame
    return state;
  }

  it("poll, clock and countdown: open and visible only", async () => {
    const before = await measureOld(() => old.mapDialog());
    const after = await measure(async () => {
      await openDialogTimers();
    });
    report("map: poll + clock + countdown", before, after);
    // 1 poll + 2 clock + 60 countdown ticks a minute
    expect(before).toEqual({ visible: 63, hidden: 63, throttled: 63 });
    expect(after).toEqual({ visible: 63, hidden: 0, throttled: 0 });
  });

  it("the poll fetches every minute while visible, never while hidden", async () => {
    useFakeClock();
    await openDialogTimers();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetches).toBe(3);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetches).toBe(3);
    setHidden(false); // long overdue: one request right away
    await flush();
    expect(fetches).toBe(4);
  });

  it("everything stops with the dialog", async () => {
    useFakeClock();
    const state = await openDialogTimers();
    const { stopCountdown } = await import("../src/features/clusters/map-dialog/occupancy.ts");
    // A dialog removed without its close handler still takes its timers along.
    state.dialog.remove();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    stopCountdown(state);
  });
});

/* ------------------------------------------------------------------ */
/* Waiting for an element                                              */
/* ------------------------------------------------------------------ */

describe("seat highlight", () => {
  // highlight.ts installs window listeners when it is first evaluated: load
  // it once for the file, or every fresh copy would answer the popstate too.
  let loaded: Promise<void> | null = null;
  const loadHighlight = () =>
    (loaded ??= (async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
      await import("../src/features/profile/layout/highlight.ts");
      // init() awaits the campus data (which fails here) before listening.
      for (let i = 0; i < 100 && !document.getElementById("ft-glow-styles"); i++) {
        await flush();
      }
      expect(document.getElementById("ft-glow-styles")).not.toBeNull();
    })());

  async function startSeatWatch() {
    await loadHighlight();
    // A navigation to a seat link: the seat never renders (the worst case).
    history.replaceState({}, "", "/clusters?seat=zz9");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  it("waits on the DOM, not on a 500 ms poll", async () => {
    const before = await measureOld(() => {
      history.replaceState({}, "", "/clusters?seat=zz9");
      old.seatPoll(() => false);
    });
    const after = await measure(startSeatWatch);
    report("highlight: seat wait", before, after);
    expect(before).toEqual({ visible: 32, hidden: 32, throttled: 32 });
    expect(after).toEqual({ visible: 1, hidden: 1, throttled: 1 }); // the deadline
  });

  it("highlights the seat on the mutation that renders it", async () => {
    useFakeClock();
    // jsdom has no scrollIntoView; highlightSeatFromURL() calls it after 200 ms.
    Element.prototype.scrollIntoView ??= () => {};
    await startSeatWatch();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const seat = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    seat.id = "zz9";
    svg.appendChild(seat);
    document.body.appendChild(svg);
    await flush();
    expect(seat.classList.contains("ft-glowing-seat")).toBe(true);
    await vi.advanceTimersByTimeAsync(300); // the scrollIntoView delay
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("easter eggs", () => {
  async function startEggs(day: string) {
    vi.setSystemTime(new Date(`${day}T12:00:00`));
    history.replaceState({}, "", "/");
    const { initEasterEggs } = await import("../src/features/eggs/eggs.ts");
    await initEasterEggs();
    await flush();
  }

  it("42h badge: observers and one deadline", async () => {
    const before = await measureOld(() => old.fortyTwoBadge());
    // A Monday: only the 42h check runs.
    const after = await measure(() => startEggs("2026-09-21"));
    report("eggs: 42h badge wait", before, after);
    expect(before).toEqual({ visible: 41, hidden: 41, throttled: 41 });
    expect(after).toEqual({ visible: 1, hidden: 1, throttled: 1 });
  });

  it("Thursday title: waitForElement and one deadline", async () => {
    const before = await measureOld(() => old.thursdayTitle());
    // A Thursday runs both checks: subtract the 42h deadline measured above.
    const both = await measure(() => startEggs("2026-09-24"));
    const after = {
      visible: both.visible - 1,
      hidden: both.hidden - 1,
      throttled: both.throttled - 1,
    };
    report("eggs: Thursday title wait", before, after);
    expect(before).toEqual({ visible: 31, hidden: 31, throttled: 31 });
    expect(after).toEqual({ visible: 1, hidden: 1, throttled: 1 });
  });

  it("finds the 42h badge when lit updates its text in place", async () => {
    useFakeClock();
    // The hit throws confetti; jsdom has no 2D context (and says so loudly).
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const host = document.createElement("div");
    host.id = "logtime-shadow-wrapper";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const badge = document.createElement("span");
    badge.className = "badge";
    const text = document.createTextNode("41h59");
    badge.appendChild(text);
    root.appendChild(badge);

    await startEggs("2026-09-21");
    expect(localStorage.getItem("ft-egg-42")).toBeNull();
    text.data = "42h00"; // characterData only, no childList record
    await flush(10);
    expect(localStorage.getItem("ft-egg-42")).toBe("2026-09");
  });

  it("tags the roulette title on a Thursday", async () => {
    useFakeClock();
    await startEggs("2026-09-24");
    const card = document.createElement("div");
    card.dataset.ftCard = "roulette";
    const title = document.createElement("div");
    title.className = "font-bold uppercase text-sm";
    title.textContent = "Thursday Roulette";
    card.appendChild(title);
    document.body.appendChild(card);
    await flush(10);
    expect(title.textContent).toBe("🎰 Thursday Roulette");
    expect(localStorage.getItem("ft-egg-thursday")).toBe("2026-09-24");
  });

  it("matrix rain: 45 ms frames while visible, none while hidden", async () => {
    const ctx = {
      fillRect: () => {},
      fillText: () => {},
      set fillStyle(_v: string) {},
      set font(_v: string) {},
    };
    const before = await measureOld(() => old.matrixRain());
    const after = await measure(async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D,
      );
      const { matrixRain } = await import("../src/features/eggs/eggs.ts");
      matrixRain(7);
    });
    report("eggs: matrix rain (7 s)", before, after);
    // 156 frames + the canvas removal, before and after, while visible;
    // hidden, only the removal is left.
    expect(before).toEqual({ visible: 157, hidden: 157, throttled: 8 });
    expect(after).toEqual({ visible: 157, hidden: 1, throttled: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Navigation watcher and login poll                                   */
/* ------------------------------------------------------------------ */

describe("profile extras navigation watcher", () => {
  const raw = { PROFILE_PUB_BIO: "I like C" };

  async function applyExtras() {
    history.replaceState({}, "", "/users/someone");
    const card = document.createElement("div");
    card.className = "ft-profile-card";
    const name = document.createElement("h2");
    name.className = "text-2xl";
    name.textContent = "Some One";
    const login = document.createElement("p");
    login.setAttribute("class", "text-sm");
    login.textContent = "someone";
    card.append(name, login);
    document.body.appendChild(card);
    const mod = await import("../src/features/profile/extras/extras-apply.ts");
    await mod.applyProfileExtras(raw, { login: "someone", own: false });
    await flush();
    expect(document.getElementById(EXTRAS_IDENTITY_ID)).not.toBeNull();
    return mod;
  }

  it("costs nothing while the profile stays open", async () => {
    const before = await measureOld(() => {
      history.replaceState({}, "", "/users/someone");
      old.extrasNavigation("/users/someone");
    });
    const after = await measure(async () => {
      await applyExtras();
    });
    report("extras: navigation watcher", before, after);
    expect(before).toEqual({ visible: 40, hidden: 40, throttled: 40 });
    expect(after).toEqual({ visible: 0, hidden: 0, throttled: 0 });
  });

  it("clears the extras on the first DOM change after a route change", async () => {
    useFakeClock();
    await applyExtras();
    history.pushState({}, "", "/projects");
    document.body.appendChild(document.createElement("main")); // React renders the new route
    await flush();
    expect(document.getElementById(EXTRAS_IDENTITY_ID)).toBeNull();
  });

  it("clears the extras on back/forward", async () => {
    useFakeClock();
    await applyExtras();
    history.replaceState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(document.getElementById(EXTRAS_IDENTITY_ID)).toBeNull();
  });
});

describe("OAuth login poll", () => {
  // The poll belongs to the dormant "oauth" mode; tests default to "intra".
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/core/worker.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
      return { ...actual, AUTH_MODE: "oauth" };
    });
  });
  afterEach(() => {
    vi.doUnmock("../src/core/worker.ts");
  });

  async function startLogin(popup: { closed: boolean; close: () => void }) {
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { loginWith42 } = await import("../src/features/account/account.ts");
    await loginWith42(async () => {});
  }

  it("lasts no longer than the auth flow may", async () => {
    const popup = { closed: false, close: () => {} };
    const before = await measureOld(() => old.loginPoll(popup));
    const after = await measure(() => startLogin({ closed: false, close: () => {} }));
    report("account: OAuth window poll", before, after);
    // Unchanged over one minute: the window can close at any moment and
    // there is no event for it. The difference is the end of the story:
    expect(before).toEqual({ visible: 120, hidden: 120, throttled: 60 });
    expect(after).toEqual({ visible: 120, hidden: 120, throttled: 60 });

    // ...a window left open for 20 minutes: the old poll never stopped.
    useFakeClock();
    old.loginPoll({ closed: false });
    const oldLong = await countWakeups(20 * 60_000);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    useFakeClock();
    await startLogin({ closed: false, close: () => {} });
    const newLong = await countWakeups(20 * 60_000);
    expect(oldLong).toBe(2400);
    // 10 minutes of polling, then the deadline (due together with the last
    // poll: whichever of the two runs first, the count is 1200 or 1201).
    expect(newLong).toBeGreaterThanOrEqual(1200);
    expect(newLong).toBeLessThanOrEqual(1201);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears on close, on success and on pagehide", async () => {
    useFakeClock();
    const popup = { closed: false, close: () => {} };
    await startLogin(popup);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);

    vi.resetModules();
    const onSuccess = vi.fn();
    const second = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(second as unknown as Window);
    const { loginWith42 } = await import("../src/features/account/account.ts");
    await loginWith42(onSuccess);
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://profile-v3.intra.42.fr",
        data: { type: "42_AUTH_SUCCESS", token: "t0k3n-abcdef", login: "me" },
      }),
    );
    expect(vi.getTimerCount()).toBe(0); // cleared before the storage write
    second.closed = true; // the window closing meanwhile must not log in twice
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalled();

    await loginWith42(async () => {});
    expect(vi.getTimerCount()).toBe(2); // the poll and the deadline
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
  });
});
