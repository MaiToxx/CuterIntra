import { render } from "lit-html";
import { CONFIG_DEFAULT, getConfig, getConfigMany } from "../../core/config.ts";
import { resolveRainbowColors } from "./rainbow-presets.ts";
import {
  findLogtimeMount,
  hideOldLogtime,
  setupScrollHandlers,
} from "./dom.ts";
import {
  renderContainer,
  renderHeaderContent,
  renderMonthCard,
  renderLoadMoreCard,
  renderYearLabel,
  renderCarouselView,
} from "./render.ts";
import { renderCompactMonthGroup, type MonthEntry, chunkMonths } from "./compact.ts";
import { renderHeatmapCard } from "./heatmap.ts";
import { getLastSeenFormatted, limit } from "./utils.ts";
import { computeRecords } from "./records.ts";
import {
  getEffectiveTheme,
  getIsLight,
  onThemeChange,
  THEMES,
} from "../../core/theme/theme-manager.ts";
import { bindTooltips } from "../../core/dom/tooltip.ts";
import { fetchOwnEvents } from "../calendar/own-events.ts";
import { t } from "../../core/i18n/i18n.ts";
import type { CalendarEvent, EventsByDate, LogtimeConfig } from "./types.ts";

// Declared in types.ts so the renderers need not import this module back.
export type { CalendarEvent, EventsByDate, LogtimeConfig } from "./types.ts";

import { AUTH_MODE, getWorkerFeatures, workerFetch } from "../../core/worker.ts";
import { sanitizeHexColor } from "../../core/security/css-sanitize.ts";
const historyCache = new Map<string, Record<string, number>>();
const fetchPromiseMap = new Map<string, Promise<void>>();

let loadMoreLogin: string | null = null;
let loadMoreBefore: string | undefined;
let loadMoreLoading = false;
let restoreScrollLeft = -1;
let skipScroll = false;
let carouselYm: string | null = null;
let viewOverflow = false;
/** The records badge is out of the header line: no room even folded. */
let recordsHidden = false;
let headerResizeObserver: ResizeObserver | null = null;

/**
 * Whether "Load older months" can get an answer for `target`. The worker
 * builds the history from the 42 API with its own 42 application: this fork's
 * worker does when its application is configured, and only for your own login
 * (it keeps nothing about students who did not ask); upstream's worker, in
 * an "oauth" build, for any profile. Without a session fetchHistoricalLogtime()
 * does not even ask. Offering the card anyway showed a spinner, then nothing.
 */
async function canLoadOlder(target: string): Promise<boolean> {
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany([
    "CLOUD_LOGIN",
    "CLOUD_TOKEN",
  ] as const);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) return false;
  if (AUTH_MODE === "oauth") return true;
  if (target.toLowerCase() !== CLOUD_LOGIN.toLowerCase()) return false;
  return (await getWorkerFeatures()).logtimeHistory === true;
}

/**
 * Arms the "Load older months" card for `login`, or disarms it with null.
 * Always assigned on a new payload: a value left over from the previous
 * profile of a client-side navigation would load (and merge) that student's
 * history into this one's calendar.
 */
function armLoadOlder(login: string | null, before: string | undefined): void {
  loadMoreLogin = login;
  loadMoreBefore = login ? before : undefined;
}

function extractLoginFromPath(): string | null {
  const m = location.pathname.match(/^\/users\/([^/]+)/);
  return m ? m[1] : null;
}

async function fetchHistoricalLogtime(
  login: string,
  before?: string,
): Promise<void> {
  if (historyCache.has(login)) return;
  if (fetchPromiseMap.has(login)) {
    await fetchPromiseMap.get(login);
    return;
  }

  const promise = (async () => {
    try {
      // one storage read instead of two serial ones
      const { CLOUD_LOGIN: cloudLogin, CLOUD_TOKEN: sessionToken } =
        await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"] as const);
      if (!cloudLogin || !sessionToken) {
        historyCache.set(login, {});
        return;
      }

      let path = `/api/v1/private/logtime/history?user=${encodeURIComponent(login)}`;
      if (before) path += `&before=${encodeURIComponent(before)}`;

      // workerFetch: a deadline, and a 401 marks the session for "Sign in again"
      const res = await workerFetch(path, {
        auth: { login: cloudLogin, token: sessionToken },
      });
      const days = (res.json as { days?: unknown } | null)?.days;
      if (res.ok && days && typeof days === "object") {
        historyCache.set(login, days as Record<string, number>);
        return;
      }
    } catch {}

    historyCache.set(login, {});
  })();

  fetchPromiseMap.set(login, promise);
  await promise;
  fetchPromiseMap.delete(login);
}

