/**
 * Your own evaluations from the worker's 42 application (evaluations-api.ts)
 * and what the calendar feed makes of them (calendar-sync.ts).
 *
 * The worker answers only your own login, signed in, when /features announces
 * `evaluations`; every other case is null, so the callers keep what they did
 * before (the v2 feedback pages, a feed of events alone).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/core/worker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
  return { ...actual, AUTH_MODE: "intra" };
});

import { resetWorkerFeatures } from "../src/core/worker";
import {
  fetchCorrectionPoints,
  fetchOwnCoalitions,
  fetchOwnEvaluationStats,
  fetchUpcomingEvaluations,
} from "../src/features/profile/cards/evaluations-api";
import { evaluationEvents, generateIcs } from "../src/features/calendar/calendar-sync";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ALL = { evaluations: true, correctionPoints: true, coalitions: true };
let features: Record<string, boolean> = { ...ALL };
const STATS = {
  stats: {
    byMonth: { "2026-10": { total: 3, failed: 1, successPercentage: 66.7 } },
    global: { total: 3, failed: 1, successPercentage: 66.7 },
  },
  outstanding: { received: 2, given: 1 },
};
const UPCOMING = {
  upcoming: [
    { id: 7, beginAt: "2026-11-05T09:00:00.000Z", endAt: "2026-11-05T09:15:00.000Z", role: "corrector", project: "libft" },
    { id: 8, beginAt: "2026-11-06T14:00:00.000Z", endAt: "2026-11-06T14:30:00.000Z", role: "corrected", project: null },
    { id: "bad" },
  ],
};

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.includes("/api/v1/public/features")) return json({ features });
  if (u.includes("part=stats")) return json(STATS);
  if (u.includes("part=upcoming")) return json(UPCOMING);
  if (u.includes("part=points")) return json({ points: [{ at: "2026-11-01T10:00:00.000Z", total: 8 }, { at: "bad", total: 1 }] });
  if (u.includes("/api/v1/private/coalitions")) {
    return json({
      blocs: [
        {
          id: 136,
          cursusId: 9,
          coalitions: [
            { id: 612, name: "Decepticons", score: 10954, color: "#E70200", imageUrl: "https://evil.example/x.svg", mine: true },
            { id: 613, name: "Autobot", score: 9257, color: "blue", imageUrl: "https://cdn.intra.42.fr/a.svg" },
          ],
        },
        { id: 1, coalitions: [] },
      ],
    });
  }
  return json({}, 404);
});

beforeEach(async () => {
  resetWorkerFeatures();
  features = { ...ALL };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ CLOUD_LOGIN: "alepayen", CLOUD_TOKEN: "sess" });
});

describe("fetchOwnEvaluationStats", () => {
  it("reads your stats and Outstanding counts with your session", async () => {
    expect(await fetchOwnEvaluationStats("AlePayen")).toEqual(STATS);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("part=stats"))!;
    const url = new URL(String(call[0]));
    expect(url.pathname).toBe("/api/v1/private/evaluations");
    expect(url.searchParams.get("user")).toBe("alepayen");
    expect(url.searchParams.get("login")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is null for another student's profile, without asking the worker", async () => {
    expect(await fetchOwnEvaluationStats("someoneelse")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null signed out", async () => {
    await chrome.storage.local.remove("CLOUD_TOKEN");
    expect(await fetchOwnEvaluationStats("alepayen")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null when the worker does not announce the route", async () => {
    features = { logtimeHistory: true };
    expect(await fetchOwnEvaluationStats("alepayen")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/evaluations"))).toBe(false);
  });
});

describe("fetchUpcomingEvaluations and the feed", () => {
  it("keeps the well-formed entries", async () => {
    const list = await fetchUpcomingEvaluations();
    expect(list?.map((e) => e.id)).toEqual([7, 8]);
  });

  it("turns them into feed entries with their own UIDs and a reminder", async () => {
    const list = (await fetchUpcomingEvaluations())!;
    const ics = generateIcs(evaluationEvents(list), new Date("2026-11-04T12:00:00Z"));
    expect(ics).toContain("UID:eval-7@better-intra");
    expect(ics).toContain("SUMMARY:Evaluation: you evaluate libft");
    expect(ics).toContain("SUMMARY:Evaluation: you are evaluated on your project");
    expect(ics).toContain("DTSTART:20261105T090000Z");
    expect(ics).toContain("DTEND:20261106T143000Z");
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
  });
});

describe("fetchCorrectionPoints and fetchOwnCoalitions", () => {
  it("keep the well-formed points", async () => {
    expect(await fetchCorrectionPoints()).toEqual([{ at: "2026-11-01T10:00:00.000Z", total: 8 }]);
  });

  it("keep Intra CDN images and hex colours only, and drop empty blocs", async () => {
    expect(await fetchOwnCoalitions()).toEqual([
      {
        id: 136,
        cursusId: 9,
        coalitions: [
          { id: 612, name: "Decepticons", score: 10954, color: "#E70200", imageUrl: null, mine: true },
          { id: 613, name: "Autobot", score: 9257, color: null, imageUrl: "https://cdn.intra.42.fr/a.svg", mine: false },
        ],
      },
    ]);
  });

  it("are null when the worker does not announce them", async () => {
    features = { evaluations: true };
    expect(await fetchCorrectionPoints()).toBeNull();
    expect(await fetchOwnCoalitions()).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => /points|coalitions/.test(String(u)))).toBe(false);
  });
});
