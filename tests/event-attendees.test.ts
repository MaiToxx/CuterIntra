/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * "Who's going" (cards/events/attendees.ts): a button in the Agenda of your
 * dashboard, a dialog listing the coming events, and for the one you pick
 * the people registered, read from the worker. Signed in only, on a worker
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
  initEventAttendees,
  listableEvents,
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
    expect(workerFetch.mock.calls[0][0]).toBe("/api/v1/private/events/attendees?event=45935");
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

describe("the dialog", () => {
  it("lists the coming events, then the people of the one picked, friends first", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue([event(2, 26 * HOUR), event(1, HOUR, { is_subscribed: true })]);
    workerFetch.mockResolvedValue(answer([person("bob"), person("zoe"), person("alice")]));
    await openAttendeesDialog();
    await settle();

    const rows = [...root().querySelectorAll<HTMLButtonElement>("button[data-event]")];
    expect(rows.map((b) => b.dataset.event)).toEqual(["1", "2"]);
    expect(rows[0].textContent).toContain("Registered");
    expect(rows[1].textContent).not.toContain("Registered");
    expect(workerFetch).not.toHaveBeenCalled();

    rows[1].click();
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
    expect(links[0].textContent).toContain("★");
    expect(links[0].querySelector("img")!.getAttribute("src")).toBe("https://cdn.intra.42.fr/zoe.jpg");

    // back to the list
    [...root().querySelectorAll("button")].find((b) => b.textContent!.includes("All events"))!.click();
    expect(root().querySelectorAll("button[data-event]")).toHaveLength(2);
  });

  it("says so when nobody is registered, when the list is cut, and when the read fails", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue([event(1, HOUR)]);
    const pick = async () => {
      await openAttendeesDialog();
      await settle();
      root().querySelector<HTMLButtonElement>("button[data-event]")!.click();
      await settle();
    };

    workerFetch.mockResolvedValueOnce(answer([]));
    await pick();
    expect(text()).toContain("Nobody is registered yet.");

    workerFetch.mockResolvedValueOnce(answer([person("bob")], true));
    await pick();
    expect(text()).toContain("Only the first 300 are listed.");

    workerFetch.mockResolvedValueOnce(answer(null, false, 502));
    await pick();
    expect(root().querySelector("[role=alert]")!.textContent).toContain("Couldn't load the list");
    expect(document.querySelectorAll("#ft-attendees-dialog")).toHaveLength(1);
  });

  it("an answer that arrives after another event was picked is dropped", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events.mockResolvedValue([event(1, HOUR), event(2, 2 * HOUR)]);
    let slow!: (v: unknown) => void;
    workerFetch
      .mockReturnValueOnce(new Promise((r) => (slow = r)))
      .mockResolvedValueOnce(answer([person("carol")]));
    await openAttendeesDialog();
    await settle();
    root().querySelector<HTMLButtonElement>('button[data-event="1"]')!.click();
    await settle();
    [...root().querySelectorAll("button")].find((b) => b.textContent!.includes("All events"))!.click();
    root().querySelector<HTMLButtonElement>('button[data-event="2"]')!.click();
    await settle();
    slow(answer([person("bob")]));
    await settle();
    expect(text()).toContain("carol");
    expect(text()).not.toContain("bob");
  });

  it("closes with its button and leaves the page; no event at all says so", async () => {
    events.mockResolvedValue(null);
    await openAttendeesDialog();
    await settle();
    expect(text()).toContain("No coming event.");
    root().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    expect(dialog()).toBeNull();
  });
});

describe("the Agenda's button", () => {
  const agenda = () => {
    const header = document.createElement("div");
    const link = document.createElement("a");
    link.href = "https://profile.intra.42.fr/events";
    header.appendChild(link);
    document.body.appendChild(header);
    return header;
  };
  const button = () => document.getElementById("ft-attendees-button");

  it("is added once on your dashboard, put back after a redraw, and opens the dialog", async () => {
    const header = agenda();
    await initEventAttendees();
    await initEventAttendees();
    expect(header.querySelectorAll("#ft-attendees-button")).toHaveLength(1);

    button()!.remove();
    await initEventAttendees();
    expect(button()).not.toBeNull();

    events.mockResolvedValue([]);
    button()!.click();
    await settle();
    expect(dialog()?.open).toBe(true);
  });
});

describe("the Agenda's button, when it must not show", () => {
  const load = async () => {
    vi.resetModules();
    return (await import("../src/features/profile/cards/events/attendees")).initEventAttendees;
  };
  const agenda = () => {
    const header = document.createElement("div");
    const link = document.createElement("a");
    link.href = "https://profile.intra.42.fr/events";
    header.appendChild(link);
    document.body.appendChild(header);
  };

  it("signed out or without the route: no button, asked once per page", async () => {
    session.mockResolvedValue(null);
    agenda();
    const init = await load();
    await init();
    await init();
    expect(document.getElementById("ft-attendees-button")).toBeNull();
    expect(session).toHaveBeenCalledTimes(1);
  });

  it("switched off in the Extras tab: no button, the worker is not even asked", async () => {
    await chrome.storage.local.set({ PROFILE_SHOW_EVENT_ATTENDEES: false });
    agenda();
    const init = await load();
    await init();
    expect(document.getElementById("ft-attendees-button")).toBeNull();
    expect(session).not.toHaveBeenCalled();
  });

  it("without an Agenda on the page: nothing", async () => {
    const init = await load();
    await init();
    expect(document.getElementById("ft-attendees-button")).toBeNull();
    expect(session).not.toHaveBeenCalled();
  });
});