function mergeHistoryWithHook(
  hookData: Record<string, string>,
  login: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const history = historyCache.get(login);

  if (history) {
    for (const [date, secs] of Object.entries(history)) {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      merged[date] =
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  for (const [date, time] of Object.entries(hookData)) {
    merged[date] = time;
  }

  return merged;
}

/**
 * The renderer divides by the goal and the emoji value and multiplies by the
 * rate: a 0, a "" (a hub field cleared by an older build, or a backup that
 * holds one) or a string would show "Infinity%", "NaN%" and "Infinity 🌮".
 * Values are healed where they are read, so nothing stored needs a migration.
 */
const positive = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const nonNegative = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// One storage read for all logtime settings instead of fifteen serial ones.
const getConfigs = async (): Promise<LogtimeConfig> => {
  const c = await getConfigMany([
    "LOGTIME_GOAL_HOURS",
    "LOGTIME_SHOW_AVERAGE",
    "LOGTIME_SHOW_GOAL",
    "LOGTIME_SHOW_RECORDS",
    "LOGTIME_SHOW_TACOS",
    "LOGTIME_EMOJI",
    "LOGTIME_EMOJI_DIVISOR",
    "LOGTIME_EMOJI_RATE",
    "LOGTIME_SHOW_DAYS_MODE",
    "LOGTIME_CALENDAR_COLOR",
    "LOGTIME_LABELS_COLOR",
    "LOGTIME_RAINBOW_PALETTE",
    "DISABLE_ANIMATIONS",
    "LOGTIME_MAX_EARNINGS",
    "LOGTIME_CALENDAR_VIEW",
  ] as const);
  return {
    goal_hours: positive(c.LOGTIME_GOAL_HOURS, CONFIG_DEFAULT.LOGTIME_GOAL_HOURS),
    show_average: c.LOGTIME_SHOW_AVERAGE,
    show_goal: c.LOGTIME_SHOW_GOAL,
    show_records: c.LOGTIME_SHOW_RECORDS,
    show_tacos: c.LOGTIME_SHOW_TACOS,
    emoji: limit(c.LOGTIME_EMOJI),
    divisor: positive(
      c.LOGTIME_EMOJI_DIVISOR,
      CONFIG_DEFAULT.LOGTIME_EMOJI_DIVISOR,
    ),
    rate: nonNegative(c.LOGTIME_EMOJI_RATE, CONFIG_DEFAULT.LOGTIME_EMOJI_RATE),
    show_days_mode: c.LOGTIME_SHOW_DAYS_MODE,
    calendar_color: c.LOGTIME_CALENDAR_COLOR,
    labels_color: c.LOGTIME_LABELS_COLOR,
    rainbow_colors: resolveRainbowColors(c.LOGTIME_RAINBOW_PALETTE),
    disable_animations: c.DISABLE_ANIMATIONS,
    max_earnings: nonNegative(
      c.LOGTIME_MAX_EARNINGS,
      CONFIG_DEFAULT.LOGTIME_MAX_EARNINGS,
    ),
    calendar_view: c.LOGTIME_CALENDAR_VIEW,
  };
};

let isLoaded = false;
let CONFIG: LogtimeConfig;
export let lastStats: Record<string, string> | null = null;
// The Intra events last fetched for your own profile. Only the render that
// follows the events fetch is handed them; every other re-render (view
// switch, header collapse on resize, carousel arrows, published settings,
// load older) reuses these, or the day markers vanished until a reload.
let lastEvents: EventsByDate | undefined;
let currentTheme = "light";
let primaryColor = "hsl(199 89% 48%)";
let primaryContent = "hsl(0 0% 100%)";
let scrollHandlersCleanup: (() => void) | null = null;
let heatmapScrollHandler: ((e: Event) => void) | null = null;

/**
 * The browser's scroll restoration runs at load, while the widget is still
 * being mounted and scrolled to the latest month: it is paused only on the
 * page that mounts the widget, and only until that first scroll has settled.
 * It used to be switched to "manual" on every Intra page for good, so Back
 * and reload landed at the top of every long projects list or forum thread.
 */
let heldScrollRestoration: History["scrollRestoration"] | null = null;

function holdScrollRestoration(): void {
  if (!("scrollRestoration" in history) || heldScrollRestoration !== null) return;
  heldScrollRestoration = history.scrollRestoration;
  history.scrollRestoration = "manual";
}

function releaseScrollRestoration(): void {
  if (heldScrollRestoration === null) return;
  history.scrollRestoration = heldScrollRestoration;
  heldScrollRestoration = null;
}

function isOwnProfile(): boolean {
  return (
    location.hostname === "profile-v3.intra.42.fr" && location.pathname === "/"
  );
}

function groupEventsByDate(
  events: CalendarEvent[],
): Record<string, CalendarEvent[]> {
  const byDate: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    const iso = ev.begin_at.endsWith("Z") ? ev.begin_at : ev.begin_at + "Z";
    const d = new Date(iso);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(ev);
  }
  return byDate;
}

/**
 * Your Intra events by day, or null when they could not be read. The read is
 * shared with the calendar feed (calendar/own-events.ts), which uploads them
 * on its own: this widget only draws them.
 */
async function fetchEvents(): Promise<EventsByDate | null> {
  const events = await fetchOwnEvents();
  return events ? groupEventsByDate(events) : null;
}

const HEADER_OVERFLOW_TOLERANCE = 2;

export function measureHeaderOverflow(root: ShadowRoot): boolean {
  const header = root.querySelector<HTMLElement>(".lt-header");
  if (!header || header.clientWidth === 0) return false;

  const widthOf = (el: Element | null | undefined): number =>
    el?.getBoundingClientRect().width ?? 0;

  const titleWidth = widthOf(header.querySelector(".lt-title"));
  const tacosWidth = widthOf(header.querySelector(".lt-tacos-badge"));
  const joinWidth = widthOf(header.querySelector(".lt-view-join"));
  const recordsWidth = widthOf(header.querySelector(".lt-records-badge"));
  const activeWidth = widthOf(header.querySelector(".lt-active-badge"));
  // + the 6px between the records badge and the Active badge
  const gaps = 24 + (recordsWidth > 0 ? 6 : 0);
  const needed =
    titleWidth + tacosWidth + joinWidth + recordsWidth + activeWidth + gaps;
  return needed - header.clientWidth > HEADER_OVERFLOW_TOLERANCE;
}

/**
 * Whether the records badge fits beside the folded view switcher. On a phone
 * the folded line can be full already (the tacos badge, a long Active text):
 * the badge then steps aside rather than push the Active badge out of the
 * card. Only meaningful while folded: the dropdown takes no room otherwise.
 */
export function measureRecordsRoom(root: ShadowRoot): boolean {
  const header = root.querySelector<HTMLElement>(".lt-header");
  if (!header || header.clientWidth === 0) return true;

  const widthOf = (el: Element | null | undefined): number =>
    el?.getBoundingClientRect().width ?? 0;

  const recordsWidth = widthOf(header.querySelector(".lt-records-badge"));
  if (recordsWidth === 0) return true;
  const needed =
    widthOf(header.querySelector(".lt-title")) +
    widthOf(header.querySelector(".lt-tacos-badge")) +
    widthOf(header.querySelector(".lt-view-dropdown")) +
    recordsWidth +
    widthOf(header.querySelector(".lt-active-badge")) +
    24 +
    6;
  return needed - header.clientWidth <= HEADER_OVERFLOW_TOLERANCE;
}

function wireHeaderOverflow(shadowHost: HTMLElement) {
  if (headerResizeObserver) {
    headerResizeObserver.disconnect();
    headerResizeObserver = null;
  }
  const root = shadowHost.shadowRoot;
  const header = root?.querySelector<HTMLElement>(".lt-header");
  if (!root || !header) return;

  headerResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      const overflowing = measureHeaderOverflow(root);
      // The folded switcher can only be measured once drawn: on the render
      // that folds it, this observer is set up again, and its first call
      // comes back here with the dropdown on screen.
      const hideRecords =
        overflowing && viewOverflow && !measureRecordsRoom(root);
      if (overflowing === viewOverflow && hideRecords === recordsHidden) return;
      viewOverflow = overflowing;
      recordsHidden = hideRecords;
      if (lastStats) renderLogtime(lastStats);
    });
  });
  headerResizeObserver.observe(header);
}

