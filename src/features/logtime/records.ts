/**
 * Streaks and personal records, from the daily totals the widget already
 * draws (the page's locations_stats): nothing is fetched or stored. A
 * student had to count heatmap cells to know how many days in a row they
 * had come, and hover every week to find their best one.
 */
import { getMondayWeekStart } from "./heatmap.ts";
import { fmtHours } from "./utils.ts";
import { intlLocale, t, tp } from "../../core/i18n/i18n.ts";

export interface LogtimeRecords {
  /** Days in a row with logtime, ending today, or yesterday while today is still empty. */
  currentStreak: number;
  longestStreak: number;
  /** The day with the most logtime (the first one on a tie), "YYYY-MM-DD". */
  bestDay: { date: string; secs: number };
  /** The Monday-to-Sunday week with the most logtime, by its Monday. */
  bestWeek: { monday: string; secs: number };
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Local midnight of "YYYY-MM-DD" (the bare string would parse as UTC). */
const localDay = (key: string): Date => new Date(`${key}T00:00:00`);

/**
 * The day `offset` days from `key`. By the calendar date, not by adding
 * 24 h: two local midnights are 23 or 25 h apart across a DST change.
 */
function shiftDay(key: string, offset: number): string {
  const d = localDay(key);
  d.setDate(d.getDate() + offset);
  return ymd(d);
}

/**
 * A "HH:MM:SS" total in seconds. The Intra sends fractions of a second
 * ("03:12:45.123456"), so a day is active when its seconds are above 0: the
 * string comparisons with "00:00:00" elsewhere would count "00:00:00.000000".
 */
function toSecs(value: string): number {
  const [h = 0, m = 0, s = 0] = value.split(":").map(Number);
  const secs = h * 3600 + m * 60 + s;
  return Number.isFinite(secs) ? secs : 0;
}

/** The records of `stats`, or null when it has no day with logtime. `now` is injectable for tests. */
export function computeRecords(
  stats: Record<string, string>,
  now: Date = new Date(),
): LogtimeRecords | null {
  const active = new Set<string>();
  const weeks = new Map<string, number>();
  let bestDay: LogtimeRecords["bestDay"] | null = null;
  for (const date of Object.keys(stats).sort()) {
    const secs = toSecs(stats[date]);
    if (secs <= 0) continue;
    active.add(date);
    if (!bestDay || secs > bestDay.secs) bestDay = { date, secs };
    const monday = ymd(getMondayWeekStart(localDay(date)));
    weeks.set(monday, (weeks.get(monday) ?? 0) + secs);
  }
  if (!bestDay) return null;

  let longestStreak = 0;
  let run = 0;
  let previous = "";
  for (const date of active) {
    // the set keeps the sorted order it was filled in
    run = previous && shiftDay(previous, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }

  const today = ymd(now);
  let day = active.has(today) ? today : shiftDay(today, -1);
  let currentStreak = 0;
  while (active.has(day)) {
    currentStreak++;
    day = shiftDay(day, -1);
  }

  let bestWeek: LogtimeRecords["bestWeek"] = { monday: "", secs: 0 };
  for (const [monday, secs] of weeks) {
    if (secs > bestWeek.secs) bestWeek = { monday, secs };
  }

  return { currentStreak, longestStreak, bestDay, bestWeek };
}

/** The lines of the records badge's tooltip, also its accessible name. */
export function recordsLines(records: LogtimeRecords): string[] {
  // day/month, as the Active badge writes its date
  const fmt = new Intl.DateTimeFormat(intlLocale("en-GB"), { day: "2-digit", month: "2-digit" });
  const date = (key: string) => fmt.format(localDay(key));
  return [
    tp(records.currentStreak, "Current streak: {n} day", "Current streak: {n} days"),
    tp(records.longestStreak, "Longest streak: {n} day", "Longest streak: {n} days"),
    t("Best day: {hours} ({date})", {
      hours: fmtHours(records.bestDay.secs),
      date: date(records.bestDay.date),
    }),
    t("Best week: {hours} (week of {date})", {
      hours: fmtHours(records.bestWeek.secs),
      date: date(records.bestWeek.monday),
    }),
    // older months only count once "Load older months" has fetched them
    t("Over the days shown"),
  ];
}
