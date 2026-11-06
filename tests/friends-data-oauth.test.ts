/**
 * friends.ts in "oauth" auth mode (the upstream worker's friends endpoint;
 * set by the mock below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The dormant "oauth" mode, said here: tests default to the shipped "intra".
vi.mock("../src/core/worker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker.ts")>();
  return { ...actual, AUTH_MODE: "oauth" };
});
vi.mock("../src/features/account/account.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));

import {
  checkFriendLogin,
  fetchFriendsData,
  loadFriendsData,
  removeFriend,
  saveFriendsList,
} from "../src/features/friends/friends";

let reply: { status: number; friends?: { login: string }[] } | "offline";

beforeEach(async () => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ CLOUD_TOKEN: "tok", CLOUD_LOGIN: "me" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (reply === "offline") throw new TypeError("NetworkError");
      const r = reply;
      const asked = new URL(url).searchParams.get("logins")?.split(",") ?? [];
      const friends = r.friends ?? asked.map((login) => ({ login }));
      return {
        ok: r.status === 200,
        status: r.status,
        json: async () => ({ friends }),
      };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("checkFriendLogin (oauth)", () => {
  it("is not-found only when the worker answers with nobody", async () => {
    reply = { status: 200 };
    expect((await checkFriendLogin("alice")).status).toBe("found");
    reply = { status: 200, friends: [] };
    expect(await checkFriendLogin("ghost")).toEqual({ status: "not-found" });
    reply = { status: 500 };
    expect(await checkFriendLogin("alice")).toEqual({ status: "error" });
    reply = "offline";
    expect(await checkFriendLogin("alice")).toEqual({ status: "error" });
  });

  it("flags an expired cloud session on 401", async () => {
    reply = { status: 401 };
    expect(await checkFriendLogin("alice")).toEqual({ status: "error" });
    const { CLOUD_AUTH_FAILED } = await chrome.storage.local.get("CLOUD_AUTH_FAILED");
    expect(CLOUD_AUTH_FAILED).toBe(true);
  });
});

describe("loadFriendsData (oauth)", () => {
  it("filters the cache by the current list", async () => {
    reply = { status: 200 };
    await saveFriendsList(["alice", "bob"]);
    await loadFriendsData(["alice", "bob"]);
    await removeFriend("bob");
    reply = "offline"; // would fail if it were not served from the cache
    const r = await fetchFriendsData(["alice", "carol"]);
    // carol is not covered: refetch fails, fallback keeps only alice
    expect(r.map((f) => f.login)).toEqual(["alice"]);
    const ok = await loadFriendsData(["alice"]);
    expect(ok.ok).toBe(true);
    expect(ok.friends.map((f) => f.login)).toEqual(["alice"]);
  });

  it("fails without data instead of claiming an empty list", async () => {
    reply = { status: 503 };
    expect(await loadFriendsData(["alice", "bob"])).toEqual({
      friends: [],
      ok: false,
      fetchedAt: null,
      detail: "full",
    });
  });
});
