/**
 * friends.ts in "intra" auth mode (the mode this repo builds): the add-friend
 * check and the cached friends list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/worker.ts", () => ({
  WORKER_URL: "https://worker.test",
  WORKER_HOST: "worker.test",
  WORKER_ORIGIN_PATTERN: "https://worker.test/*",
  AUTH_MODE: "intra",
}));
vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));
vi.mock("../src/features/account/account.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));
const intrapy = vi.hoisted(() => ({ token: "Bearer t" as string | null }));
vi.mock("../src/core/intra/intrapy.ts", () => ({
  waitForIntrapyToken: vi.fn(async () => intrapy.token),
}));

import {
  addFriend,
  cacheFriendData,
  checkFriendLogin,
  fetchFriendsData,
  FRIENDS_CACHE_TTL,
  loadFriendsData,
  removeFriend,
  saveFriendsList,
} from "../src/features/friends/friends";
import { fetchFriendsIntraResult } from "../src/features/friends/friends-intra";

/** login -> HTTP status of its intrapy /users call (200 by default). */
const statusOf = new Map<string, number | "offline">();
const calls: string[] = [];

function user(login: string) {
  return {
    displayname: login.toUpperCase(),
    profile_picture: `https://cdn.intra.42.fr/${login}.jpg`,
    wallet: 1,
  };
}

async function cacheOf() {
  const raw = await chrome.storage.local.get("FRIENDS_DATA_CACHE");
  return raw.FRIENDS_DATA_CACHE as
    | { data: { login: string; wallet: number }[]; timestamp: number; logins?: string[] }
    | undefined;
}

const logins = (list: { login: string }[]) => list.map((f) => f.login);

beforeEach(async () => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ CLOUD_TOKEN: "tok", CLOUD_LOGIN: "me" });
  intrapy.token = "Bearer t";
  statusOf.clear();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://worker.test")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      const m = url.match(/\/users\/([^/]+)(\/.*)?$/);
      const login = m ? decodeURIComponent(m[1]) : "";
      const status = statusOf.get(login) ?? 200;
      if (status === "offline") throw new TypeError("NetworkError");
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      const body = m?.[2] === "/cursus" ? [] : user(login);
      return { ok: true, status, json: async () => body };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchFriendsIntraResult", () => {
  it("tells an unknown login from one that could not be checked", async () => {
    statusOf.set("ghost", 404);
    statusOf.set("expired", 401);
    statusOf.set("limited", 429);
    statusOf.set("down", 503);
    statusOf.set("off", "offline");
    const r = await fetchFriendsIntraResult([
      "alice",
      "ghost",
      "expired",
      "limited",
      "down",
      "off",
    ]);
    expect(logins(r.friends)).toEqual(["alice"]);
    expect(r.notFound).toEqual(["ghost"]);
    expect(r.failed).toEqual(["expired", "limited", "down", "off"]);
  });

  it("reports every login as failed without a fresh page token", async () => {
    intrapy.token = null;
    const r = await fetchFriendsIntraResult(["alice", "bob"]);
    expect(r).toEqual({ friends: [], notFound: [], failed: ["alice", "bob"] });
    expect(calls).toEqual([]);
  });
});

describe("checkFriendLogin", () => {
  it("is found / not-found / error", async () => {
    expect((await checkFriendLogin(" Alice ")).status).toBe("found");
    statusOf.set("ghost", 404);
    expect(await checkFriendLogin("ghost")).toEqual({ status: "not-found" });
    statusOf.set("expired", 401);
    expect(await checkFriendLogin("expired")).toEqual({ status: "error" });
    statusOf.set("off", "offline");
    expect(await checkFriendLogin("off")).toEqual({ status: "error" });
    intrapy.token = null;
    expect(await checkFriendLogin("alice")).toEqual({ status: "error" });
  });
});

