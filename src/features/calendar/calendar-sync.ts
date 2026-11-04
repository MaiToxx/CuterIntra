import { getWorkerFeatures, workerFetch } from "../../core/worker.ts";
import { fetchOwnEvents, isOwnProfilePage } from "./own-events.ts";
import type { CalendarEvent } from "../logtime/types.ts";
import {
  fetchUpcomingEvaluations,
  type UpcomingEvaluation,
} from "../profile/cards/evaluations-api.ts";

/** What an event of the feed is built from (a subset of the Intra event). */
interface IcsEvent {
  id: number;
  name: string;
  kind: string;
  begin_at: string;
  end_at: string;
  location?: string;
  /**
   * false for a campus event you are not registered for (the "all campus
   * events" option): it gets no reminder and says so in its description.
   * Absent counts as registered, as every event of the feed used to be.
   */
  is_subscribed?: boolean;
}

/** kind of the feed entries made from your booked evaluations. */
export const EVALUATION_KIND = "evaluation";

/**
 * Your booked evaluations as feed entries, with the same 15-minute reminder.
 * The feed is not translated (one feed serves every device) and names no
 * other student: it is stored on the worker.
 */
export function evaluationEvents(list: UpcomingEvaluation[]): IcsEvent[] {
  return list.map((e) => ({
    id: e.id,
    kind: EVALUATION_KIND,
    name:
      e.role === "corrector"
        ? `Evaluation: you evaluate ${e.project ?? "a project"}`
        : `Evaluation: you are evaluated on ${e.project ?? "your project"}`,
    begin_at: e.beginAt,
    end_at: e.endAt,
  }));
}

function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    // CRLF, lone CR and LF alike: a bare CR would end the content line
    .replace(/\r\n|\r|\n/g, "\\n");
}

