/**
 * The "all campus events" option of the calendar feed: the Intra's events
 * list (intrapy /users/me/events) already holds every campus event and exam,
 * registered or not. With the option on, the unregistered ones join the feed
 * as free time without a reminder; with it off, the feed stays exactly what
 * it was (same lines, same hash, so no re-upload after an update).
 */
import { describe, it, expect } from "vitest";
import { feedEvents, generateIcs } from "../src/features/calendar/calendar-sync";
import type { CalendarEvent } from "../src/features/logtime/types";

const ev = (id: number, is_subscribed: boolean, kind = "event"): CalendarEvent => ({
  id,
  name: `Event ${id}`,
  kind,
  begin_at: "2026-11-10T10:00:00.000Z",
  end_at: "2026-11-10T11:00:00.000Z",
  location: "Room",
  is_subscribed,
});

const NOW = new Date("2026-11-04T12:00:00Z");

function vevents(ics: string): string[] {
  return ics.split("BEGIN:VEVENT").slice(1);
}

describe("feedEvents", () => {
  const list = [ev(1, true), ev(2, false), ev(3, false, "exam")];

  it("keeps only registered events when the option is off", () => {
    expect(feedEvents(list, false).map((e) => e.id)).toEqual([1]);
  });

  it("keeps every event and exam when the option is on", () => {
    const out = feedEvents(list, true);
    expect(out.map((e) => [e.id, e.is_subscribed])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});

describe("generateIcs with unregistered events", () => {
  it("gives an unregistered event no reminder, free time and a description", () => {
    const [registered, other] = vevents(generateIcs(feedEvents([ev(1, true), ev(2, false)], true), NOW));
    expect(registered).toContain("BEGIN:VALARM");
    expect(registered).not.toContain("TRANSP:TRANSPARENT");
    expect(registered).not.toContain("DESCRIPTION:Not registered");
    expect(other).not.toContain("BEGIN:VALARM");
    expect(other).toContain("TRANSP:TRANSPARENT");
    expect(other).toContain("DESCRIPTION:Not registered (campus event)");
  });

  it("links an unregistered exam to its exam page", () => {
    const ics = generateIcs(feedEvents([ev(3, false, "exam")], true), NOW);
    expect(ics).toContain("URL:https://profile.intra.42.fr/exams/3");
  });

  it("writes a registered-only feed exactly as before the option existed", () => {
    const legacy = generateIcs([{ ...ev(1, true), is_subscribed: undefined }], NOW);
    const now = generateIcs(feedEvents([ev(1, true), ev(2, false)], false), NOW);
    expect(now).toBe(legacy);
  });
});
