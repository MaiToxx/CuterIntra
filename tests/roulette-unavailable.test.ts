/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The Thursday Roulette card never shows numbers it did not fetch: signed out
 * (oauth mode), a worker error, or an Intra v2 page that could not be read.
 * In intra mode the stats need no cloud session at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROFILE_STATS_CACHE_KEY } from "../src/features/profile/cards/profile-stats-intra.ts";

interface Setup {
  authMode: "oauth" | "intra";
  cloudLogin: string | null;
  cloudToken: string;
}

async function loadRoulette(setup: Setup) {
  vi.resetModules();
  vi.doMock("../src/core/config.ts", () => ({
    getConfig: vi.fn(async (key: string) => {
      if (key === "PROFILE_SHOW_ROULETTE" || key === "PROFILE_SHOW_ROULETTE_HISTORY") return true;
      if (key === "CLOUD_TOKEN") return setup.cloudToken;
      return "";
    }),
  }));
  vi.doMock("../src/features/account/account.ts", () => ({
    getCloudLogin: vi.fn(async () => setup.cloudLogin),
  }));
  vi.doMock("../src/core/crypto.ts", () => ({
    hashLogin: vi.fn(async () => "hashed"),
  }));
  vi.doMock("../src/core/worker.ts", () => ({
    WORKER_URL: "https://api.betterintra.com",
    AUTH_MODE: setup.authMode,
  }));
  return (await import("../src/features/profile/cards/roulette-stats.ts")).initRouletteStats;
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the page body with this fixture (parsed, never assigned as HTML). */
const mount = (markup: string) =>
  document.body.replaceChildren(
    ...new DOMParser().parseFromString(markup, "text/html").body.childNodes,
  );

/** The value shown next to a counter label ("Wins", "Points"). */
function counter(card: HTMLElement, label: string): string | null {
  const labelEl = [...card.querySelectorAll("span")].find((s) => s.textContent === label);
  return labelEl?.nextElementSibling?.textContent ?? null;
}

// ------------------------------------------------------------------ Intra v2 pages
const feedbackItem = (date: string, mark: number) => `
<li class="table-item scaleteam-list-item">
  <div class="header">evaluated someone scheduled on <b>${date}</b></div>
  <div class="final-mark"><div class="rating" ${mark >= 50 ? "data-positive" : ""}>${mark} %</div></div>
</li>`;
const feedbacksPage = (items: string, lastPage: number) =>
  `<html><body><ul>${items}</ul><div class="pagination">${
    lastPage > 1 ? `<a href="/users/x/feedbacks?as=corrector&amp;page=${lastPage}">${lastPage}</a>` : ""
  }</div></body></html>`;
const historicsPage = `<div class="changelogs-list"><div class="changelog-item"><div class="changelog-main">
  <p class="title"><code data-count="12" data-date="2026-09-11 06:00:00 UTC">+3</code> <span class="reason"> Thursday Roulette </span></p>
</div></div></div>`;

/** Serves the Intra v2 pages the background would fetch; `fail` lists URL fragments that fail. */
function mockIntraPages(fail: string[] = []) {
  const sendMessage = vi.fn(async (msg: { type: string; url: string }) => {
    if (fail.some((f) => msg.url.includes(f))) return { ok: false, status: 504 };
    if (msg.url.includes("correction_point_historics")) return { ok: true, text: historicsPage };
    if (msg.url.includes("page=1")) {
      return { ok: true, text: feedbacksPage(feedbackItem("September 13, 2026 14:30", 80), 2) };
    }
    if (msg.url.includes("page=2")) {
      return { ok: true, text: feedbacksPage(feedbackItem("August 30, 2026 09:00", 20), 2) };
    }
    return { ok: false };
  });
  (globalThis as any).chrome.runtime = { sendMessage };
  return sendMessage;
}

async function cachedLogins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(PROFILE_STATS_CACHE_KEY);
  return Object.keys((stored[PROFILE_STATS_CACHE_KEY] as object | undefined) ?? {});
}