function makeLoadOlderHandler(
  login: string,
  before: string | undefined,
  stats: Record<string, string>,
): () => Promise<void> {
  return async () => {
    loadMoreLoading = true;
    const host = document.getElementById("logtime-shadow-wrapper");
    const root = host?.shadowRoot;
    const sw = root?.querySelector(".log-slider-fixed") as HTMLElement | null;
    const hookMonth = before?.slice(0, 7);
    let anchor = hookMonth
      ? (root?.querySelector(
          `[data-month="${hookMonth}"]`,
        ) as HTMLElement | null)
      : null;
    if (anchor && !anchor.classList.contains("month-card")) {
      anchor = anchor.closest(".month-card") as HTMLElement | null;
    }
    const anchorOffset = anchor ? anchor.offsetLeft : 0;
    const savedScroll = sw ? sw.scrollLeft : 0;

    restoreScrollLeft = savedScroll;
    renderLogtime(stats);

    await fetchHistoricalLogtime(login, before);
    loadMoreLogin = null;
    loadMoreBefore = undefined;
    loadMoreLoading = false;

    const merged = mergeHistoryWithHook(stats, login);
    skipScroll = true;
    renderLogtime(merged);

    let newAnchor = root?.querySelector(
      `[data-month="${hookMonth}"]`,
    ) as HTMLElement | null;
    if (newAnchor && !newAnchor.classList.contains("month-card")) {
      newAnchor = newAnchor.closest(".month-card") as HTMLElement | null;
    }
    const shift = (newAnchor?.offsetLeft ?? anchorOffset) - anchorOffset;
    const newSw = root?.querySelector(
      ".log-slider-fixed",
    ) as HTMLElement | null;
    if (newSw) {
      requestAnimationFrame(() => {
        newSw.scrollLeft = Math.max(0, savedScroll + shift);
      });
    }
  };
}