describe("friends cache follows the friends list", () => {
  it("does not show a removed friend again (served the whole old cache before)", async () => {
    await saveFriendsList(["alice", "bob", "carol"]);
    expect(logins(await fetchFriendsData(["alice", "bob", "carol"]))).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    calls.length = 0;
    // As the profile header's "Remove friend" does it
    await removeFriend("bob");
    expect(logins(await fetchFriendsData(["alice", "carol"]))).toEqual([
      "alice",
      "carol",
    ]);
    expect(calls).toEqual([]); // still served from the cache
    expect((await cacheOf())?.data.map((f) => f.login)).toEqual(["alice", "carol"]);
  });

  it("shows a friend added elsewhere at once (missing for 3 minutes before)", async () => {
    await fetchFriendsData(["alice", "bob"]);
    await addFriend("dave");
    expect(logins(await fetchFriendsData(["alice", "bob", "dave"]))).toEqual([
      "alice",
      "bob",
      "dave",
    ]);
  });

  it("serves a list of one friend from the cache too", async () => {
    await loadFriendsData(["alice"]);
    calls.length = 0;
    const r = await loadFriendsData(["alice"]);
    expect(logins(r.friends)).toEqual(["alice"]);
    expect(calls).toEqual([]);
  });

  it("ignores a cache written without its logins (1.11.1)", async () => {
    await chrome.storage.local.set({
      FRIENDS_DATA_CACHE: { data: [{ login: "zed" }], timestamp: Date.now() },
    });
    const r = await loadFriendsData(["alice"]);
    expect(logins(r.friends)).toEqual(["alice"]);
    expect((await cacheOf())?.logins).toEqual(["alice"]);
  });

  it("cacheFriendData keeps the cache covering the list after an add", async () => {
    await loadFriendsData(["alice", "bob"]);
    const check = await checkFriendLogin("dave");
    if (check.status !== "found") throw new Error("expected found");
    await addFriend("dave");
    await cacheFriendData(check.friend);
    calls.length = 0;
    const r = await loadFriendsData(["alice", "bob", "dave"]);
    expect(logins(r.friends)).toEqual(["alice", "bob", "dave"]);
    expect(calls).toEqual([]);
  });
});

describe("loadFriendsData when the Intra does not answer", () => {
  it("falls back to the last rows of these logins and says it failed", async () => {
    await loadFriendsData(["alice", "bob", "carol"]);
    vi.useFakeTimers({ now: Date.now() + FRIENDS_CACHE_TTL + 1000 });
    intrapy.token = null;
    const r = await loadFriendsData(["alice", "carol"]);
    expect(logins(r.friends)).toEqual(["alice", "carol"]);
    expect(r.ok).toBe(false);
    expect(r.fetchedAt).toBeNull();
  });

  it("gives an empty failed result, not an empty list, with nothing cached", async () => {
    intrapy.token = null;
    expect(await loadFriendsData(["alice"])).toEqual({
      friends: [],
      ok: false,
      fetchedAt: null,
      detail: "full",
    });
  });

  it("force refetches a fresh cache but keeps it when that fails", async () => {
    await loadFriendsData(["alice", "bob"]);
    calls.length = 0;
    const fresh = await loadFriendsData(["alice", "bob"], { force: true });
    expect(fresh.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);

    intrapy.token = null;
    const failed = await loadFriendsData(["alice", "bob"], { force: true });
    expect(logins(failed.friends)).toEqual(["alice", "bob"]);
    expect(failed.ok).toBe(false);
    expect((await cacheOf())?.logins).toEqual(["alice", "bob"]);
  });

  it("mixes fresh rows with old ones on a partial failure, without caching", async () => {
    await loadFriendsData(["alice", "bob"]);
    const before = await cacheOf();
    vi.useFakeTimers({ now: Date.now() + FRIENDS_CACHE_TTL + 1000 });
    statusOf.set("bob", 429);
    const r = await loadFriendsData(["alice", "bob", "carol"]);
    expect(logins(r.friends)).toEqual(["alice", "bob", "carol"]);
    expect(r.ok).toBe(false);
    expect(await cacheOf()).toEqual(before);
  });

  it("reports the cache's age when served from it", async () => {
    const first = await loadFriendsData(["alice"]);
    const second = await loadFriendsData(["alice"]);
    expect(second.fetchedAt).toBe((await cacheOf())?.timestamp);
    expect(first.ok && second.ok).toBe(true);
  });
});

describe("without a Cuter Intra sign-in", () => {
  // Intra mode reads the Intra with the page's own session and the public
  // visuals route: the Cuter Intra session is not needed for either.
  it("loads the list when never signed in", async () => {
    await chrome.storage.local.remove(["CLOUD_TOKEN", "CLOUD_LOGIN"]);
    const r = await loadFriendsData(["alice", "bob"]);
    expect(r.ok).toBe(true);
    expect(logins(r.friends)).toEqual(["alice", "bob"]);
  });

  it("checks a login to add when never signed in", async () => {
    await chrome.storage.local.remove(["CLOUD_TOKEN", "CLOUD_LOGIN"]);
    expect((await checkFriendLogin("alice")).status).toBe("found");
    statusOf.set("ghost", 404);
    expect(await checkFriendLogin("ghost")).toEqual({ status: "not-found" });
  });
});
