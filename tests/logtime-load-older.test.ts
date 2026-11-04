/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * "Load older months" asks the worker for the history, and the worker reads it
 * from the 42 API with its 42 application. A worker without one (here: its
 * /api/v1/public/features answers 404), and a signed-out user who never even
 * reaches the worker: in both cases the card was offered anyway, spun a
 * spinner, then vanished without adding a month. It is only offered where it
 * can answer: an "oauth" build, signed in, or an "intra" build whose worker
 * says it serves the history (tests/logtime-load-older-worker.test.ts).
 *
 * One module instance for the whole file (the data listener logtime.ts puts
 * on `document` cannot be removed); AUTH_MODE is switched through the mock.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const mode = vi.hoisted(() => ({ value: "oauth" as "oauth" | "intra" }));

vi.mock("../src/core/worker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
  return {
    ...actual,
    get AUTH_MODE() {
      return mode.value;
    },
  };
});
vi.mock("../src/features/calendar/calendar-sync.ts", () => ({
  syncCalendarIcs: vi.fn(async () => {}),
}));

import { initLogtime } from "../src/features/logtime/logtime";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
};

function root(): ShadowRoot {
  return document.getElementById("logtime-shadow-wrapper")!.shadowRoot!;
}

function hasLoadMoreCard(): boolean {
  return (root().textContent || "").includes("Load older months");
}

/** A profile visit: navigate, then the page's locations_stats payload. */
async function visit(path: string) {
  history.pushState({}, "", path);
  document.dispatchEvent(
    new CustomEvent("42_LOGTIME_DATA", {
      detail: { "2026-08-03": "02:00:00", "2026-09-20": "03:00:00" },
    }),
  );
  await flush();
}

const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes("/logtime/history")) {
    return new Response(JSON.stringify({ days: { "2026-07-01": 3600 } }), {
      status: 200,
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
});

describe("Load older months, intra build, worker without the 42 application", () => {
  beforeEach(() => {
    mode.value = "intra";
  });

  it("is not offered on your own profile, even signed in", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/");
    expect(root().querySelectorAll(".month-card").length).toBeGreaterThan(0);
    expect(hasLoadMoreCard()).toBe(false);
  });

  it("is not offered on another profile, signed in or not", async () => {
    await visit("/users/bob");
    expect(hasLoadMoreCard()).toBe(false);
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/users/carol");
    expect(hasLoadMoreCard()).toBe(false);
  });

  it("leaves the carousel's first arrow disabled", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/users/bob");
    await switchView("Carousel");
    try {
      // September is shown first: go back to August, the oldest month
      root().querySelector<HTMLButtonElement>(".lt-carousel-arrow")!.click();
      await flush();
      const first = root().querySelector<HTMLButtonElement>(".lt-carousel-arrow")!;
      expect(first.disabled).toBe(true);
      expect(first.dataset.tip).toBe("");
    } finally {
      await switchView("Normal");
    }
  });
});

describe("Load older months, oauth build", () => {
  beforeEach(() => {
    mode.value = "oauth";
  });

  it("is not offered to a signed-out visitor", async () => {
    await visit("/users/dave");
    expect(hasLoadMoreCard()).toBe(false);
  });

  it("is offered on another profile when signed in", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/users/erin");
    expect(hasLoadMoreCard()).toBe(true);
  });

  it("is offered on your own profile when signed in", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/");
    expect(hasLoadMoreCard()).toBe(true);
  });

  it("does not carry one profile's card over to the next one", async () => {
    await chrome.storage.local.set({ CLOUD_LOGIN: "me", CLOUD_TOKEN: "t" });
    await visit("/users/frank");
    expect(hasLoadMoreCard()).toBe(true);
    await chrome.storage.local.remove(["CLOUD_LOGIN", "CLOUD_TOKEN"]);
    await visit("/users/grace");
    expect(hasLoadMoreCard()).toBe(false);
  });
});

/** Clicks the view switcher, as a student would (it also stores the view). */
async function switchView(label: string) {
  const btn = [
    ...root().querySelectorAll<HTMLButtonElement>(".lt-view-join button"),
  ].find((b) => b.dataset.tip === label);
  if (!btn) throw new Error(`no ${label} button`);
  btn.click();
  await flush();
}
