/**
 * Correction statistics and Thursday Roulette history without the 42 API
 * ("intra" auth mode).
 *
 * The upstream worker computes them from api.intra.42.fr with the user's
 * OAuth token. On a self-hosted worker without a 42 application, the same
 * information is available on two Intra v2 pages the user can already open:
 *   https://projects.intra.42.fr/users/{login}/feedbacks?as=corrector
 *     "Feedbacks you made": one li.scaleteam-list-item per evaluation done,
 *     with the scheduled date and the final mark in percent.
 *   https://profile.intra.42.fr/users/{login}/correction_point_historics
 *     .changelog-item entries with the points delta, the running total, the
 *     date and the reason (roulette entries say "Roulette").
 * The pages are fetched by the background script (cross-origin, with the
 * Intra cookies) and parsed here; the result matches the worker's shape.
 */

export interface RouletteEntryLike {
  historic_id: number;
  sum: number;
  total: number;
  created_at: string;
}

export interface EvalStatsLike {
  byMonth: Record<
    string,
    { total: number; failed: number; successPercentage: number | null }
  >;
  global: { total: number; failed: number; successPercentage: number | null };
}

export interface CorrectorFeedback {
  /** "YYYY-MM" of the scheduled date */
  month: string;
  finalMark: number | null;
  positive: boolean;
}

export const FETCH_INTRA_PAGE_MESSAGE = "FT_FETCH_INTRA_PAGE";
/**
 * Feedback pages read at most. Past it the stats are reported as unknown
 * rather than as a total too low (see fetchProfileStatsViaIntra).
 */
export const MAX_FEEDBACK_PAGES = 40;
/**
 * Feedback pages in flight at once after the first. Every page is a full v2
 * Intra document; three at a time cuts a long history from tens of serial
 * round trips to a few, without hammering the slow v2.
 */
export const FEEDBACK_PAGE_CONCURRENCY = 3;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  // the profile pages may be localised in French
  janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10,
  décembre: 11, decembre: 11,
};

/**
 * "September 13, 2026 14:30" / "Septembre 13, 2026 19:15" -> "2026-09".
 * The French locale also writes the day first: "13 septembre 2026 14:30".
 */