function renderLogtime(
  stats: Record<string, string>,
  eventsByDate: EventsByDate | undefined = lastEvents,
): void {
  if (!stats || !CONFIG) return;
  lastStats = stats;
  lastEvents = eventsByDate;
  // Let other modules (tracker badge) react to the *current* stats: a plain
  // 42_LOGTIME_DATA listener would run before this assignment and read the
  // previous value.
  document.dispatchEvent(new CustomEvent("42_LOGTIME_RENDERED"));

  const byMonth: Record<string, Record<string, number>> = {};
  Object.keys(stats)
    .sort()
    .forEach((d) => {
      const ym = d.slice(0, 7);
      if (!byMonth[ym]) byMonth[ym] = {};
      const [h = 0, m = 0, s = 0] = (stats[d] || "00:00:00")
        .split(":")
        .map(Number);
      byMonth[ym][d] = h * 3600 + m * 60 + s;
    });

  const monthKeys = Object.keys(byMonth).sort();

  const loadOlder = loadMoreLogin
    ? makeLoadOlderHandler(loadMoreLogin, loadMoreBefore, stats)
    : null;

  const monthCards: ReturnType<
    | typeof renderMonthCard
    | typeof renderYearLabel
    | typeof renderCompactMonthGroup
    | typeof renderHeatmapCard
  >[] = [];

  if (CONFIG.calendar_view === "heatmap") {
    monthCards.push(renderHeatmapCard(stats, CONFIG));
  } else if (CONFIG.calendar_view === "carousel" && monthKeys.length > 0) {
    if (!carouselYm || !monthKeys.includes(carouselYm)) {
      carouselYm = monthKeys[monthKeys.length - 1];
    }
    const index = monthKeys.indexOf(carouselYm);
    const goTo = (ym: string) => {
      carouselYm = ym;
      skipScroll = true;
      renderLogtime(stats);
    };

    monthCards.push(
      renderCarouselView(
        renderMonthCard(
          carouselYm,
          byMonth[carouselYm],
          index === monthKeys.length - 1,
          CONFIG,
          eventsByDate,
        ),
        {
          canPrev: index > 0 || (!!loadOlder && !loadMoreLoading),
          canNext: index < monthKeys.length - 1,
          prevLabel: t(index > 0 ? "Previous month" : "Load older months"),
          nextLabel: t("Next month"),
          loading: loadMoreLoading && index === 0,
          onPrev: () =>
            index > 0 ? goTo(monthKeys[index - 1]) : loadOlder?.(),
          onNext: () => goTo(monthKeys[index + 1]),
        },
      ),
    );
  } else if (CONFIG.calendar_view === "compact" && monthKeys.length > 1) {
    const lastYm = monthKeys[monthKeys.length - 1];
    const pastMonthEntries: MonthEntry[] = monthKeys
      .slice(0, -1)
      .map((ym) => ({ ym, data: byMonth[ym] }));

    const sections: { year: string; months: MonthEntry[] }[] = [];
    if (pastMonthEntries.length > 0) {
      let cy = pastMonthEntries[0].ym.slice(0, 4);
      let cm: MonthEntry[] = [];
      for (const entry of pastMonthEntries) {
        const yr = entry.ym.slice(0, 4);
        if (yr !== cy) {
          sections.push({ year: cy, months: cm });
          cy = yr;
          cm = [];
        }
        cm.push(entry);
      }
      sections.push({ year: cy, months: cm });
    }

    // Build flat list of all groups with year info
    const allGroups: {
      group: MonthEntry[];
      year: string;
      isFirstInYear: boolean;
    }[] = [];
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      const groups = chunkMonths(sec.months);
      for (let gi = 0; gi < groups.length; gi++) {
        allGroups.push({
          group: groups[gi],
          year: sec.year,
          isFirstInYear: gi === 0 && si > 0,
        });
      }
    }

    // Fix trailing singleton: if last group is alone, merge with previous
    if (
      allGroups.length >= 2 &&
      allGroups[allGroups.length - 1].group.length === 1
    ) {
      const merged = [
        ...allGroups[allGroups.length - 2].group,
        ...allGroups[allGroups.length - 1].group,
      ];
      const reChunked = chunkMonths(merged);
      allGroups.splice(allGroups.length - 2, 2);
      for (const g of reChunked) {
        allGroups.push({
          group: g,
          year:
            allGroups.length > 0
              ? allGroups[allGroups.length - 1].year
              : sections[0].year,
          isFirstInYear: false,
        });
      }
    }

    // Render with year labels interspersed
    for (const g of allGroups) {
      if (g.isFirstInYear) {
        monthCards.push(renderYearLabel(g.year));
      }
      monthCards.push(renderCompactMonthGroup(g.group, CONFIG));
    }

    monthCards.push(
      renderMonthCard(lastYm, byMonth[lastYm], true, CONFIG, eventsByDate),
    );
  } else {
    let prevYear = "";
    for (const ym of monthKeys) {
      const year = ym.slice(0, 4);
      if (year !== prevYear && prevYear !== "") {
        monthCards.push(renderYearLabel(year));
      }
      prevYear = year;
      monthCards.push(
        renderMonthCard(
          ym,
          byMonth[ym],
          ym === monthKeys[monthKeys.length - 1],
          CONFIG,
          eventsByDate,
        ),
      );
    }
  }

  if (
    loadOlder &&
    monthCards.length > 0 &&
    CONFIG.calendar_view !== "carousel"
  ) {
    monthCards.unshift(renderLoadMoreCard(loadOlder, loadMoreLoading));
  }

  const lastSeenValue = getLastSeenFormatted(stats, CONFIG.show_days_mode);
  const handleViewChange = async (value: string) => {
    await chrome.storage.local.set({ LOGTIME_CALENDAR_VIEW: value });
    CONFIG.calendar_view = value;
    if (lastStats) renderLogtime(lastStats);
  };
  const header = renderHeaderContent(
    lastSeenValue,
    byMonth,
    CONFIG,
    CONFIG.calendar_view,
    handleViewChange,
    primaryColor,
    primaryContent,
    viewOverflow,
    CONFIG.show_records ? computeRecords(stats) : null,
    recordsHidden,
  );

  let shadowHost = document.getElementById("logtime-shadow-wrapper");
  if (!shadowHost) {
    shadowHost = document.createElement("div");
    shadowHost.id = "logtime-shadow-wrapper";
    const mount = findLogtimeMount();
    if (mount) mount.prepend(shadowHost);
    shadowHost.attachShadow({ mode: "open" });
  }
  if (shadowHost.shadowRoot) bindTooltips(shadowHost.shadowRoot, getIsLight);
  hideOldLogtime();

  render(
    renderContainer(header, monthCards, currentTheme, CONFIG),
    shadowHost.shadowRoot!,
  );
  wireHeaderOverflow(shadowHost);

  const scrollWrapper = shadowHost.shadowRoot!.querySelector(
    ".log-slider-fixed",
  ) as HTMLElement;
  if (scrollWrapper && CONFIG.calendar_view === "carousel") {
    if (scrollHandlersCleanup) {
      scrollHandlersCleanup();
      scrollHandlersCleanup = null;
    }
    if (heatmapScrollHandler) {
      scrollWrapper.removeEventListener("scroll", heatmapScrollHandler);
      heatmapScrollHandler = null;
    }
    // consume the one-shot scroll flags so they do not leak into the next view
    skipScroll = false;
    restoreScrollLeft = -1;
    scrollWrapper.scrollLeft = 0;
    releaseScrollRestoration();
  } else if (scrollWrapper) {
    if (scrollHandlersCleanup) {
      scrollHandlersCleanup();
      scrollHandlersCleanup = null;
    }
    scrollHandlersCleanup = setupScrollHandlers(scrollWrapper);

    if (CONFIG.calendar_view === "heatmap") {
      if (heatmapScrollHandler) {
        scrollWrapper.removeEventListener("scroll", heatmapScrollHandler);
        heatmapScrollHandler = null;
      }
      const yearLabel = shadowHost.shadowRoot!.getElementById(
        "heatmap-sticky-year",
      );
      const handleYearScroll = () => {
        const cols = shadowHost.shadowRoot!.querySelectorAll(".heatmap-column");
        const scrollLeft = scrollWrapper.scrollLeft;
        for (const col of cols) {
          const rect = (col as HTMLElement).getBoundingClientRect();
          const parentRect = scrollWrapper.getBoundingClientRect();
          if (rect.right > parentRect.left + 50) {
            const year = (col as HTMLElement).dataset.year;
            if (year && yearLabel) yearLabel.textContent = year;
            break;
          }
        }
      };
      heatmapScrollHandler = handleYearScroll;
      scrollWrapper.addEventListener("scroll", handleYearScroll, {
        passive: true,
      });
    } else if (heatmapScrollHandler) {
      // leaving the heatmap view: drop its scroll listener
      scrollWrapper.removeEventListener("scroll", heatmapScrollHandler);
      heatmapScrollHandler = null;
    }
    if (skipScroll) {
      skipScroll = false;
    } else if (restoreScrollLeft >= 0) {
      const target = restoreScrollLeft;
      restoreScrollLeft = -1;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollWrapper.scrollLeft = target;
        });
      });
    } else {
      const scrollToLatest = () => {
        scrollWrapper.scrollLeft =
          scrollWrapper.scrollWidth - scrollWrapper.clientWidth;
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(scrollToLatest);
      });
      // once the page has loaded, the "load" event will never fire again:
      // registering it on every render only accumulated dead listeners
      if (document.readyState !== "complete") {
        window.addEventListener("load", scrollToLatest, { once: true });
      }
      setTimeout(() => {
        scrollToLatest();
        releaseScrollRestoration();
      }, 100);
    }
  }
}