function formatIcsDate(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * RFC 5545 §3.1: a content line is at most 75 octets; a longer one goes on
 * as lines that start with a space. Cut between code points, never inside a
 * character's UTF-8 bytes. Strict calendar apps dropped the long SUMMARY and
 * LOCATION lines (or the whole event) of an unfolded feed.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    // 75 on the first line, 74 after the leading space of the others
    const room = parts.length === 0 ? 75 : 74;
    if (bytes + size > room) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

// Covers every field the .ics is built from: with only id and begin_at, a
// subscribed event whose end, name or room changed was never re-uploaded.
// An empty list hashes to "0", so dropping the last event is uploaded once.
function computeHash(events: IcsEvent[]): string {
  let h = 0;
  for (const e of events) {
    // The registration flag only when false: a feed of registered events
    // hashes as it always did, and is not uploaded again after an update.
    const key = `${e.id}|${e.kind}|${e.begin_at}|${e.end_at}|${e.name}|${e.location ?? ""}${e.is_subscribed === false ? "|0" : ""}`;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
  }
  return String(h);
}

/**
 * `now` is the DTSTAMP of every event (RFC 5545 requires one per VEVENT; the
 * feed had none). It is not part of computeHash(): an unchanged list is
 * still not uploaded again.
 */
export function generateIcs(events: IcsEvent[], now: Date = new Date()): string {
  const stamp = formatIcsDate(now.toISOString());
  const lines: string[] = [];
  lines.push(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BetterIntra//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:42 Events",
  );

  for (const ev of events) {
    // An evaluation has its own UID space: its id is a scale team id, which
    // may equal an event id.
    const isEvaluation = ev.kind === EVALUATION_KIND;
    const url = isEvaluation
      ? "https://profile.intra.42.fr/"
      : ev.kind === "exam"
        ? `https://profile.intra.42.fr/exams/${ev.id}`
        : `https://profile.intra.42.fr/events/${ev.id}`;
    const registered = ev.is_subscribed !== false;
    lines.push(
      "BEGIN:VEVENT",
      isEvaluation ? `UID:eval-${ev.id}@better-intra` : `UID:${ev.id}@better-intra`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsDate(ev.begin_at)}`,
      `DTEND:${formatIcsDate(ev.end_at)}`,
      `SUMMARY:${escapeIcs(ev.name)}`,
      ev.location ? `LOCATION:${escapeIcs(ev.location)}` : "",
      `URL:${url}`,
      // The feed's text is not translated: one feed serves every device.
      registered ? "" : "DESCRIPTION:Not registered (campus event)",
      // Shown as free time: you have not said you are going.
      registered ? "" : "TRANSP:TRANSPARENT",
      ...(registered
        ? [
            "BEGIN:VALARM",
            "TRIGGER:-PT15M",
            "ACTION:DISPLAY",
            "DESCRIPTION:15 min before",
            "END:VALARM",
          ]
        : []),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).map(foldIcsLine).join("\r\n");
}

export async function syncCalendarIcs(
  events: IcsEvent[],
  force = false,
): Promise<void> {
  const store = await chrome.storage.local.get([
    "CLOUD_TOKEN",
    "CLOUD_LOGIN",
    "CALENDAR_SYNC_TOKEN",
    "CALENDAR_EVENTS_HASH",
  ]);
  const sessionToken = store["CLOUD_TOKEN"] as string;
  const cloudLogin = store["CLOUD_LOGIN"] as string;
  const calendarToken = store["CALENDAR_SYNC_TOKEN"] as string;

  if (!sessionToken || !cloudLogin || !calendarToken) return;

  const currentHash = computeHash(events);
  if (!force && store["CALENDAR_EVENTS_HASH"] === currentHash) return;

  const ics = generateIcs(events);

  // A 401 flags CLOUD_AUTH_FAILED through workerFetch: the worker keeps ten
  // sessions per login and revokes the oldest on the eleventh sign-in, and
  // this feed used to stop updating on the revoked machines without a word.
  const res = await workerFetch("/api/v1/private/calendar/update", {
    method: "POST",
    body: { ics },
    auth: { login: cloudLogin, token: sessionToken },
    timeoutMs: 20_000,
  });
  if (res.ok) {
    await chrome.storage.local.set({ CALENDAR_EVENTS_HASH: currentHash });
  } else if (res.status === 410) {
    // Every link of this login was stopped (Stop sharing, maybe in another
    // browser): the worker refuses the upload. Forget the dead link, or each
    // profile visit would try again and the Calendar tab would keep offering
    // a feed that no longer exists. Unless a new link was generated while
    // this upload was on its way: that one is live.
    const { CALENDAR_SYNC_TOKEN: current } = await chrome.storage.local.get("CALENDAR_SYNC_TOKEN");
    if (current === calendarToken) {
      await chrome.storage.local.remove(["CALENDAR_SYNC_TOKEN", "CALENDAR_EVENTS_HASH"]);
    }
  }
}

async function evaluationsAnnounced(): Promise<boolean> {
  return (await getWorkerFeatures()).evaluations === true;
}

/**
 * The events of the feed: those you are registered for, or with `all`, every
 * event and exam of your campus the Intra lists (the same list the logtime
 * calendar marks in red), the unregistered ones flagged.
 */
export function feedEvents(events: CalendarEvent[], all: boolean): IcsEvent[] {
  if (!all) return events.filter((e) => e.is_subscribed);
  return events.map((e) => ({ ...e, is_subscribed: e.is_subscribed === true }));
}

/**
 * Refresh the feed from your subscribed events. Called by main.ts on every
 * Intra page, whatever features are switched on: the Calendar tab promises a
 * refresh on each visit to your own profile, and the Logtime switch has no
 * say in that.
 *
 * Returns at once elsewhere than on your own profile, and before any request
 * unless a cloud session and a calendar link both exist, so students without
 * a link pay nothing. A failed events read leaves the feed alone; an empty
 * list is uploaded, so unsubscribing from the last event drops it.
 */
export async function maybeSyncCalendar(): Promise<void> {
  if (!isOwnProfilePage()) return;
  try {
    const store = await chrome.storage.local.get([
      "CLOUD_TOKEN",
      "CLOUD_LOGIN",
      "CALENDAR_SYNC_TOKEN",
      "CALENDAR_ALL_CAMPUS_EVENTS",
      "CALENDAR_EVALUATIONS",
    ]);
    if (!store.CLOUD_TOKEN || !store.CLOUD_LOGIN || !store.CALENDAR_SYNC_TOKEN) {
      return;
    }
    // Absent means on: the default of the setting.
    const withEvaluations = store.CALENDAR_EVALUATIONS !== false;
    const [events, evaluations] = await Promise.all([
      fetchOwnEvents(),
      withEvaluations ? fetchUpcomingEvaluations().catch(() => null) : Promise.resolve([]),
    ]);
    if (!events) return;
    // null is "unknown" (no 42 application on the worker, an older worker, a
    // failed read): the feed is then built from the events alone, as before.
    // Uploading it would drop evaluations a previous visit put there, so a
    // failed read on a worker that has the route leaves the feed alone.
    if (evaluations === null && withEvaluations && (await evaluationsAnnounced())) return;
    await syncCalendarIcs([
      ...feedEvents(events, store.CALENDAR_ALL_CAMPUS_EVENTS === true),
      ...evaluationEvents(evaluations ?? []),
    ]);
  } catch {
    // The feed keeps serving what it had; the next visit tries again.
  }
}