export function monthKeyFromText(text: string): string | null {
  let monthName: string | undefined;
  let year: string | undefined;
  const en = /([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (en) {
    monthName = en[1];
    year = en[3];
  } else {
    const fr = /(?:^|[^\d])(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/.exec(text);
    if (!fr) return null;
    monthName = fr[2];
    year = fr[3];
  }
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function parseCorrectorFeedbacks(html: string): CorrectorFeedback[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: CorrectorFeedback[] = [];
  for (const li of doc.querySelectorAll("li.scaleteam-list-item")) {
    const header = li.querySelector(".header");
    const dateText = header
      ? [...header.querySelectorAll(":scope > b")]
          .map((b) => b.textContent || "")
          .find((t) => /\d{4}/.test(t)) || header.textContent || ""
      : "";
    const month = monthKeyFromText(dateText);
    if (!month) continue;
    const rating = li.querySelector(".final-mark .rating");
    const markMatch = /(\d+)\s*%/.exec(rating?.textContent || "");
    const finalMark = markMatch ? Number(markMatch[1]) : null;
    const positive = rating
      ? rating.hasAttribute("data-positive")
      : finalMark !== null && finalMark >= 50;
    out.push({ month, finalMark, positive });
  }
  return out;
}

/** Same aggregation as the worker: an evaluation is "failed" below 50 %. */
export function computeEvalStats(feedbacks: CorrectorFeedback[]): EvalStatsLike {
  const byMonth: EvalStatsLike["byMonth"] = {};
  let globalTotal = 0;
  let globalFailed = 0;
  for (const f of feedbacks) {
    const failed =
      f.finalMark !== null ? f.finalMark < 50 : !f.positive;
    const entry = (byMonth[f.month] ??= { total: 0, failed: 0, successPercentage: null });
    entry.total += 1;
    if (failed) entry.failed += 1;
    globalTotal += 1;
    if (failed) globalFailed += 1;
  }
  const pct = (total: number, failed: number) =>
    total > 0 ? Math.round(((total - failed) / total) * 1000) / 10 : null;
  for (const m of Object.values(byMonth)) {
    m.successPercentage = pct(m.total, m.failed);
  }
  return {
    byMonth,
    global: {
      total: globalTotal,
      failed: globalFailed,
      successPercentage: pct(globalTotal, globalFailed),
    },
  };
}

/** Next page number from the pagination links, or null on the last page. */
export function nextFeedbackPage(html: string, current: number): number | null {
  const re = /feedbacks\?as=corrector(?:&amp;|&)page=(\d+)/g;
  let max = current;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max > current ? current + 1 : null;
}

/** Highest page number the pagination links advertise; 1 without any. */
export function lastFeedbackPage(html: string): number {
  const re = /feedbacks\?as=corrector(?:&amp;|&)page=(\d+)/g;
  let max = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max;
}

export function parseRouletteHistorics(html: string): RouletteEntryLike[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: RouletteEntryLike[] = [];
  const titles = doc.querySelectorAll(".changelog-item p.title");
  titles.forEach((title, index) => {
    const reason = title.querySelector(".reason")?.textContent || "";
    if (!/roulette/i.test(reason)) return;
    const code = title.querySelector("code[data-count][data-date]");
    if (!code) return;
    const sum = Number((code.textContent || "").replace(/\s/g, ""));
    const total = Number(code.getAttribute("data-count"));
    const date = (code.getAttribute("data-date") || "").replace(" UTC", "Z").replace(" ", "T");
    if (!Number.isFinite(sum) || !Number.isFinite(total) || !date) return;
    // stable, distinct ids (the page exposes none); newest first on the page
    out.push({ historic_id: titles.length - index, sum, total, created_at: date });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Local cache of the parsed stats (one hour per login)
// ---------------------------------------------------------------------------

export interface ProfileStatsData {
  roulette: RouletteEntryLike[];
  evalStats: EvalStatsLike | null;
  /** Your Outstanding flags, from the worker's 42 application only. */
  outstanding?: { received: number; given: number } | null;
}

export type ProfileStatsCache = Record<string, { at: number; data: ProfileStatsData }>;

/** Single storage key: `{ [login]: { at, data } }`, pruned on every write. */
export const PROFILE_STATS_CACHE_KEY = "FT_PROFILE_STATS_CACHE";
export const PROFILE_STATS_TTL_MS = 60 * 60 * 1000;
export const PROFILE_STATS_CACHE_MAX = 40;

function isCacheEntry(v: unknown): v is { at: number; data: ProfileStatsData } {
  if (!v || typeof v !== "object") return false;
  const e = v as { at?: unknown; data?: unknown };
  return typeof e.at === "number" && !!e.data && typeof e.data === "object";
}

async function readCacheMap(): Promise<ProfileStatsCache> {
  try {
    const raw = (await chrome.storage.local.get(PROFILE_STATS_CACHE_KEY))[
      PROFILE_STATS_CACHE_KEY
    ];
    if (!raw || typeof raw !== "object") return {};
    const out: ProfileStatsCache = {};
    for (const [login, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (isCacheEntry(entry)) out[login] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** Drop expired entries, then keep only the most recent PROFILE_STATS_CACHE_MAX. */
export function pruneProfileStatsCache(
  cache: ProfileStatsCache,
  now: number = Date.now(),
): ProfileStatsCache {
  const fresh = Object.entries(cache).filter(
    ([, e]) => now - e.at < PROFILE_STATS_TTL_MS,
  );
  fresh.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(fresh.slice(0, PROFILE_STATS_CACHE_MAX));
}

export async function readProfileStatsCache(
  login: string,
  now: number = Date.now(),
): Promise<ProfileStatsData | null> {
  const entry = (await readCacheMap())[login];
  if (!entry || now - entry.at >= PROFILE_STATS_TTL_MS) return null;
  return entry.data;
}

export async function writeProfileStatsCache(
  login: string,
  data: ProfileStatsData,
  now: number = Date.now(),
): Promise<void> {
  const cache = await readCacheMap();
  cache[login] = { at: now, data };
  // Only this key is ever read or written here: the per-login keys of older
  // builds are removed by the background on update (see background.ts), not
  // by a get(null) of the whole storage area from every profile tab.
  await chrome.storage.local.set({
    [PROFILE_STATS_CACHE_KEY]: pruneProfileStatsCache(cache, now),
  });
}

async function fetchIntraPage(url: string): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: FETCH_INTRA_PAGE_MESSAGE,
      url,
    })) as { ok: boolean; text?: string } | undefined;
    return res?.ok && typeof res.text === "string" ? res.text : null;
  } catch {
    return null;
  }
}

/**
 * What fetchProfileStatsViaIntra read. `roulette` and `evalStats` keep the
 * worker's shape; the two flags say how much of it can be trusted.
 */
export interface ProfileStatsFetchResult extends ProfileStatsData {
  /**
   * Every page it needed was read. Only a complete result may be cached: a
   * partial one would be shown as the real numbers for PROFILE_STATS_TTL_MS.
   */
  complete: boolean;
  /**
   * The correction-point history was read. When false, `roulette` is empty
   * because it is unknown, not because the student never won.
   */
  rouletteLoaded: boolean;
}

/**
 * `feedbacks: false` reads the correction-point history only (the worker's
 * 42 application gave the stats): `evalStats` is then null and `complete`
 * means the history was read.
 */
export async function fetchProfileStatsViaIntra(
  login: string,
  { feedbacks: readFeedbacks = true }: { feedbacks?: boolean } = {},
): Promise<ProfileStatsFetchResult> {
  const safeLogin = encodeURIComponent(login);
  const feedbackPageUrl = (page: number) =>
    `https://projects.intra.42.fr/users/${safeLogin}/feedbacks?as=corrector&page=${page}`;

  // Another host and an independent answer: the history is requested with
  // the first feedback page, not after the last one.
  const historicsPromise = fetchIntraPage(
    `https://profile.intra.42.fr/users/${safeLogin}/correction_point_historics`,
  );

  if (!readFeedbacks) {
    const html = await historicsPromise;
    return {
      roulette: html ? parseRouletteHistorics(html) : [],
      evalStats: null,
      complete: html !== null,
      rouletteLoaded: html !== null,
    };
  }

  const pages = new Map<number, CorrectorFeedback[]>();
  let feedbacksComplete = true;
  const first = await fetchIntraPage(feedbackPageUrl(1));
  if (first) {
    pages.set(1, parseCorrectorFeedbacks(first));
    // The links of a page may only reach a few pages ahead (windowed
    // pagination): every page read can push the goal further.
    let advertised = lastFeedbackPage(first);
    let next = 2;
    // An empty page means the list ended before its links said: the pages
    // after it are not wanted, the ones before it are. A failed page ends the
    // walk too; the result is then discarded (see below), so the pages still
    // in flight are simply ignored.
    let endedAt = Infinity;
    let failed = false;
    const worker = async (goal: number) => {
      while (!failed && next <= Math.min(goal, endedAt - 1)) {
        const page = next++;
        const html = await fetchIntraPage(feedbackPageUrl(page));
        if (!html) {
          failed = true;
          return;
        }
        const parsed = parseCorrectorFeedbacks(html);
        if (parsed.length === 0) {
          endedAt = Math.min(endedAt, page);
          return;
        }
        pages.set(page, parsed);
        advertised = Math.max(advertised, lastFeedbackPage(html));
      }
    };
    const goal = () => Math.min(advertised, MAX_FEEDBACK_PAGES, endedAt - 1);
    while (!failed && next <= goal()) {
      const end = goal();
      const workers = Math.min(FEEDBACK_PAGE_CONCURRENCY, end - next + 1);
      await Promise.all(Array.from({ length: workers }, () => worker(end)));
    }
    if (failed) feedbacksComplete = false;
    // Stopped by the cap with pages left: an undercount must not be cached
    // as the real total for an hour.
    if (endedAt === Infinity && advertised > MAX_FEEDBACK_PAGES) {
      feedbacksComplete = false;
    }
  } else {
    feedbacksComplete = false;
  }
  const feedbacks = [...pages.keys()]
    .sort((a, b) => a - b)
    .flatMap((page) => pages.get(page) ?? []);

  const historicsHtml = await historicsPromise;
  const rouletteLoaded = historicsHtml !== null;
  const roulette = historicsHtml ? parseRouletteHistorics(historicsHtml) : [];

  return {
    roulette,
    // With a page missing (the first or a later one) the totals would be too
    // low and still look real: report no stats rather than wrong ones.
    evalStats: feedbacksComplete ? computeEvalStats(feedbacks) : null,
    complete: feedbacksComplete && rouletteLoaded,
    rouletteLoaded,
  };
}
