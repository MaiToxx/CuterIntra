import { getConfig } from "../../core/config.ts";
import { hashLogin } from "../account/account.ts";

import { WORKER_URL, AUTH_MODE } from "../../core/worker.ts";
import { fetchFriendsIntraResult } from "./friends-intra.ts";
import type { FriendData } from "./friends-types.ts";

// Re-exported so importers of friends.ts keep finding the type here.
export type { FriendData };

export async function getFriendsList(): Promise<string[]> {
  const raw = await getConfig("FRIENDS_LIST");
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveFriendsList(logins: string[]): Promise<void> {
  await chrome.storage.local.set({
    FRIENDS_LIST: JSON.stringify(logins),
  });
}

export async function addFriend(login: string): Promise<void> {
  const list = await getFriendsList();
  const normalized = login.trim().toLowerCase();
  if (list.includes(normalized)) return;
  // No cache change needed: the cache no longer covers the list, so the next
  // load fetches it (the widget patches it with cacheFriendData() instead).
  await saveFriendsList([...list, normalized]);
}

export async function removeFriend(login: string): Promise<void> {
  const list = await getFriendsList();
  const normalized = login.toLowerCase();
  await saveFriendsList(list.filter((l) => l !== normalized));
  // Reads already filter the cache by the current list; dropping the row too
  // keeps anything else that reads the cache from showing a removed friend.
  await dropFromCache(normalized);
}

export async function isFriend(login: string): Promise<boolean> {
  const list = await getFriendsList();
  return list.includes(login.trim().toLowerCase());
}

const CACHE_KEY = "FRIENDS_DATA_CACHE";
// In intra mode every friend costs up to 3 intrapy calls on the user's own
// Intra session, so the list is kept longer: 5 minutes, not more, since the
// online count on the button is what goes stale and Refresh is the only way
// to force it.
export const FRIENDS_CACHE_TTL = AUTH_MODE === "intra" ? 5 * 60_000 : 30_000;
const CACHE_TTL = FRIENDS_CACHE_TTL;
/**
 * The worker's friends endpoint aggregates 42 API calls for up to 50 logins;
 * without a deadline a stalled connection kept the widget loading for good.
 */
export const FRIENDS_FETCH_TIMEOUT_MS = 30_000;

interface FriendsCache {
  data: FriendData[];
  timestamp: number;
  /**
   * False when the rows come from an "online" fetch (see friends-intra.ts):
   * their level, picture and custom avatar are the last known ones, so the
   * cache serves the closed widget's badge but not the open panel. Absent
   * from older caches, which were always full.
   */
  full?: boolean;
  /**
   * Whether custom avatars were asked for. A cache written with them off is
   * not full for a panel that now shows them, so switching the setting on
   * does not show the 42 pictures until the cache expires.
   */
  visuals?: boolean;
  /**
   * The logins that were asked for. The cache is only served for a list it
   * covers: it used to be served whatever the list, so a friend removed (or
   * followed from their profile) stayed (or stayed missing) for 3 minutes.
   * Absent from caches written by 1.11.1 and earlier, which never match.
   */
  logins?: string[];
}

async function getCachedData(): Promise<FriendsCache | null> {
  try {
    const raw = (await chrome.storage.local.get(CACHE_KEY)) as Record<
      string,
      unknown
    >;
    const val = raw[CACHE_KEY] as FriendsCache | undefined;
    if (!val || !Array.isArray(val.data) || typeof val.timestamp !== "number")
      return null;
    const logins =
      Array.isArray(val.logins) &&
      val.logins.every((l) => typeof l === "string")
        ? val.logins
        : undefined;
    return {
      data: val.data,
      timestamp: val.timestamp,
      logins,
      full: val.full !== false,
      visuals: val.visuals !== false,
    };
  } catch {
    return null;
  }
}

async function setCachedData(
  data: FriendData[],
  logins: string[],
  stage: { full: boolean; visuals: boolean },
): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: {
        data,
        timestamp: Date.now(),
        logins: [...logins],
        full: stage.full,
        visuals: stage.visuals,
      },
    });
  } catch {
    // A cache that could not be written only costs a refetch next time.
  }
}

async function dropFromCache(login: string): Promise<void> {
  const cached = await getCachedData();
  if (!cached || !cached.data.some((f) => f.login === login)) return;
  await chrome.storage.local.set({
    [CACHE_KEY]: {
      data: cached.data.filter((f) => f.login !== login),
      timestamp: cached.timestamp,
      full: cached.full,
      visuals: cached.visuals,
      ...(cached.logins
        ? { logins: cached.logins.filter((l) => l !== login) }
        : {}),
    },
  });
}

export async function clearFriendsCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

/**
 * Add or replace one friend in the cache, keeping its age: after adding a
 * friend, the next page load still finds a cache that covers the whole list
 * instead of fetching every friend again for the one that was just added.
 */
