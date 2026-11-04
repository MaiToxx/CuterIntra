/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * "Load older months" in the shipped "intra" build, against a worker whose 42
 * application is configured (/api/v1/public/features says logtimeHistory).
 * The worker only serves your own history, so the card is offered on your
 * own profile only, signed in, and the request carries your session.
 * A file of its own: the features answer is read once per page.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { hashLogin } from "../src/core/crypto";

vi.mock("../src/core/worker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
  return { ...actual, AUTH_MODE: "intra" };
});
vi.mock("../src/features/calendar/calendar-sync.ts", () => ({
  syncCalendarIcs: vi.fn(async () => {}),
}));

import { initLogtime } from "../src/features/logtime/logtime";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
};

const root = (): ShadowRoot => document.getElementById("logtime-shadow-wrapper")!.shadowRoot!;
const loadMoreCard = () =>
  [...root().querySelectorAll<HTMLElement>(".month-card")].find((c) =>
    (c.textContent || "").includes("Load older months"),
  );

async function visit(path: string) {
  history.pushState({}, "", path);
  document.dispatchEvent(
    new CustomEvent("42_LOGTIME_DATA", {
      detail: { "2026-08-03": "02:00:00", "2026-09-20": "03:00:00" },
    }),
  );
  await flush();
}

const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (String(url).includes("/api/v1/public/features")) {
    return new Response(JSON.stringify({ features: { logtimeHistory: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (String(url).includes("/logtime/history")) {
    return new Response(JSON.stringify({ days: { "2026-07-01": 3600 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 404 });
});

beforeAll(async () => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as any).fetch = fetchMock;
  const grid = document.createElement("div");
  const card = document.createElement("div");
  card.className = "bg-white md:h-96";
  card.textContent = "LOGTIME";
  grid.appendChild(card);
  document.body.appendChild(grid);
  await chrome.storage.local.set({ LOGTIME_CALENDAR_VIEW: "normal" });
  await initLogtime();
});

beforeEach(async () => {
  await chrome.storage.local.remove(["CLOUD_LOGIN", "CLOUD_TOKEN"]);
  fetchMock.mockClear();
});

describe("Load older months, intra build, worker with the 42 application", () => {
  it("is not offered signed out", async () => {
    await visit("/");
    expect(loadMoreCard()).toBeUndefined();
  });

  it("is not offered on another student's profile", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/users/bob");
    expect(loadMoreCard()).toBeUndefined();
  });

  it("is offered on your own profile and loads your history with your session", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/");
    const card = loadMoreCard();
    expect(card).toBeDefined();

    card!.click();
    await flush();
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/logtime/history"));
    expect(call).toBeDefined();
    const url = new URL(String(call![0]));
    expect(url.searchParams.get("user")).toBe("me");
    expect(url.searchParams.get("login")).toBe(await hashLogin("me"));
    expect((call![1]!.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(root().querySelector('[data-month="2026-07"]')).not.toBeNull();
    expect(loadMoreCard()).toBeUndefined();
  });
});