function isProfileV3TargetPage() {
  return (
    location.hostname === "profile-v3.intra.42.fr" &&
    (location.pathname === "/" || /^\/users\/[^/]+\/?$/.test(location.pathname))
  );
}

function installFetchHook() {
  document.addEventListener("42_LOGTIME_DATA", async (event: Event) => {
    const raw = (event as CustomEvent<Record<string, string>>).detail;
    if (!raw || typeof raw !== "object") return;

    // Keep only "YYYY-MM-DD": "HH:MM:SS" entries. An error payload such as
    // {"error": "..."} used to reach renderLogtime, throw on an invalid date
    // and poison lastStats for every later re-render.
    const detail: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === "string") detail[k] = v;
    }
    if (Object.keys(detail).length === 0) return;

    const hookDates = Object.keys(detail).sort();
    const before =
      hookDates.length > 0 ? hookDates[hookDates.length - 1] : undefined;

    if (isOwnProfile()) {
      // Signed out too: the events come from the Intra with the page's own
      // token. The cloud login only keys the history loader. Gating the whole branch on it (a leftover of the days this
      // handler also uploaded the calendar feed, which calendar-sync.ts now
      // does behind its own cloud check) hid every event and exam marker
      // from students who never signed in.
      const cloudLogin = await getConfig("CLOUD_LOGIN");
      const hasHistory = !!cloudLogin && historyCache.has(cloudLogin);
      armLoadOlder(
        cloudLogin && !hasHistory && (await canLoadOlder(cloudLogin)) ? cloudLogin : null,
        before,
      );
      renderLogtime(
        hasHistory ? mergeHistoryWithHook(detail, cloudLogin) : detail,
      );

      void fetchEvents().then((events) => {
        // A failed read is not "no events": keep what is drawn.
        if (!events) return;
        // The student may have opened another profile meanwhile: these
        // events are their own and must not land on someone else's days.
        if (isOwnProfile()) renderLogtime(lastStats || detail, events);
      });
      return;
    }

    // Your events belong on your own calendar only.
    lastEvents = undefined;

    const targetLogin = extractLoginFromPath();
    if (targetLogin) {
      const hasHistory = historyCache.has(targetLogin);
      armLoadOlder(
        !hasHistory && (await canLoadOlder(targetLogin)) ? targetLogin : null,
        before,
      );
      const stats = hasHistory
        ? mergeHistoryWithHook(detail, targetLogin)
        : detail;
      renderLogtime(stats);
      return;
    }

    armLoadOlder(null, undefined);
    renderLogtime(detail);
  });
}

