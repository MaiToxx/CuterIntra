/**
 * Your TIGs (community services), typed in by hand and kept in this browser.
 *
 * WHY by hand: the 42 API refuses /v2/users/<login>/closes and
 * /v2/community_services to a student's application (403, probed on
 * 2026-11-27 with tools/probe-42-api.mjs --tig), and the Intra shows no
 * schedule for them. The entries are drawn in the Agenda (tig.ui.ts), on the
 * logtime calendar, and written to the calendar feed when a link exists.
 *
 * CALENDAR_TIGS is not a cloud-synced key: it stays on this device unless
 * the student has a calendar link, in which case the feed carries it.
 */
import { getConfig } from "../../core/config.ts";
import type { CalendarEvent } from "../logtime/types.ts";

export const TIG_KIND = "tig";
export const TIG_COLOR = "#f97316";
export const TIG_NOTE_MAX = 80;
/** A TIG is forgotten this long after its end. */
const KEEP_AFTER_MS = 30 * 24 * 60 * 60_000;
const MAX_TIGS = 50;
const HOUR_MS = 60 * 60_000;

export interface Tig {
  id: number;
  /** Start, ISO 8601 in UTC. */
  begin_at: string;
  hours: number;
  note: string;
}

export const tigEnd = (tig: Tig): number => Date.parse(tig.begin_at) + tig.hours * HOUR_MS;

/** What storage holds, checked: the value may come from a backup file. */
export function cleanTigs(raw: unknown, now = Date.now()): Tig[] {
  if (!Array.isArray(raw)) return [];
  const list: Tig[] = [];
  for (const item of raw as Partial<Tig>[]) {
    if (!item || typeof item !== "object") continue;
    const start = typeof item.begin_at === "string" ? Date.parse(item.begin_at) : NaN;
    const hours = Number(item.hours);
    if (!Number.isInteger(item.id) || !Number.isFinite(start)) continue;
    if (!(hours > 0 && hours <= 24)) continue;
    const tig: Tig = {
      id: item.id as number,
      begin_at: new Date(start).toISOString(),
      hours,
      note: typeof item.note === "string" ? item.note.trim().slice(0, TIG_NOTE_MAX) : "",
    };
    if (now - tigEnd(tig) <= KEEP_AFTER_MS) list.push(tig);
  }
  return list.sort((a, b) => Date.parse(a.begin_at) - Date.parse(b.begin_at)).slice(-MAX_TIGS);
}

export async function readTigs(): Promise<Tig[]> {
  try {
    const store = await chrome.storage.local.get("CALENDAR_TIGS");
    return cleanTigs(store.CALENDAR_TIGS);
  } catch {
    return [];
  }
}

/** Your TIGs, or none with the switch off (Extras tab): nothing draws them then. */
export async function shownTigs(): Promise<Tig[]> {
  return (await getConfig("CALENDAR_SHOW_TIG")) ? readTigs() : [];
}

export async function saveTigs(list: Tig[]): Promise<Tig[]> {
  const clean = cleanTigs(list);
  await chrome.storage.local.set({ CALENDAR_TIGS: clean });
  return clean;
}

/** The TIGs that are not over yet, soonest first. */
export const upcomingTigs = (list: Tig[], now = Date.now()): Tig[] =>
  list.filter((tig) => tigEnd(tig) > now);

/**
 * A TIG from the form's local date ("YYYY-MM-DD") and time ("HH:MM"), or
 * null when one of them is not usable.
 */
export function makeTig(date: string, time: string, hours: number, note: string, id = Date.now()): Tig | null {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) return null;
  const start = new Date(`${date}T${time}:00`).getTime();
  if (!Number.isFinite(start)) return null;
  return cleanTigs([{ id, begin_at: new Date(start).toISOString(), hours, note }], start)[0] ?? null;
}

/**
 * The TIGs as events of the logtime calendar and of the feed. The name is
 * not translated: the feed serves every device.
 */
export function tigEvents(list: Tig[]): CalendarEvent[] {
  return list.map((tig) => ({
    id: tig.id,
    kind: TIG_KIND,
    name: tig.note ? `TIG: ${tig.note}` : "TIG",
    begin_at: tig.begin_at,
    end_at: new Date(tigEnd(tig)).toISOString(),
    location: "",
    is_subscribed: true,
  }));
}
