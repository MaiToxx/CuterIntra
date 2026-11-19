/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The calendar is drawn before the worker says whether "Load older months"
 * can be served. The first render used to await /api/v1/public/features (5 s
 * when the worker is slow): the widget stayed blank meanwhile, and the answer
 * was then drawn on whatever profile the student had opened by then.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("../src/core/worker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
  return { ...actual, AUTH_MODE: "intra" };
});
vi.mock("../src/features/calendar/calendar-sync.ts", () => ({
  syncCalendarIcs: vi.fn(async () => {}),
}));

import { initLogtime } from "../src/features/logtime/logtime";
import { resetWorkerFeatures } from "../src/core/worker";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
};
const root = (): ShadowRoot => document.getElementById("logtime-shadow-wrapper")!.shadowRoot!;
const monthCards = () => [...root().querySelectorAll<HTMLElement>(".month-card")];
const loadMoreCard = () =>
  monthCards().find((c) => (c.textContent || "").includes("Load older months"));

let answerFeatures: () => void = () => {};

async function visit(path: string) {
  history.pushState({}, "", path);
  document.dispatchEvent(
    new CustomEvent("42_LOGTIME_DATA", {
      detail: { "2026-08-03": "02:00:00", "2026-09-20": "03:00:00" },
    }),
  );
  await flush();
}

beforeAll(async () => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/api/v1/public/features")) {
      await new Promise<void>((resolve) => (answerFeatures = resolve));
      return new Response(JSON.stringify({ features: { logtimeHistory: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  const grid = document.createElement("div");
  const card = document.createElement("div");
  card.className = "bg-white md:h-96";
  card.textContent = "LOGTIME";
  grid.appendChild(card);
  document.body.appendChild(grid);
  await chrome.storage.local.set({
    LOGTIME_CALENDAR_VIEW: "normal",
    CLOUD_LOGIN: "me",
    CLOUD_TOKEN: "t",
  });
  await initLogtime();
});

describe("the calendar and a slow worker", () => {
  it("draws the months at once, and adds the card when the worker answers", async () => {
    await visit("/");
    expect(monthCards().length).toBeGreaterThan(0);
    expect(loadMoreCard()).toBeUndefined();

    answerFeatures();
    await flush();
    expect(loadMoreCard()).toBeDefined();
  });

  it("drops the answer when another profile was opened meanwhile", async () => {
    resetWorkerFeatures();
    await visit("/");
    await visit("/users/bob");
    answerFeatures();
    await flush();
    expect(monthCards().length).toBeGreaterThan(0);
    expect(loadMoreCard()).toBeUndefined();
  });
});