type PublicLogtimeSettings = {
  calendarColor?: string;
  labelsColor?: string;
  emoji?: string;
  emojiDivisor?: string | number;
  rainbowPalette?: string;
};

/**
 * The published settings of the profile on screen: a change to your own
 * Logtime settings re-reads them, and these go back on top.
 */
let publicLogtime: PublicLogtimeSettings | null = null;

export function applyPublicLogtimeSettings(logtime: PublicLogtimeSettings) {
  if (!isLoaded || !logtime) return;
  publicLogtime = logtime;

  // These values belong to the viewed user and are interpolated into <style>
  // text: only accept plain hex colours and finite, positive numbers. The
  // value of an hour is not among them: it is the visitor's own (the worker
  // no longer publishes it, and a copy cached before that is ignored).
  const isHex = (v: unknown): v is string => sanitizeHexColor(v) !== "";

  CONFIG.calendar_color = isHex(logtime.calendarColor)
    ? logtime.calendarColor.trim()
    : CONFIG.calendar_color;
  CONFIG.labels_color = isHex(logtime.labelsColor)
    ? logtime.labelsColor.trim()
    : CONFIG.labels_color;
  CONFIG.emoji = logtime.emoji ? limit(logtime.emoji) : CONFIG.emoji;
  CONFIG.divisor =
    logtime.emojiDivisor !== undefined
      ? positive(logtime.emojiDivisor, CONFIG.divisor)
      : CONFIG.divisor;
  if (logtime.rainbowPalette !== undefined) {
    CONFIG.rainbow_colors = resolveRainbowColors(logtime.rainbowPalette);
  }

  if (lastStats) {
    renderLogtime(lastStats);
  }
}

