/**
 * Everything the profile visuals remember between two mutation passes: the
 * signed-in login, each viewed user's visuals in storage, the logins known to
 * have none, and a memo of the key that says "already applied".
 *
 * WHY a module of its own: updateVisuals() runs on every burst of DOM
 * mutations, so these caches are what keeps a pass cheap. They hold no DOM
 * and do not know how visuals are painted, which lets visuals.ts read as the
 * decision it is ("fetch, reuse or skip?") instead of as storage plumbing.
 */
import { getCloudLogin } from "../../account/account.ts";
import type { VisualUrls } from "./visuals-types.ts";
import { addToHistory } from "./image-history.ts";

// ---------------------------------------------------------------------------
// The signed-in login
// ---------------------------------------------------------------------------

/**
 * The signed-in login, read once per page instead of once per mutation pass.
 *
 * WHY: updateVisuals() runs on every burst of DOM mutations and used to await
 * a chrome.storage round-trip for a value that only changes on login/logout -
 * which reloads every Intra tab anyway (background.ts). The storage listener
 * installed below drops the cache, so it stays exact even without that reload.
 */
let cachedOwnLogin: string | null | undefined;
let ownLoginPending: Promise<string | null> | null = null;

export const readOwnLogin = async (): Promise<string | null> => {
  if (cachedOwnLogin !== undefined) return cachedOwnLogin;
  if (!ownLoginPending) {
    ownLoginPending = getCloudLogin()
      .then((login) => {
        cachedOwnLogin = login;
        ownLoginPending = null;
        return login;
      })
      .catch((err) => {
        ownLoginPending = null;
        throw err;
      });
  }
  return ownLoginPending;
};

// ---------------------------------------------------------------------------
// Storage listener: login changes and the image url history
// ---------------------------------------------------------------------------

let historyListenerInstalled = false;