describe("roulette card: nothing shown that was not fetched", () => {
  beforeEach(async () => {
    history.replaceState({}, "", "/");
    mount(
      '<div class="dash-main"><div class="bg-white md:h-96">' +
        '<span class="font-bold uppercase text-sm">Agenda</span></div></div>',
    );
    await chrome.storage.local.clear();
  });
  afterEach(() => {
    delete (globalThis as any).chrome.runtime;
    vi.unstubAllGlobals();
  });

  it("oauth, signed out: no card of zeros on someone else's profile", async () => {
    history.replaceState({}, "", "/users/bob");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const initRouletteStats = await loadRoulette({ authMode: "oauth", cloudLogin: null, cloudToken: "" });
    await initRouletteStats();
    await settle();

    expect(document.getElementById("ft-roulette-card")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("oauth, the worker fails: dashes and a note instead of 0 wins / 0 points", async () => {
    history.replaceState({}, "", "/users/bob");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const initRouletteStats = await loadRoulette({ authMode: "oauth", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle();

    const card = document.getElementById("ft-roulette-card")!;
    expect(card).not.toBeNull();
    expect(counter(card, "Wins")).toBe("—");
    expect(counter(card, "Points")).toBe("—");
    expect(card.textContent).toContain("Couldn't load roulette history");
  });

  it("intra mode, signed out: your own profile gets the card from the page login", async () => {
    const own = document.createElement("span");
    own.setAttribute("data-login", "");
    own.textContent = "me";
    document.body.prepend(own);
    const sendMessage = mockIntraPages();

    const initRouletteStats = await loadRoulette({ authMode: "intra", cloudLogin: null, cloudToken: "" });
    await initRouletteStats();
    await settle();

    const card = document.getElementById("ft-roulette-card")!;
    expect(card, "no cloud session needed in intra mode").not.toBeNull();
    expect(sendMessage.mock.calls.every((c) => c[0].url.includes("/users/me/"))).toBe(true);
    expect(counter(card, "Wins")).toBe("1");
    expect(counter(card, "Points")).toBe("3");
    expect(await cachedLogins()).toEqual(["me"]);
  });

  it("intra mode, the history page fails: dashes, and nothing cached for an hour", async () => {
    history.replaceState({}, "", "/users/bob");
    mockIntraPages(["correction_point_historics"]);

    const initRouletteStats = await loadRoulette({ authMode: "intra", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle();

    const card = document.getElementById("ft-roulette-card")!;
    expect(counter(card, "Wins")).toBe("—");
    expect(counter(card, "Points")).toBe("—");
    expect(card.textContent).toContain("Couldn't load roulette history");
    // the correction stats did load, and are still shown
    expect(card.textContent).toContain("Evaluations as Corrector");
    expect(await cachedLogins()).toEqual([]);
  });

  it("intra mode, a later feedback page fails: no partial total, nothing cached", async () => {
    history.replaceState({}, "", "/users/bob");
    mockIntraPages(["page=2"]);

    const initRouletteStats = await loadRoulette({ authMode: "intra", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle();

    const card = document.getElementById("ft-roulette-card")!;
    expect(counter(card, "Wins")).toBe("1");
    expect(card.textContent).not.toContain("Evaluations as Corrector");
    expect(await cachedLogins()).toEqual([]);
  });

  it("intra mode, more feedback pages than the cap: no stats, but remembered instead of read again", async () => {
    history.replaceState({}, "", "/users/bob");
    const sendMessage = vi.fn(async (msg: { type: string; url: string }) => {
      if (msg.url.includes("correction_point_historics")) return { ok: true, text: historicsPage };
      return { ok: true, text: feedbacksPage(feedbackItem("September 13, 2026 14:30", 80), 55) };
    });
    (globalThis as any).chrome.runtime = { sendMessage };

    let initRouletteStats = await loadRoulette({ authMode: "intra", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle(200);
    const card = document.getElementById("ft-roulette-card")!;
    expect(counter(card, "Wins")).toBe("1");
    expect(card.textContent).not.toContain("Evaluations as Corrector");
    // 40 feedback pages and the history
    expect(sendMessage).toHaveBeenCalledTimes(41);
    expect(await cachedLogins()).toEqual(["bob"]);

    // the next visit within the hour reads nothing
    card.remove();
    initRouletteStats = await loadRoulette({ authMode: "intra", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(41);
    expect(counter(document.getElementById("ft-roulette-card")!, "Wins")).toBe("1");
  });

  it("colours failed counts and low success months in the corrector table", async () => {
    history.replaceState({}, "", "/users/bob");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          roulette: { entries: [] },
          evalStats: {
            byMonth: {
              "2026-09": { total: 4, failed: 1, successPercentage: 75 },
              "2026-08": { total: 5, failed: 0, successPercentage: 100 },
            },
            global: { total: 9, failed: 1, successPercentage: 88.9 },
          },
        }),
      })),
    );

    const initRouletteStats = await loadRoulette({ authMode: "oauth", cloudLogin: "me", cloudToken: "token" });
    await initRouletteStats();
    await settle();

    const card = document.getElementById("ft-roulette-card")!;
    // a real empty history is a real zero
    expect(counter(card, "Wins")).toBe("0");
    const rows = [...card.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")]);
    const [sept, aug] = rows;
    expect(sept[2].style.color).toBe("rgb(239, 68, 68)");
    expect(sept[3].style.color).toBe("rgb(239, 68, 68)");
    expect(aug[2].style.color).toBe("inherit");
    expect(aug[3].style.color).toBe("rgb(34, 197, 94)");
  });
});
