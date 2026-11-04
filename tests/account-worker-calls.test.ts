/**
 * The intra sign-in and the calendar upload go through the worker client:
 * a stalled worker ends in the existing "could not reach" message instead
 * of a spinner that never stops, and a revoked session (the worker keeps ten
 * per login) flags CLOUD_AUTH_FAILED so the UI can offer Reconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/intra/intrapy.ts", () => ({
  waitForIntrapyToken: async () => "Bearer intra-jwt",
  getStoredIntrapyToken: () => null,
  isJwtExpired: () => false,
}));

import { loginWithIntraSession } from "../src/features/account/intra-login.ts";
import { syncCalendarIcs } from "../src/features/calendar/calendar-sync.ts";

let reply: () => Response | "hang" = () => new Response("{}", { status: 200 });
const calls: { url: URL; init: RequestInit }[] = [];

beforeEach(async () => {
  await chrome.storage.local.clear();
  calls.length = 0;
  (globalThis as any).fetch = vi.fn(
    async (rawUrl: string, init: RequestInit) => {
      calls.push({ url: new URL(rawUrl), init });
      const answer = reply();
      if (answer !== "hang") return answer;
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loginWithIntraSession", () => {
  it("posts the Intra token and stores the session", async () => {
    reply = () =>
      new Response(JSON.stringify({ token: "sess", login: "alice" }), {
        status: 200,
      });
    const res = await loginWithIntraSession();
    expect(res).toEqual({ ok: true, login: "alice" });
    expect(calls[0].url.pathname).toBe("/auth/intra");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      token: "Bearer intra-jwt",
    });
    expect((await chrome.storage.local.get("CLOUD_TOKEN")).CLOUD_TOKEN).toBe(
      "sess",
    );
  });

  it("gives up on a stalled worker with the 'could not reach' message", async () => {
    vi.useFakeTimers();
    reply = () => "hang";
    const pending = loginWithIntraSession();
    await vi.advanceTimersByTimeAsync(20_001);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not reach the Cuter Intra server/);
  });

  it("quotes the worker's message when it refuses the login", async () => {
    reply = () =>
      new Response(
        JSON.stringify({ error: "bad_token", message: "signature" }),
        {
          status: 401,
        },
      );
    const res = await loginWithIntraSession();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refused the login \(401\): signature/);
    // not a private route: nothing to reconnect
    expect(
      (await chrome.storage.local.get("CLOUD_AUTH_FAILED")).CLOUD_AUTH_FAILED,
    ).toBeUndefined();
  });
});

describe("syncCalendarIcs", () => {
  const event = {
    id: 1,
    name: "Talk",
    kind: "event",
    begin_at: "2026-09-25T10:00:00.000Z",
    end_at: "2026-09-25T11:00:00.000Z",
  };

  beforeEach(async () => {
    await chrome.storage.local.set({
      CLOUD_TOKEN: "sess",
      CLOUD_LOGIN: "alice",
      CALENDAR_SYNC_TOKEN: "abcdefgh1234",
    });
  });

  it("flags the expired session on a 401 and keeps the hash unset", async () => {
    reply = () => new Response("Unauthorized", { status: 401 });
    await syncCalendarIcs([event]);
    const store = await chrome.storage.local.get(null);
    expect(store.CLOUD_AUTH_FAILED).toBe(true);
    expect(store.CALENDAR_EVENTS_HASH).toBeUndefined();
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer sess");
    expect(calls[0].url.searchParams.get("login")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not flag it on another failure, and stays silent", async () => {
    reply = () => new Response("oops", { status: 500 });
    await expect(syncCalendarIcs([event])).resolves.toBeUndefined();
    expect(
      (await chrome.storage.local.get("CLOUD_AUTH_FAILED")).CLOUD_AUTH_FAILED,
    ).toBeUndefined();
  });

  it("returns once the deadline passes on a stalled worker", async () => {
    vi.useFakeTimers();
    reply = () => "hang";
    const pending = syncCalendarIcs([event]);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(pending).resolves.toBeUndefined();
    expect(
      (await chrome.storage.local.get("CALENDAR_EVENTS_HASH"))
        .CALENDAR_EVENTS_HASH,
    ).toBeUndefined();
  });
});