// Memoized so that concurrent callers (main.ts and visuals.ts) share a single
// initialization: `isLoaded` is only set after many awaited storage reads, and
// a second caller during that window used to install a second data listener,
// which rendered the widget and fetched events twice.
let initPromise: Promise<void> | null = null;
let hookInstalled = false;

/** The settings the widget re-reads and applies while the page is open. */
export const LOGTIME_LIVE_KEYS: ReadonlySet<string> = new Set([
  "LOGTIME_GOAL_HOURS",
  "LOGTIME_SHOW_AVERAGE",
  "LOGTIME_SHOW_GOAL",
  "LOGTIME_SHOW_RECORDS",
  "LOGTIME_SHOW_TACOS",
  "LOGTIME_EMOJI",
  "LOGTIME_EMOJI_DIVISOR",
  "LOGTIME_EMOJI_RATE",
  "LOGTIME_SHOW_DAYS_MODE",
  "LOGTIME_CALENDAR_COLOR",
  "LOGTIME_LABELS_COLOR",
  "LOGTIME_RAINBOW_PALETTE",
  "LOGTIME_MAX_EARNINGS",
  "DISABLE_ANIMATIONS",
]);

function useTheme(theme: "dark" | "light", presetKey: string): void {
  currentTheme = theme;
  const preset = THEMES[presetKey] ?? THEMES["dark"];
  primaryColor = `hsl(${preset.primary})`;
  primaryContent = `hsl(${preset.primaryForeground})`;
}

