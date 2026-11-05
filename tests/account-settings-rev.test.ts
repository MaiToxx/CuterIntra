/**
 * The settings revision (worker contract C1) and the worker's error codes
 * (C5), on the extension's side.
 *
 * A full push names the revision this browser last pulled or pushed
 * (baseRev): a browser that never saw another one's push used to put back
 * its whole local state, friends list and public avatar included. The
 * worker answers 409 "conflict" and writes nothing; the popup and the hub
 * offer Pull or Push anyway. The few-key pushes send it too, only so that
 * the answer carries the new revision: without it, this browser's next full
 * push was refused over its own write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every step a microtask (see account-popup.test.ts).
vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));
const dialog = vi.hoisted(() => ({ answer: vi.fn(async () => false) }));
vi.mock("../src/core/dom/confirm-dialog.ts", () => ({ showConfirmDialog: dialog.answer }));
vi.mock("../src/core/intra/intrapy.ts", () => ({
  waitForIntrapyToken: async () => "Bearer intra-jwt",
  getStoredIntrapyToken: () => null,
  isJwtExpired: () => false,
}));

import {
  describeCloudFailure,
  getPushFailure,
  logoutCloud,
  maybePromptRestore,
  pullSettings,
  pushPartial,
  pushSettings,
  syncToCloud,
  wipeAllCloudData,
  PUSH_FAILURE_KEY,
} from "../src/features/account/account.ts";
import { createHandlers } from "../src/features/account/handlers.ts";
import { createInitialState } from "../src/features/account/state.ts";
import { loginWithIntraSession } from "../src/features/account/intra-login.ts";
import { workerErrorText } from "../src/core/worker.ts";
import { setLang } from "../src/core/i18n/i18n.ts";

type Call = { method: string; path: string; search: string; body: any };
const calls: Call[] = [];
let reply: (call: Call) => Response = () => new Response("Saved", { status: 200 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const conflict = (rev: number) =>
  json({ error: "conflict", message: "Settings changed in another browser", rev }, 409);
const posts = () => calls.filter((c) => c.method === "POST");
const storedRev = async () =>
  (await chrome.storage.local.get("CLOUD_SETTINGS_REV")).CLOUD_SETTINGS_REV;

beforeEach(async () => {
  calls.length = 0;
  reply = () => new Response("Saved", { status: 200 });
  dialog.answer.mockReset();
  dialog.answer.mockResolvedValue(false);
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ CLOUD_TOKEN: "sess", CLOUD_LOGIN: "alice" });
  (globalThis as any).chrome.tabs = { query: vi.fn(async () => []) };
  (globalThis as any).fetch = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      search: url.search,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return reply(call);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("full push", () => {
  it("never knew a revision (updated from 1.17.1): pushes without baseRev, then keeps the one answered", async () => {
    // sending 0 made every student's first push after the update a conflict
    reply = () => json({ ok: true, rev: 1000 });
    await expect(pushSettings()).resolves.toBe("ok");
    expect(posts()[0].body).not.toHaveProperty("baseRev");
    expect(posts()[0].body.settings).toHaveProperty("FRIENDS_LIST");
    expect(await storedRev()).toBe(1000);
    await pushSettings();
    expect(posts()[1].body.baseRev).toBe(1000);
  });

  it("a no-op answered with an older revision (a stale read of its own write) never steps back", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 2000 });
    reply = () => json({ ok: true, rev: 1500 });
    await pushSettings();
    expect(await storedRev()).toBe(2000);
  });

  it("a worker without revisions answers 'Saved': nothing changes", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 7 });
    await expect(pushSettings()).resolves.toBe("ok");
    expect(await storedRev()).toBe(7);
  });

  it("a conflict writes nothing, is recorded, and is not retried by the automatic pushes", async () => {
    vi.useFakeTimers();
    reply = () => conflict(5000);
    await expect(syncToCloud()).resolves.toBe(false);
    await expect(getPushFailure()).resolves.toMatchObject({ reason: "conflict" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts()).toHaveLength(1);
    expect(await storedRev()).toBeUndefined();
    // a friend added meanwhile would be refused the same way: not even asked
    await expect(syncToCloud()).resolves.toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it("Push anyway sends no baseRev, then asks for the revision it wrote", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 10 });
    reply = (c) =>
      c.method === "POST"
        ? new Response("Saved", { status: 200 })
        : json({ activeSessions: 2, discordId: null, rev: 9000 });
    await expect(pushSettings({ force: true })).resolves.toBe("ok");
    expect(posts()[0].body).not.toHaveProperty("baseRev");
    expect(calls[1]).toMatchObject({ method: "GET", search: expect.stringContaining("fields=meta") });
    expect(await storedRev()).toBe(9000);
  });

  it("the day's write budget and a busy KV get their own reasons; only the busy one is retried", async () => {
    // Midday UTC: an hour later is still the same UTC day. With the real clock the
    // test failed between 23:00 and 24:00 UTC (the v1.20.0 release run).
    vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00Z") });
    reply = () => json({ error: "daily_write_budget", message: "Daily write budget spent" }, 503);
    await expect(syncToCloud()).resolves.toBe(false);
    await expect(getPushFailure()).resolves.toMatchObject({ reason: "daily-limit" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(posts()).toHaveLength(1);
    // and the automatic pushes stop asking for the rest of the UTC day
    await expect(syncToCloud()).resolves.toBe(false);
    expect(posts()).toHaveLength(1);
    await chrome.storage.local.remove(PUSH_FAILURE_KEY);

    reply = () => json({ error: "kv_busy", message: "Storage busy" }, 503);
    await expect(syncToCloud()).resolves.toBe(false);
    await expect(getPushFailure()).resolves.toMatchObject({ reason: "kv-busy" });
    reply = () => json({ ok: true, rev: 3 });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(posts()).toHaveLength(3);
    await expect(getPushFailure()).resolves.toBeNull();
  });

  it("the day's limit ends at 00:00 UTC: the next day pushes again, and nothing says 'used up'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 23, 50));
    reply = () => json({ error: "daily_write_budget", message: "Daily write budget spent" }, 503);
    await syncToCloud();
    await expect(getPushFailure()).resolves.toMatchObject({ reason: "daily-limit" });
    await syncToCloud();
    expect(posts()).toHaveLength(1);

    vi.setSystemTime(Date.UTC(2026, 8, 26, 0, 10));
    // the popup reads it on every render: yesterday's is not shown
    await expect(getPushFailure()).resolves.toBeNull();
    reply = () => json({ ok: true, rev: 4 });
    await expect(syncToCloud()).resolves.toBe(true);
    expect(posts()).toHaveLength(2);
  });
});

describe("few-key pushes", () => {
  it("send baseRev and keep the new revision", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 100 });
    reply = () => json({ ok: true, rev: 200 });
    await expect(pushPartial({ PROFILE_PUB_BIO: "hi" })).resolves.toBe("ok");
    expect(posts()[0].body).toEqual({ settings: { PROFILE_PUB_BIO: "hi" }, baseRev: 100 });
    expect(await storedRev()).toBe(200);
  });

  it("on a conflict, send the keys again without it, and keep the old revision", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 100 });
    reply = (c) => (c.body.baseRev !== undefined ? conflict(300) : new Response("Saved", { status: 200 }));
    await expect(pushPartial({ PROFILE_PUB_BIO: "hi" })).resolves.toBe("ok");
    expect(posts().map((c) => c.body)).toEqual([
      { settings: { PROFILE_PUB_BIO: "hi" }, baseRev: 100 },
      { settings: { PROFILE_PUB_BIO: "hi" } },
    ]);
    // the next full push must still see the other browser's change
    expect(await storedRev()).toBe(100);
    await expect(getPushFailure()).resolves.toBeNull();
  });

  it("run one after the other with the full pushes, each with the revision the last one got", async () => {
    let rev = 10;
    reply = () => json({ ok: true, rev: ++rev });
    await Promise.all([pushSettings(), pushPartial({ PROFILE_PUB_BIO: "a" }), pushSettings()]);
    expect(posts().map((c) => c.body.baseRev)).toEqual([undefined, 11, 12]);
    expect(await storedRev()).toBe(13);
  });
});

describe("pull and restore take the cloud's revision", () => {
  it("Pull applies the copy, takes its revision and settles a conflict", async () => {
    await chrome.storage.local.set({
      CLOUD_SETTINGS_REV: 50,
      [PUSH_FAILURE_KEY]: { reason: "conflict", detail: "", at: 1 },
    });
    reply = () => json({ settings: { FRIENDS_LIST: ["bob"] }, activeSessions: 1, rev: 40 });
    const result = await pullSettings();
    expect(result.ok).toBe(true);
    expect((await chrome.storage.local.get("FRIENDS_LIST")).FRIENDS_LIST).toEqual(["bob"]);
    // exactly the copy's, even older: the settings now are that copy
    expect(await storedRev()).toBe(40);
    await expect(getPushFailure()).resolves.toBeNull();
  });

  it("the restore question: restored or empty takes it, Cancel does not", async () => {
    reply = () => json({ settings: { FRIENDS_LIST: ["bob"] }, activeSessions: 1, rev: 77 });
    const reload = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", { value: { ...loc, reload }, configurable: true });
    try {
      await chrome.storage.local.set({ PENDING_SETTINGS_RESTORE: true });
      dialog.answer.mockResolvedValueOnce(false);
      await maybePromptRestore();
      expect(await storedRev()).toBeUndefined();

      await chrome.storage.local.set({ PENDING_SETTINGS_RESTORE: true });
      dialog.answer.mockResolvedValueOnce(true);
      await maybePromptRestore();
      expect(await storedRev()).toBe(77);
      expect(reload).toHaveBeenCalled();

      await chrome.storage.local.remove("CLOUD_SETTINGS_REV");
      reply = () => json({ settings: {}, activeSessions: 1, rev: 5 });
      await chrome.storage.local.set({ PENDING_SETTINGS_RESTORE: true });
      await maybePromptRestore();
      expect(await storedRev()).toBe(5);
    } finally {
      Object.defineProperty(window, "location", { value: loc, configurable: true });
    }
  });

  it("the restore question settles a conflict recorded before the sign-in", async () => {
    // a Reconnect after a 401 keeps the recorded failure: it held every
    // automatic push until a manual Pull or Push
    reply = () => json({ settings: { FRIENDS_LIST: ["bob"] }, activeSessions: 1, rev: 77 });
    const reload = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", { value: { ...loc, reload }, configurable: true });
    try {
      for (const restore of [true, false]) {
        await chrome.storage.local.set({
          PENDING_SETTINGS_RESTORE: true,
          [PUSH_FAILURE_KEY]: { reason: "conflict", detail: "", at: 1 },
        });
        dialog.answer.mockResolvedValueOnce(restore);
        await maybePromptRestore();
        await expect(getPushFailure()).resolves.toBeNull();
      }
      // only a conflict: the question says nothing about why a push failed
      await chrome.storage.local.set({
        PENDING_SETTINGS_RESTORE: true,
        [PUSH_FAILURE_KEY]: { reason: "too-large", detail: "", at: 1 },
      });
      dialog.answer.mockResolvedValueOnce(true);
      await maybePromptRestore();
      await expect(getPushFailure()).resolves.toMatchObject({ reason: "too-large" });
    } finally {
      Object.defineProperty(window, "location", { value: loc, configurable: true });
    }
  });

  it("signing out and wiping forget it with the session", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 5, LOOK_PUBLISH_PENDING: { PROFILE_PUB_BIO: 1 } });
    await logoutCloud();
    expect(await chrome.storage.local.get(["CLOUD_SETTINGS_REV", "LOOK_PUBLISH_PENDING"])).toEqual({});
    await chrome.storage.local.set({ CLOUD_TOKEN: "sess", CLOUD_LOGIN: "alice", CLOUD_SETTINGS_REV: 5 });
    await expect(wipeAllCloudData()).resolves.toBe(true);
    expect(await storedRev()).toBeUndefined();
  });

  it("wiping also drops the image deletes still waiting: the wipe took every upload", async () => {
    const pending = { hash: "hashed-alice", slots: ["avatar"], seen: {}, triedAt: 1 };
    // signing out keeps them: the uploads are still on the server
    await chrome.storage.local.set({ CLOUD_TOKEN: "sess", CLOUD_LOGIN: "alice", PENDING_IMAGE_CLEANUP: pending });
    await logoutCloud();
    expect((await chrome.storage.local.get("PENDING_IMAGE_CLEANUP")).PENDING_IMAGE_CLEANUP).toEqual(pending);
    await chrome.storage.local.set({ CLOUD_TOKEN: "sess", CLOUD_LOGIN: "alice" });
    await expect(wipeAllCloudData()).resolves.toBe(true);
    expect((await chrome.storage.local.get("PENDING_IMAGE_CLEANUP")).PENDING_IMAGE_CLEANUP).toBeUndefined();
  });
});

describe("the popup's Push after a conflict", () => {
  it("fails the button on a conflict, then asks before pushing without the check", async () => {
    const state = createInitialState();
    state.login = "alice";
    state.token = "sess";
    const handlers = createHandlers(state, () => {});
    const ask = vi.fn(() => false);
    (globalThis as any).confirm = ask;

    reply = () => conflict(10);
    await handlers.handlePush();
    // the line under the card says what happened (describeCloudFailure)
    expect(state.buttons.push.text).toBe("Sync Failed");
    expect(ask).not.toHaveBeenCalled();

    // the popup re-reads the recorded failure on every render
    state.pushFailure = await getPushFailure();
    state.buttons.push.loading = false;
    await handlers.handlePush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);

    ask.mockReturnValue(true);
    reply = (c) => (c.method === "POST" ? new Response("Saved") : json({ activeSessions: 1, rev: 11 }));
    await handlers.handlePush();
    expect(posts()[1].body).not.toHaveProperty("baseRev");
    expect(state.buttons.push.text).toBe("Synced!");
  });
});

describe("error codes, in the reader's words", () => {
  it("too_large keeps the key and the limit, in a form both languages read, not the worker's English", async () => {
    reply = () =>
      json({ error: "too_large", key: "CUSTOM_CSS", max: 65536, message: "Setting CUSTOM_CSS too large (max 64 KB)" }, 413);
    await expect(pushSettings()).resolves.toBe("too-large");
    const failure = (await getPushFailure())!;
    expect(failure).toMatchObject({ reason: "too-large", detail: "CUSTOM_CSS > 64 KB" });
    const sentence = describeCloudFailure(failure.reason, failure.detail);
    expect(sentence).toContain("(CUSTOM_CSS > 64 KB)");
    expect(sentence).not.toContain("too large (max");
    // the whole record: no key
    reply = () => json({ error: "too_large", key: null, max: 262144, message: "Settings too large" }, 413);
    await pushSettings();
    expect((await getPushFailure())!.detail).toBe("> 256 KB");
    // and the unit in French
    setLang("fr");
    try {
      reply = () => json({ error: "too_large", key: "CUSTOM_CSS", max: 65536, message: "x" }, 413);
      await pushSettings();
      expect((await getPushFailure())!.detail).toBe("CUSTOM_CSS > 64 Ko");
    } finally {
      setLang("en");
    }
  });

  it("the conflict, the day's limit and a busy KV each have a sentence", () => {
    expect(describeCloudFailure("conflict")).toMatch(/^Another browser.*Pull/);
    expect(describeCloudFailure("daily-limit")).toMatch(/saves for today are used up\. Try again after \S/);
    expect(describeCloudFailure("kv-busy")).toMatch(/busy.*few seconds/);
    expect(workerErrorText({ error: "rate_limited" })).toBeNull();
    expect(workerErrorText({})).toBeNull();
  });

  it("a sign-in refused for the day's budget or a busy KV does not blame 42's key server", async () => {
    reply = () => json({ error: "daily_write_budget", message: "Daily write budget spent" }, 503);
    let res = await loginWithIntraSession();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/saves for today are used up/);
    expect(res.error).not.toMatch(/key server/);
    reply = () => json({ error: "kv_busy", message: "Storage busy" }, 503);
    res = await loginWithIntraSession();
    expect(res.error).toMatch(/busy/);
    // a 503 without a code is still 42's key server
    reply = () => new Response("JWKS unavailable", { status: 503 });
    res = await loginWithIntraSession();
    expect(res.error).toMatch(/key server/);
  });

  it("a sign-in leaves the revision to the restore question it brings", async () => {
    await chrome.storage.local.set({ CLOUD_SETTINGS_REV: 42 });
    reply = () => json({ token: "t2", login: "bob" });
    await loginWithIntraSession();
    expect((await chrome.storage.local.get("PENDING_SETTINGS_RESTORE")).PENDING_SETTINGS_RESTORE).toBe(true);
    // Cancel there forgets it (it may be another login's): see "the restore question"
    expect(await storedRev()).toBe(42);
  });
});