export async function cacheFriendData(friend: FriendData): Promise<void> {
  const cached = await getCachedData();
  if (!cached?.logins) return;
  await chrome.storage.local.set({
    [CACHE_KEY]: {
      data: [...cached.data.filter((f) => f.login !== friend.login), friend],
      timestamp: cached.timestamp,
      full: cached.full,
      visuals: cached.visuals,
      logins: cached.logins.includes(friend.login)
        ? cached.logins
        : [...cached.logins, friend.login],
    },
  });
}

function isFresh(cached: FriendsCache): boolean {
  return cached.data.length > 0 && Date.now() - cached.timestamp < CACHE_TTL;
}

function cacheCovers(cached: FriendsCache, logins: string[]): boolean {
  if (!cached.logins) return false;
  const have = new Set(cached.logins);
  return logins.every((l) => have.has(l));
}

/** The cached rows of `logins`, in that order (never a friend not in it). */
function pickCached(
  cached: FriendsCache | null,
  logins: string[],
): FriendData[] {
  if (!cached) return [];
  const byLogin = new Map(cached.data.map((f) => [f.login, f]));
  return logins.flatMap((l) => byLogin.get(l) ?? []);
}

/**
 * The last cached rows of `logins`, however old, with the cache's time: what
 * the widget paints while the real load runs, instead of a spinner. Never a
 * login that is not in `logins`, so a removed friend cannot come back.
 */
export async function peekCachedFriends(
  logins: string[],
): Promise<{ friends: FriendData[]; timestamp: number; full: boolean } | null> {
  const cached = await getCachedData();
  if (!cached) return null;
  return {
    friends: pickCached(cached, logins),
    timestamp: cached.timestamp,
    full: cached.full !== false,
  };
}

/** How much of each friend to load (see friends-intra.ts). */
export type FriendsDetail = "online" | "full";

/** The whole friends list, and whether it could really be fetched. */
export interface FriendsLoadResult {
  /** What the rows carry: "online" rows keep their last known level and avatar. */
  detail: FriendsDetail;
  /**
   * The friends to show. When `ok` is false, the rows that could not be
   * fetched are the last cached ones (however old), or are missing.
   */
  friends: FriendData[];
  /** False when (part of) the list could not be fetched: show an error. */
  ok: boolean;
  /**
   * When `friends` was fetched (the cache's time when served from it), or
   * null when the fetch failed, so nothing claims "Updated just now".
   */
  fetchedAt: number | null;
}

/**
 * Fetch the data of every friend in `logins`, from the cache when it is fresh
 * and covers them. `force` skips the fresh cache (the refresh button) but
 * still falls back on it when the fetch fails: a failed refresh used to wipe
 * the cache first and then show "No friends yet".
 */
