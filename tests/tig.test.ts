/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * TIGs typed in by hand (features/calendar/tig.ts, tig.ui.ts): kept in this
 * browser, drawn in the Agenda of your own dashboard, on the logtime
 * calendar's days and in the calendar feed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const sync = vi.hoisted(() => ({ maybeSyncCalendar: vi.fn(async () => {}) }));
vi.mock("../src/features/calendar/calendar-sync.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  maybeSyncCalendar: sync.maybeSyncCalendar,
}));
vi.mock("../src/core/theme/theme-manager.ts", () => ({ getEffectiveTheme: async () => "dark" }));

import { generateIcs } from "../src/features/calendar/calendar-sync";
import {
  cleanTigs,
  makeTig,
  readTigs,
  saveTigs,
  shownTigs,
  tigEvents,
  upcomingTigs,
  type Tig,
} from "../src/features/calendar/tig";
import { initTigAgenda, openTigDialog, tigSoon } from "../src/features/calendar/tig.ui";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tig = (id: number, startsIn: number, extra: Partial<Tig> = {}): Tig => ({
  id,
  begin_at: new Date(Date.now() + startsIn).toISOString(),
  hours: 2,
  note: "",
  ...extra,
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const agenda = () => {
  document.body.innerHTML = `<div id="card"><div id="head"><a href="/events">Agenda</a></div><div id="events"></div></div>`;
};

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

beforeEach(async () => {
  await chrome.storage.local.clear();
  document.body.innerHTML = "";
  sync.maybeSyncCalendar.mockClear();
});

describe("the stored list", () => {
  it("keeps valid entries in date order and drops what is not a TIG", () => {
    const list = cleanTigs([
      tig(2, 3 * DAY),
      tig(1, DAY, { note: "  cleaning the kitchen  " }),
      { id: 3, begin_at: "never", hours: 2, note: "" },
      { id: 4, begin_at: new Date().toISOString(), hours: 0, note: "" },
      { id: 5, begin_at: new Date().toISOString(), hours: 40, note: "" },
      "tig",
      null,
    ]);
    expect(list.map((t) => t.id)).toEqual([1, 2]);
    expect(list[0].note).toBe("cleaning the kitchen");
    expect(cleanTigs("nope")).toEqual([]);
  });

  it("cuts a long note and forgets a TIG over for more than 30 days", () => {
    const list = cleanTigs([tig(1, -31 * DAY), tig(2, -2 * DAY), tig(3, DAY, { note: "x".repeat(200) })]);
    expect(list.map((t) => t.id)).toEqual([2, 3]);
    expect(list[1].note).toHaveLength(80);
    expect(upcomingTigs(list).map((t) => t.id)).toEqual([3]);
  });

  it("builds a TIG from the form's local date and time", () => {
    const made = makeTig("2026-12-05", "14:30", 2.5, "bocal", 7)!;
    expect(new Date(made.begin_at).getTime()).toBe(new Date(2026, 11, 5, 14, 30).getTime());
    expect(made).toMatchObject({ id: 7, hours: 2.5, note: "bocal" });
    expect(makeTig("", "14:30", 2, "")).toBeNull();
    expect(makeTig("2026-12-05", "", 2, "")).toBeNull();
    expect(makeTig("2026-12-05", "14:30", 0, "")).toBeNull();
  });

  it("is saved to this browser and hidden by the switch", async () => {
    await saveTigs([tig(1, DAY)]);
    expect((await readTigs()).map((t) => t.id)).toEqual([1]);
    expect(await shownTigs()).toHaveLength(1);
    await chrome.storage.local.set({ CALENDAR_SHOW_TIG: false });
    expect(await shownTigs()).toEqual([]);
  });

  it("never travels with cloud sync", async () => {
    const { CLOUD_SYNC_KEYS } = await import("../src/core/config/keys");
    expect(CLOUD_SYNC_KEYS).not.toContain("CALENDAR_TIGS");
  });
});

describe("the calendar feed", () => {
  it("writes a TIG with its own UID, its end and a reminder the day before", () => {
    const one = tig(42, DAY, { note: "sweep; the cluster" });
    const ics = generateIcs(tigEvents([one]));
    expect(ics).toContain("UID:tig-42@better-intra");
    expect(ics).toContain("SUMMARY:TIG: sweep\\; the cluster");
    expect(ics).toContain("TRIGGER:-P1D");
    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).toContain("URL:https://profile.intra.42.fr/");
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    expect(ics).toContain(`DTEND:${stamp(Date.parse(one.begin_at) + 2 * HOUR)}`);
  });

  it("leaves the other entries with their single reminder", () => {
    const ics = generateIcs([
      { id: 1, name: "Talk", kind: "conference", begin_at: "2026-12-01T10:00:00Z", end_at: "2026-12-01T11:00:00Z" },
    ]);
    expect(ics).not.toContain("TRIGGER:-P1D");
    expect(ics).toContain("UID:1@better-intra");
  });
});

describe("the Agenda", () => {
  it("adds the link once and one line per TIG to come, under the header", async () => {
    agenda();
    await saveTigs([tig(1, -3 * DAY), tig(2, DAY, { note: "kitchen" })]);
    await initTigAgenda();
    await initTigAgenda();
    const link = document.querySelectorAll("#ft-tig-add");
    expect(link).toHaveLength(1);
    expect(link[0].textContent).toBe("Add a TIG");
    expect(link[0].parentElement!.id).toBe("head");
    const box = document.getElementById("ft-tig-list")!;
    expect(box.previousElementSibling!.id).toBe("head");
    expect(box.children).toHaveLength(1);
    expect(box.textContent).toContain("kitchen");
    expect(box.textContent).toContain(tigSoon(tig(2, DAY)));
  });

  it("draws nothing with the switch off, on another profile or without an Agenda", async () => {
    await saveTigs([tig(1, DAY)]);
    await initTigAgenda();
    expect(document.getElementById("ft-tig-add")).toBeNull();

    agenda();
    await initTigAgenda();
    expect(document.getElementById("ft-tig-list")).not.toBeNull();
    await chrome.storage.local.set({ CALENDAR_SHOW_TIG: false });
    await initTigAgenda();
    expect(document.getElementById("ft-tig-add")).toBeNull();
    expect(document.getElementById("ft-tig-list")).toBeNull();
  });

  it("says Today or Tomorrow, and nothing further away", () => {
    const now = new Date(2026, 10, 27, 23, 0).getTime();
    const at = (y: number, m: number, d: number, h: number): Tig => ({
      id: 1,
      begin_at: new Date(y, m, d, h).toISOString(),
      hours: 2,
      note: "",
    });
    expect(tigSoon(at(2026, 10, 27, 23), now)).toBe("Today");
    expect(tigSoon(at(2026, 10, 28, 1), now)).toBe("Tomorrow");
    expect(tigSoon(at(2026, 10, 29, 1), now)).toBe("");
  });
});

describe("the dialog", () => {
  const root = () => document.getElementById("ft-tig-dialog")!.firstElementChild!.shadowRoot!;
  const fill = (name: string, value: string) => {
    (root().querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
  };
  const submit = () =>
    root().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

  it("adds a TIG, draws it in the Agenda and refreshes the feed", async () => {
    agenda();
    await openTigDialog();
    expect(root().textContent).toContain("No TIG planned.");
    const day = new Date(Date.now() + 2 * DAY);
    const pad = (n: number) => String(n).padStart(2, "0");
    fill("date", `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`);
    fill("time", "14:00");
    fill("hours", "3");
    fill("note", "library");
    submit();
    await settle();
    const stored = await readTigs();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ hours: 3, note: "library" });
    expect(root().textContent).toContain("library");
    expect(document.getElementById("ft-tig-list")!.textContent).toContain("library");
    expect(sync.maybeSyncCalendar).toHaveBeenCalledTimes(1);
  });

  it("refuses a form without a date and deletes a TIG", async () => {
    agenda();
    await saveTigs([tig(9, DAY, { note: "old" })]);
    await openTigDialog();
    fill("time", "14:00");
    submit();
    await settle();
    expect(root().querySelector('[role="alert"]')!.textContent).toContain("Pick a date");
    expect(await readTigs()).toHaveLength(1);

    const del = [...root().querySelectorAll("button")].find((b) => b.textContent!.trim() === "Delete")!;
    del.click();
    await settle();
    expect(await readTigs()).toEqual([]);
    expect(document.getElementById("ft-tig-list")).toBeNull();
  });
});
