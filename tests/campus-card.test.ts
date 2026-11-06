/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The dashboard's Campus card (cards/campus.ts): the next exam from your Intra
 * events, your coalitions and correction points from the worker, each section
 * left out when it has nothing to show.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CalendarEvent } from "../src/features/logtime/types";

const events = vi.fn<() => Promise<CalendarEvent[] | null>>();
const coalitions = vi.fn();
const points = vi.fn();

vi.mock("../src/features/calendar/own-events.ts", () => ({
  fetchOwnEvents: () => events(),
  isOwnProfilePage: () => location.pathname === "/",
}));
vi.mock("../src/features/profile/cards/evaluations-api.ts", () => ({
  fetchOwnCoalitions: () => coalitions(),
  fetchCorrectionPoints: () => points(),
}));

import {
  CAMPUS_CARD_ID,
  graphPoints,
  initCampusCard,
  nextExam,
  resetCampusCard,
  untilText,
} from "../src/features/profile/cards/campus";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const exam = (id: number, begin: string, is_subscribed: boolean): CalendarEvent => ({
  id,
  name: `Exam ${id}`,
  kind: "exam",
  begin_at: begin,
  end_at: new Date(Date.parse(begin) + 3 * 3_600_000).toISOString(),
  location: "k2",
  is_subscribed,
});

const BLOCS = [
  {
    id: 136,
    cursusId: 9,
    coalitions: [
      { id: 612, name: "Decepticons", score: 10954, color: "#E70200", imageUrl: null, mine: true },
      { id: 613, name: "Autobot", score: 9257, color: "#015AED", imageUrl: "https://cdn.intra.42.fr/a.svg", mine: false },
    ],
  },
];
const POINTS = [
  { at: "2026-06-01T10:00:00.000Z", total: 5 },
  { at: "2026-10-01T10:00:00.000Z", total: 3 },
  { at: "2026-11-01T10:00:00.000Z", total: 8 },
];

describe("helpers", () => {
  it("picks the exam you are registered for, else the earliest, skipping ended ones and events", () => {
    const list = [
      exam(1, "2026-11-01T08:00:00Z", true),
      exam(2, "2026-11-12T14:00:00Z", false),
      exam(3, "2026-11-19T14:00:00Z", true),
      { ...exam(4, "2026-11-07T14:00:00Z", true), kind: "event" },
    ];
    expect(nextExam(list, NOW)?.id).toBe(3);
    expect(nextExam(list.slice(0, 2), NOW)?.id).toBe(2);
    expect(nextExam([], NOW)).toBeNull();
  });

  it("says how long until the exam", () => {
    expect(untilText(NOW + (3 * 24 + 4) * 3_600_000 + 60_000, NOW)).toBe("In 3 d 4 h");
    expect(untilText(NOW + 2 * 3_600_000 + 5 * 60_000, NOW)).toBe("In 2 h 5 min");
    expect(untilText(NOW + 10_000, NOW)).toBe("In 1 min");
    expect(untilText(NOW - 1, NOW)).toBe("Now");
  });

  it("keeps 90 days of points, starting from the balance before them", () => {
    expect(graphPoints(POINTS, NOW)).toEqual([
      { at: new Date(NOW - 90 * 86_400_000).toISOString(), total: 5 },
      POINTS[1],
      POINTS[2],
    ]);
  });
});

describe("initCampusCard", () => {
  beforeEach(async () => {
    resetCampusCard();
    document.body.innerHTML = `
      <div class="flex flex-col lg:flex-row gap-6 md:gap-8">
        <div id="profile-card"></div>
      </div>`;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ CLOUD_LOGIN: "alepayen", CLOUD_TOKEN: "sess" });
    events.mockReset().mockResolvedValue([exam(7, new Date(Date.now() + 86_400_000).toISOString(), true)]);
    coalitions.mockReset().mockResolvedValue(BLOCS);
    points.mockReset().mockResolvedValue(POINTS);
  });

  it("draws the three sections after the profile card, texts as text", async () => {
    coalitions.mockResolvedValue([
      { ...BLOCS[0], coalitions: [{ ...BLOCS[0].coalitions[0], name: "<img src=x onerror=alert(1)>" }] },
    ]);
    await initCampusCard();
    const card = document.getElementById(CAMPUS_CARD_ID)!;
    expect(card.previousElementSibling?.id).toBe("profile-card");
    expect([...card.querySelectorAll<HTMLElement>("[data-section]")].map((s) => s.dataset.section)).toEqual([
      "exam",
      "coalitions",
      "points",
    ]);
    expect(card.querySelector("a")?.getAttribute("href")).toBe("https://profile.intra.42.fr/exams/7");
    expect(card.textContent).toContain("Registered");
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.querySelectorAll("img")).toHaveLength(0);
    expect(card.querySelector("svg path")?.getAttribute("d")).toMatch(/^M0,/);
  });

  it("keeps the worker's answers 30 minutes in local storage", async () => {
    await initCampusCard();
    resetCampusCard();
    document.getElementById(CAMPUS_CARD_ID)!.remove();
    await initCampusCard();
    expect(coalitions).toHaveBeenCalledTimes(1);
    expect(points).toHaveBeenCalledTimes(1);
    expect(document.getElementById(CAMPUS_CARD_ID)).not.toBeNull();
  });

  it("shows the exam alone when the worker has nothing, and no card at all without anything", async () => {
    coalitions.mockResolvedValue(null);
    points.mockResolvedValue(null);
    await initCampusCard();
    const card = document.getElementById(CAMPUS_CARD_ID)!;
    expect([...card.querySelectorAll<HTMLElement>("[data-section]")].map((s) => s.dataset.section)).toEqual(["exam"]);

    card.remove();
    resetCampusCard();
    events.mockResolvedValue([]);
    await initCampusCard();
    expect(document.getElementById(CAMPUS_CARD_ID)).toBeNull();
  });

  it("stays away when switched off", async () => {
    await chrome.storage.local.set({ PROFILE_SHOW_CAMPUS: false });
    await initCampusCard();
    expect(document.getElementById(CAMPUS_CARD_ID)).toBeNull();
    expect(events).not.toHaveBeenCalled();
  });
});