export function initLogtime(): Promise<void> {
  if (isLoaded) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Three independent storage round-trips: awaited together, their latency
    // is paid once instead of three times before the widget can render.
    const [config, theme, presetKey] = await Promise.all([
      getConfigs(),
      getEffectiveTheme(),
      getConfig("PROFILE_THEME_PRESET"),
    ]);
    CONFIG = config;
    useTheme(theme, presetKey);
    // isLoaded stays false on non-target pages, so init can legitimately run
    // again later: never install the data listener twice.
    if (!hookInstalled) {
      installFetchHook();
      // The hub's theme toggle restyles the page live; the widget's own
      // data-theme and label colours are baked into each render.
      onThemeChange(({ theme: next, preset }) => {
        useTheme(next, preset);
        if (lastStats) renderLogtime(lastStats);
      });
      // The Logtime tab of the hub opens over the widget: its settings show at
      // once instead of after a reload. LOGTIME_CALENDAR_VIEW is left out:
      // the widget writes it itself and has already re-rendered.
      chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== "local") return;
        const keys = Object.keys(changes);
        if (!keys.some((k) => LOGTIME_LIVE_KEYS.has(k))) return;
        void getConfigs().then((next) => {
          CONFIG = next;
          if (publicLogtime && !isOwnProfile()) applyPublicLogtimeSettings(publicLogtime);
          else if (lastStats) renderLogtime(lastStats);
        });
      });
      hookInstalled = true;
    }

    if (isProfileV3TargetPage()) {
      isLoaded = true;
      holdScrollRestoration();
    }
    // The page may have fetched /locations_stats before this listener existed
    // (the hook runs at document_start, we run after DOMContentLoaded and
    // several storage reads). Ask the hook to replay the last payload.
    document.dispatchEvent(new CustomEvent("42_LOGTIME_REQUEST"));
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}