export async function loadFriendsData(
  logins: string[],
  opts: { force?: boolean; detail?: FriendsDetail } = {},
): Promise<FriendsLoadResult> {
  const detail: FriendsDetail = opts.detail ?? "full";
  if (logins.length === 0) {
    return { friends: [], ok: true, fetchedAt: Date.now(), detail: "full" };
  }

  // Only the oauth branch asks the worker for the friends, with the Better
  // Intra session. The intra branch reads the Intra with the page's own
  // session and the public visuals route, which needs no sign-in: a student
  // who never signed in, or whose Cuter Intra session expired, still gets
  // the list.
  const token = await getConfig("CLOUD_TOKEN");
  const cloudLogin = await getConfig("CLOUD_LOGIN");
  if (AUTH_MODE !== "intra" && (!token || !cloudLogin))
    return { friends: [], ok: false, fetchedAt: null, detail };

  // The setting decides what a full cache must hold, whatever this request
  // is: the closed widget's "online" load runs first on every page, and if
  // it took a cache written with custom avatars off as full, the panel opened
  // next skipped its load and showed the 42 pictures until the cache expired.
  const visualsOn =
    AUTH_MODE === "intra" &&
    !!(await getConfig("SHOW_CUSTOM_AVATARS_IN_FRIENDS"));
  // Only the open panel shows custom avatars: the closed widget and a user
  // who turned them off never cost the worker a request.
  const wantVisuals = visualsOn && detail === "full";

  const cached = await getCachedData();
  /** What the cached rows, if any, can stand for. */
  const cachedDetail: FriendsDetail =
    !cached ||
    (cached.full !== false && (!visualsOn || cached.visuals !== false))
      ? "full"
      : "online";
  if (
    !opts.force &&
    cached &&
    isFresh(cached) &&
    cacheCovers(cached, logins) &&
    (detail === "online" || cachedDetail === "full")
  ) {
    return {
      friends: pickCached(cached, logins),
      ok: true,
      fetchedAt: cached.timestamp,
      detail: cachedDetail,
    };
  }

  /** The server answered, but with nobody for a non-empty list. */
  const emptyAnswer = (): FriendsLoadResult => {
    // Fall back to the last known non-empty data, as before
    const old = pickCached(cached, logins);
    return old.length > 0 && cached
      ? { friends: old, ok: true, fetchedAt: cached.timestamp, detail: cachedDetail }
      : { friends: [], ok: true, fetchedAt: Date.now(), detail };
  };

  if (AUTH_MODE === "intra") {
    // No 42 API on the self-hosted worker: build the data from the Intra's
    // own API with the page's session token (see friends-intra.ts).
    const result = await fetchFriendsIntraResult(logins, {
      detail,
      visuals: wantVisuals,
      known: pickCached(cached, logins),
    });
    if (result.failed.length === 0) {
      if (result.friends.length === 0) return emptyAnswer();
      await setCachedData(result.friends, logins, {
        full: detail === "full",
        visuals: wantVisuals,
      });
      return { friends: result.friends, ok: true, fetchedAt: Date.now(), detail };
    }
    // Some logins could not be checked (expired session, rate limit,
    // offline): keep what did come back, the last known rows for the rest,
    // and do not cache a list with holes in it.
    const fresh = new Map(result.friends.map((f) => [f.login, f]));
    const failed = new Set(result.failed);
    const old = new Map(pickCached(cached, logins).map((f) => [f.login, f]));
    const friends = logins.flatMap(
      (l) => fresh.get(l) ?? (failed.has(l) ? (old.get(l) ?? []) : []),
    );
    return { friends, ok: false, fetchedAt: null, detail };
  }

  try {
    const hashedLogin = await hashLogin(cloudLogin);
    const res = await fetch(
      `${WORKER_URL}/api/v1/private/friends/data?login=${encodeURIComponent(hashedLogin)}&logins=${encodeURIComponent(logins.join(","))}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FRIENDS_FETCH_TIMEOUT_MS),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { friends?: FriendData[] };
      const friends = data.friends ?? [];
      if (friends.length === 0) return emptyAnswer();
      await setCachedData(friends, logins, { full: true, visuals: true });
      return { friends, ok: true, fetchedAt: Date.now(), detail: "full" };
    } else if (res.status === 401) {
      await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
    }
  } catch (e) {
    console.error("Failed to fetch friends data:", e);
  }

  // On failure, fall back to the last known data for these logins, if any
  return {
    friends: pickCached(cached, logins),
    ok: false,
    fetchedAt: null,
    detail: cachedDetail,
  };
}

/**
 * The add-friend check. "not-found" only when the server really says the
 * login does not exist; "error" when it could not be asked (expired session,
 * rate limit, offline), because then the login may well be right.
 */
export type FriendCheck =
  | { status: "found"; friend: FriendData }
  | { status: "not-found" }
  | { status: "error" };

export async function checkFriendLogin(login: string): Promise<FriendCheck> {
  const normalized = login.trim().toLowerCase();
  // Same split as loadFriendsData: only the oauth check needs the sign-in.
  const token = await getConfig("CLOUD_TOKEN");
  const cloudLogin = await getConfig("CLOUD_LOGIN");
  if (AUTH_MODE !== "intra" && (!token || !cloudLogin))
    return { status: "error" };

  if (AUTH_MODE === "intra") {
    const result = await fetchFriendsIntraResult([normalized]);
    if (result.friends[0]) return { status: "found", friend: result.friends[0] };
    return result.notFound.length > 0
      ? { status: "not-found" }
      : { status: "error" };
  }

  // Single-login fetches (add friend validation) always go to API
  try {
    const hashedLogin = await hashLogin(cloudLogin);
    const res = await fetch(
      `${WORKER_URL}/api/v1/private/friends/data?login=${encodeURIComponent(hashedLogin)}&logins=${encodeURIComponent(normalized)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FRIENDS_FETCH_TIMEOUT_MS),
      },
    );
    if (res.status === 401) {
      await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
    }
    if (!res.ok) return { status: "error" };
    // The worker answers 200 with no friend for a login the 42 API does not know
    const friends =
      ((await res.json()) as { friends?: FriendData[] }).friends ?? [];
    const friend = friends.find((f) => f.login === normalized) ?? friends[0];
    return friend ? { status: "found", friend } : { status: "not-found" };
  } catch {
    return { status: "error" };
  }
}

/**
 * Kept for importers of the old API. One login: the add-friend check, [] when
 * the login is unknown or could not be checked (checkFriendLogin() tells them
 * apart). Several: loadFriendsData()'s friends.
 */
export async function fetchFriendsData(
  logins: string[],
): Promise<FriendData[]> {
  if (logins.length === 0) return [];
  if (logins.length === 1) {
    const check = await checkFriendLogin(logins[0]);
    return check.status === "found" ? [check.friend] : [];
  }
  return (await loadFriendsData(logins)).friends;
}
