/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * "Who's going" (cards/events/attendees.ts): a link in each event card of
 * your Agenda that opens the people registered, and the same list on the
 * page of an event, read from the worker. Signed in only, on a worker
 * that has the route.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { CalendarEvent } from "../src/features/logtime/types";

const events = vi.fn<() => Promise<CalendarEvent[] | null>>();
const session = vi.fn(async (): Promise<{ login: string; token: string } | null> => ({
  login: "me",
  token: "sess",
}));
const workerFetch = vi.fn();

vi.mock("../src/features/calendar/own-events.ts", () => ({ fetchOwnEvents: () => events() }));
vi.mock("../src/features/profile/cards/evaluations-api.ts", () => ({
  ownSession: (...args: unknown[]) => (session as (...a: unknown[]) => unknown)(...args),
  cdnImage: (v: unknown) =>
    typeof v === "string" && v.startsWith("https://cdn.intra.42.fr/") ? v : null,
}));
vi.mock("../src/core/worker.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));
vi.mock("../src/features/friends/friends.ts", () => ({ getFriendsList: async () => ["Zoe"] }));
vi.mock("../src/core/theme/theme-manager.ts", () => ({ getEffectiveTheme: async () => "dark" }));

import {
  fetchEventAttendees,
  linkedEventId,
  listableEvents,
  matchEvents,
  openAttendeesDialog,
  orderAttendees,
} from "../src/features/profile/cards/events/attendees";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;
const event = (id: number, startsIn: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  name: `Event ${id}`,
  kind: "conference",
  begin_at: new Date(NOW + startsIn).toISOString(),
  end_at: new Date(NOW + startsIn + 2 * HOUR).toISOString(),
  location: "amphi",
  is_subscribed: false,
  ...extra,
});
const answer = (attendees: unknown, more = false, status = 200) => ({
  ok: status === 200,
  status,
  json: status === 200 ? { attendees, more } : { error: "x" },
});
const person = (login: string, picture = `https://cdn.intra.42.fr/${login}.jpg`) => ({
  login,
  name: `Full ${login}`,
  imageUrl: picture,
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const dialog = () => document.getElementById("ft-attendees-dialog") as HTMLDialogElement | null;
const root = () => dialog()!.firstElementChild!.shadowRoot!;
const text = () => root().textContent!.replace(/\s+/g, " ");

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

beforeEach(async () => {
  vi.useRealTimers();
  await chrome.storage.local.clear();
  document.body.replaceChildren();
  events.mockReset();
  session.mockReset();
  session.mockImplementation(async () => ({ login: "me", token: "sess" }));
  workerFetch.mockReset();
});

describe("listableEvents and orderAttendees", () => {
  it("keeps coming events and the ones over for less than a day, soonest first, without exams", () => {
    const list = listableEvents(
      [
        event(3, 48 * HOUR),
        event(1, -5 * HOUR),
        event(9, -72 * HOUR),
        event(2, HOUR),
        event(7, 2 * HOUR, { kind: "exam" }),
        event(0, HOUR),
      ],
      NOW,
    );
    expect(list.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("puts friends first, then sorts by login", () => {
    const sorted = orderAttendees([person("bob"), person("zoe"), person("alice")], new Set(["zoe"]));
    expect(sorted.map((a) => a.login)).toEqual(["zoe", "alice", "bob"]);
  });
});

describe("fetchEventAttendees", () => {
  it("asks the worker for that event and keeps valid rows, pictures from Intra's CDN only", async () => {
    workerFetch.mockResolvedValue(
      answer([person("bob"), person("eve", "https://evil.example/x.jpg"), { login: "../x" }, null], true),
    );
    const result = await fetchEventAttendees(45935);
    expect(workerFetch.mock.calls[0][0]).toBe("/api/v1/private/events/attendees?user=me&event=45935");
    expect(workerFetch.mock.calls[0][1]).toMatchObject({ auth: { login: "me", token: "sess" } });
    expect(result).toEqual({
      ok: true,
      attendees: [person("bob"), { login: "eve", name: "Full eve", imageUrl: null }],
      more: true,
    });
  });

  it("signed out, or on a worker without the route: no request", async () => {
    session.mockResolvedValue(null);
    expect(await fetchEventAttendees(1)).toEqual({ ok: false, reason: "signed-out" });
    expect(workerFetch).not.toHaveBeenCalled();
    expect(session.mock.calls[0]).toEqual([undefined, "eventAttendees"]);
  });

  it("tells an event that is over from a busy server and from a failure", async () => {
    workerFetch.mockResolvedValueOnce(answer(null, false, 404));
    expect(await fetchEventAttendees(1)).toEqual({ ok: false, reason: "over" });
    workerFetch.mockResolvedValueOnce(answer(null, false, 429));
    expect(await fetchEventAttendees(1)).toEqual({ ok: false, reason: "busy" });
    workerFetch.mockResolvedValueOnce(answer(null, false, 502));
    expect(await fetchEventAttendees(1)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("matchEvents and linkedEventId", () => {
  it("finds the events a card names: the longest name, every date of it", () => {
    const list = [
      event(1, HOUR, { name: "Talk" }),
      event(2, 2 * HOUR, { name: "Talk about Rust" }),
      event(3, 3 * HOUR, { name: "Talk about Rust" }),
    ];
    expect(matchEvents("conference  TALK about\n rust amphi", list).map((e) => e.id)).toEqual([2, 3]);
    expect(matchEvents("conference Talk amphi", list).map((e) => e.id)).toEqual([1]);
    expect(matchEvents("something else", list)).toEqual([]);
  });

  it("reads the id from a link to the event", () => {
    const el = document.createElement("div");
    el.innerHTML = '<a href="https://profile.intra.42.fr/events/45935">x</a>';
    expect(linkedEventId(el)).toBe(45935);
    expect(linkedEventId(document.createElement("div"))).toBeNull();
  });
});

describe("the dialog", () => {
  it("shows the people of the event, friends first", async () => {
    workerFetch.mockResolvedValue(answer([person("bob"), person("zoe"), person("alice")]));
    await openAttendeesDialog(event(2, HOUR));
    await settle();

    expect(workerFetch.mock.calls[0][0]).toContain("event=2");
    expect(text()).toContain("Event 2");
    expect(root().querySelector("[data-count]")!.textContent).toMatch(/3 registered · 1 of your friends/);
    const links = [...root().querySelectorAll<HTMLAnchorElement>("li a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://profile-v3.intra.42.fr/users/zoe",
      "https://profile-v3.intra.42.fr/users/alice",
      "https://profile-v3.intra.42.fr/users/bob",
    ]);
    expect(links[0].querySelector("[data-friend]")).not.toBeNull();
    expect(links[1].querySelector("[data-friend]")).toBeNull();
    expect(links[0].querySelector("img")!.getAttribute("src")).toBe("https://cdn.intra.42.fr/zoe.jpg");
  });

  it("says so when nobody is registered, when the list is cut, and when the read fails", async () => {
    const open = async () => {
      await openAttendeesDialog(event(1, HOUR));
      await settle();
    };
    workerFetch.mockResolvedValueOnce(answer([]));
    await open();
    expect(text()).toContain("Nobody is registered yet.");

    workerFetch.mockResolvedValueOnce(answer([person("bob")], true));
    await open();
    expect(text()).toContain("Only the first 300 are listed.");

    workerFetch.mockResolvedValueOnce(answer(null, false, 502));
    await open();
    expect(root().querySelector("[role=alert]")!.textContent).toContain("Couldn't load the list");
    expect(document.querySelectorAll("#ft-attendees-dialog")).toHaveLength(1);
  });

  it("closes with its button and leaves the page", async () => {
    workerFetch.mockResolvedValue(answer([]));
    await openAttendeesDialog({ id: 7 });
    await settle();
    expect(text()).toContain("Who's going");
    root().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    expect(dialog()).toBeNull();
  });
});

const card = (label: string, href?: string) => {
  const el = document.createElement("div");
  el.className = "relative clear-both m-1 border rounded";
  el.innerHTML = `<b>conference</b><span>${label}</span>${href ? `<a href="${href}">open</a>` : ""}`;
  document.body.appendChild(el);
  return el;
};
const load = async () => {
  vi.resetModules();
  return await import("../src/features/profile/cards/events/attendees");
};

describe("the link in the Agenda's cards", () => {
  it("is added once to each card that names a coming event, and opens its list", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue([event(1, HOUR), event(2, 2 * HOUR), event(9, HOUR, { kind: "exam" })]);
    const first = card("Event 1");
    const linked = card("Renamed", "https://profile.intra.42.fr/events/777");
    const unknown = card("Not in my events");
    const exam = card("Event 9");
    const { initEventAttendees } = await load();
    await initEventAttendees();
    await initEventAttendees();

    expect(first.querySelectorAll(".ft-attendees-link")).toHaveLength(1);
    expect(first.querySelector(".ft-attendees-link")!.textContent).toBe("Who's going");
    expect(linked.querySelector(".ft-attendees-link")!.id).toBe("ft-attendees-link-777");
    expect(unknown.querySelector(".ft-attendees-link")).toBeNull();
    expect(exam.querySelector(".ft-attendees-link")).toBeNull();
    expect(events).toHaveBeenCalledTimes(1);

    // put back after a redraw
    first.querySelector(".ft-attendees-link")!.remove();
    await initEventAttendees();
    expect(first.querySelector(".ft-attendees-link")).not.toBeNull();

    // the click opens the list and does not reach the card
    const cardClick = vi.fn();
    first.addEventListener("click", cardClick);
    workerFetch.mockResolvedValue(answer([person("bob")]));
    first.querySelector<HTMLButtonElement>(".ft-attendees-link")!.click();
    await settle();
    expect(cardClick).not.toHaveBeenCalled();
    expect(dialog()?.hasAttribute("open")).toBe(true);
    expect(workerFetch.mock.calls[0][0]).toContain("event=1");
  });

  it("a weekly event: each card opens its own date, in page order", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue([
      event(12, 8 * 24 * HOUR, { name: "Weekly talk" }),
      event(11, 24 * HOUR, { name: "Weekly talk" }),
      event(10, -6 * HOUR, { name: "Weekly talk" }),
    ]);
    const first = card("Weekly talk");
    const second = card("Weekly talk");
    const third = card("Weekly talk");
    const { initEventAttendees } = await load();
    await initEventAttendees();
    // the one that ended this morning is not a card of the Agenda
    expect(first.querySelector(".ft-attendees-link")!.id).toBe("ft-attendees-link-11");
    expect(second.querySelector(".ft-attendees-link")!.id).toBe("ft-attendees-link-12");
    expect(third.querySelector(".ft-attendees-link")).toBeNull();

    // a redrawn second card gets its own date back, not the first
    second.querySelector(".ft-attendees-link")!.remove();
    await initEventAttendees();
    expect(second.querySelector(".ft-attendees-link")!.id).toBe("ft-attendees-link-12");
  });

  it("signed out or without the route: no link, asked again a minute later only", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    session.mockResolvedValue(null);
    const el = card("Event 1");
    events.mockResolvedValue([event(1, HOUR)]);
    const { initEventAttendees } = await load();
    await initEventAttendees();
    await initEventAttendees();
    expect(document.querySelector(".ft-attendees-link")).toBeNull();
    expect(session).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();

    // the first no may have been a /features read that timed out
    session.mockResolvedValue({ login: "me", token: "sess" });
    vi.setSystemTime(NOW + 61_000);
    await initEventAttendees();
    expect(el.querySelector(".ft-attendees-link")).not.toBeNull();
  });

  it("a failed read of your events is not repeated on every pass", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue(null);
    const el = card("Event 1");
    const { initEventAttendees } = await load();
    await initEventAttendees();
    await initEventAttendees();
    expect(events).toHaveBeenCalledTimes(1);
    events.mockResolvedValue([event(1, HOUR)]);
    vi.setSystemTime(NOW + 61_000);
    await initEventAttendees();
    expect(events).toHaveBeenCalledTimes(2);
    expect(el.querySelector(".ft-attendees-link")).not.toBeNull();
  });

  it("two quick clicks leave one dialog", async () => {
    workerFetch.mockResolvedValue(answer([]));
    await Promise.all([openAttendeesDialog({ id: 1 }), openAttendeesDialog({ id: 1 })]);
    expect(document.querySelectorAll("#ft-attendees-dialog")).toHaveLength(1);
  });

  it("switched off in the Extras tab: no link, the worker is not even asked", async () => {
    await chrome.storage.local.set({ PROFILE_SHOW_EVENT_ATTENDEES: false });
    card("Event 1");
    const { initEventAttendees } = await load();
    await initEventAttendees();
    expect(document.querySelector(".ft-attendees-link")).toBeNull();
    expect(session).not.toHaveBeenCalled();
  });

  it("without an event card on the page: nothing", async () => {
    const { initEventAttendees } = await load();
    await initEventAttendees();
    expect(session).not.toHaveBeenCalled();
  });
});

describe("the page of an event", () => {
  const panel = () => document.getElementById("ft-attendees-panel");
  const visit = (path: string) => {
    vi.stubGlobal("location", new URL(`https://profile.intra.42.fr${path}`));
  };

  it("draws the list under the event, once", async () => {
    visit("/events/45935");
    document.body.innerHTML = '<div class="page-content"><h4>Event</h4></div>';
    workerFetch.mockResolvedValue(answer([person("bob"), person("zoe")]));
    const { initEventPageAttendees } = await load();
    await initEventPageAttendees();
    await initEventPageAttendees();
    await settle();
    expect(document.querySelectorAll(".page-content > #ft-attendees-panel")).toHaveLength(1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(workerFetch.mock.calls[0][0]).toContain("event=45935");
    const shown = panel()!.shadowRoot!.textContent!.replace(/\s+/g, " ");
    expect(shown).toContain("Who's going");
    expect(shown).toContain("2 registered");
    vi.unstubAllGlobals();
  });

  it("leaves nothing for an event that is over, and nothing on other pages", async () => {
    visit("/events/1");
    workerFetch.mockResolvedValue(answer(null, false, 404));
    let mod = await load();
    await mod.initEventPageAttendees();
    await settle();
    expect(panel()).toBeNull();

    visit("/events");
    workerFetch.mockClear();
    mod = await load();
    await mod.initEventPageAttendees();
    await settle();
    expect(panel()).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