export function installHistoryListener(): void {
  if (historyListenerInstalled) return;
  historyListenerInstalled = true;

  const URL_KEYS = [
    "PROFILE_IMAGE_URL",
    "PROFILE_BANNER_URL",
    "PROFILE_BACKGROUND_URL",
  ] as const;
  const HISTORY_KEYS = {
    PROFILE_IMAGE_URL: "PROFILE_IMAGE_HISTORY",
    PROFILE_BANNER_URL: "PROFILE_BANNER_HISTORY",
    PROFILE_BACKGROUND_URL: "PROFILE_BACKGROUND_HISTORY",
  } as const;

  // Missing in a page that only got a partial chrome API shim: the cache above
  // then simply lives for the page, as it did before it existed.
  if (!chrome.storage.onChanged?.addListener) return;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("CLOUD_LOGIN" in changes) {
      cachedOwnLogin = undefined;
      ownLoginPending = null;
    }
    for (const key of URL_KEYS) {
      if (!(key in changes)) continue;
      const newUrl = changes[key].newValue as string | undefined;
      if (!newUrl) continue;
      const historyKey = HISTORY_KEYS[key];
      chrome.storage.local.get(historyKey).then(async (result) => {
        const history = (result[historyKey] as string[]) || [];
        const updated = addToHistory(newUrl, history);
        if (updated !== history) {
          await chrome.storage.local.set({ [historyKey]: updated });
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// "Already applied?" key
// ---------------------------------------------------------------------------

/**
 * Memo for getVisualKey(): the same object is keyed several times per pass
 * (compare, then store) and the JSON it produces can be a couple of kilobytes
 * once a published look and its extras are in it. VisualUrls objects are
 * replaced, never mutated in place, so identity is a safe cache key.
 */
const visualKeyCache = new WeakMap<VisualUrls, string>();

export const getVisualKey = (urls: VisualUrls): string => {
  const cached = visualKeyCache.get(urls);
  if (cached !== undefined) return cached;
  const key = computeVisualKey(urls);
  visualKeyCache.set(urls, key);
  return key;
};

const computeVisualKey = (urls: VisualUrls) =>
  JSON.stringify({
    avatar: urls.avatar || "",
    banner: urls.banner || "",
    bannerMode: urls.bannerMode || "",
    bannerColor: urls.bannerColor || "",
    background: urls.background || "",
    backgroundMode: urls.backgroundMode || "",
    backgroundColor: urls.backgroundColor || "",
    avatarBg: urls.avatarBg || "transparent",
    decoration: urls.decoration || "none",
    avatarPosX: urls.avatarPosX ?? 50,
    avatarPosY: urls.avatarPosY ?? 50,
    avatarScale: urls.avatarScale ?? 100,
    badgeBg: urls.badgeBg || "",
    theme: urls.theme || null,
    logtime: urls.logtime || null,
    look: urls.look || null,
    extras: urls.extras || null,
  });

// ---------------------------------------------------------------------------
// Per-login visuals in storage, and the logins known to have none
// ---------------------------------------------------------------------------

const CACHE_PREFIX = "visuals_cache_";

/**
 * A stored record carries the time it was fetched, so that a recent answer
 * (including "no visuals at all") can be told from one worth asking the worker
 * about again. The friends widget and the profile page both trust a record
 * for VISUALS_CACHE_FRESH_MS; past that, the profile page still paints the
 * stored record at once and revalidates it in the background.
 */
export interface CachedVisuals extends VisualUrls {
  fetchedAt?: number;
}

/** How long a stored record is trusted without asking the worker again. */
export const VISUALS_CACHE_FRESH_MS = 10 * 60 * 1000;

export function visualsAreFresh(cached: CachedVisuals | null | undefined): boolean {
  return (
    typeof cached?.fetchedAt === "number" &&
    Date.now() - cached.fetchedAt < VISUALS_CACHE_FRESH_MS
  );
}

export const getCachedVisuals = async (
  login: string,
): Promise<CachedVisuals | null> => {
  const result = (await chrome.storage.local.get(
    `${CACHE_PREFIX}${login}`,
  )) as Record<string, CachedVisuals>;
  return result[`${CACHE_PREFIX}${login}`] || null;
};

/** The stored records of `logins`, in one storage read; absent ones are left out. */
export const getCachedVisualsMany = async (
  logins: string[],
): Promise<Map<string, CachedVisuals>> => {
  const out = new Map<string, CachedVisuals>();
  if (logins.length === 0) return out;
  try {
    const result = (await chrome.storage.local.get(
      logins.map((l) => `${CACHE_PREFIX}${l}`),
    )) as Record<string, CachedVisuals | undefined>;
    for (const login of logins) {
      const rec = result[`${CACHE_PREFIX}${login}`];
      if (rec && typeof rec === "object") out.set(login, rec);
    }
  } catch {
    // Unreadable cache: every login is simply fetched.
  }
  return out;
};

// ---------------------------------------------------------------------------
// Sweep: records nobody refreshed for a month
// ---------------------------------------------------------------------------

/**
 * A record not written for this long is dropped. The friends widget rewrites
 * a friend's record whenever it finds it older than ten minutes; the profile
 * page rewrites a peer's record only when their look changed (an identical
 * answer is not stored again), so a peer visited all month with the same look
 * loses it too. Either way the next visit fetches it, as on the first one.
 */
export const VISUALS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Above this many records the oldest go too, whatever their age. */
export const VISUALS_CACHE_MAX_ENTRIES = 200;
/** When the last sweep ran (raw key, not a setting: never exported or synced). */
export const VISUALS_CACHE_SWEPT_AT_KEY = "VISUALS_CACHE_SWEPT_AT";
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/** The storage keys of every stored record. */
async function listCacheKeys(): Promise<string[]> {
  // getKeys() lists the keys without reading the values: the campus files and
  // cluster maps in the same area weigh megabytes. Browsers without it pay
  // one full read, at most once a day.
  const keys =
    typeof chrome.storage.local.getKeys === "function"
      ? await chrome.storage.local.getKeys()
      : Object.keys(await chrome.storage.local.get(null));
  return keys.filter((k) => k.startsWith(CACHE_PREFIX));
}

/**
 * Remove the records older than VISUALS_CACHE_MAX_AGE_MS (or without a stamp,
 * from builds before it), then the oldest beyond VISUALS_CACHE_MAX_ENTRIES.
 *
 * WHY: every Cuter Intra profile a student opened and every friend they
 * followed stayed in chrome.storage.local for the life of the install (bio,
 * pronouns, status and links included), against a 10 MB quota the settings
 * share. Runs at most once a day, after a write: a page that only reads the
 * cache never pays for it.
 */
export async function sweepVisualsCache(
  now: number = Date.now(),
): Promise<void> {
  const last = (await chrome.storage.local.get(VISUALS_CACHE_SWEPT_AT_KEY))[
    VISUALS_CACHE_SWEPT_AT_KEY
  ];
  // A stamp in the future (a clock set back) must not stop sweeps for good.
  if (typeof last === "number" && last <= now && now - last < SWEEP_EVERY_MS)
    return;
  await chrome.storage.local.set({ [VISUALS_CACHE_SWEPT_AT_KEY]: now });

  const keys = await listCacheKeys();
  if (keys.length === 0) return;
  const records = (await chrome.storage.local.get(keys)) as Record<
    string,
    CachedVisuals | undefined
  >;
  const remove: string[] = [];
  const kept: { key: string; at: number }[] = [];
  for (const key of keys) {
    const at = records[key]?.fetchedAt;
    if (typeof at !== "number" || now - at > VISUALS_CACHE_MAX_AGE_MS)
      remove.push(key);
    else kept.push({ key, at });
  }
  kept.sort((a, b) => b.at - a.at);
  for (const { key } of kept.slice(VISUALS_CACHE_MAX_ENTRIES)) remove.push(key);
  if (remove.length > 0) await chrome.storage.local.remove(remove);
}

/** One sweep check per page, on its first write. */
let sweepChecked = false;

function sweepOncePerPage(): void {
  if (sweepChecked) return;
  sweepChecked = true;
  // Best effort: a sweep that cannot run only leaves the records for later.
  sweepVisualsCache().catch(() => {});
}

export const setCachedVisuals = (login: string, urls: VisualUrls) => {
  setCachedVisualsMany({ [login]: urls });
};

/** Store several logins' visuals in one write (the friends list at once). */
export const setCachedVisualsMany = (entries: Record<string, VisualUrls>) => {
  const now = Date.now();
  const items: Record<string, CachedVisuals> = {};
  for (const [login, urls] of Object.entries(entries)) {
    items[`${CACHE_PREFIX}${login}`] = { ...urls, fetchedAt: now };
  }
  if (Object.keys(items).length === 0) return;
  // A cache that could not be written only costs a refetch next time.
  try {
    Promise.resolve(chrome.storage.local.set(items)).catch(() => {});
  } catch {
    // storage.local.set threw synchronously (orphaned content script)
    return;
  }
  sweepOncePerPage();
};

/** Logins known to have no cloud visuals, with the time we learned it. */
const noVisualsCache = new Map<string, number>();
const NO_VISUALS_TTL_MS = 10 * 60 * 1000;

/** True when `login` was found without cloud visuals less than ten minutes ago. */
export function knownToHaveNoVisuals(login: string): boolean {
  const knownEmptyAt = noVisualsCache.get(login);
  return !!knownEmptyAt && Date.now() - knownEmptyAt < NO_VISUALS_TTL_MS;
}

export function rememberNoVisuals(login: string): void {
  noVisualsCache.set(login, Date.now());
}
