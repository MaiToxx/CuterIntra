/**
 * The extension's background service worker. It owns the three jobs a content
 * script cannot do itself: the periodic GitHub release check (badge + stored
 * UpdateInfo), fetching Intra pages cross-origin with the user's cookies, and
 * reloading the open Intra tabs once a new cloud session is stored.
 *
 * The Chrome Web Store build (__STORE_BUILD__) has no release check: Chrome
 * updates a store install itself, and a GitHub release is tagged hours or
 * days before Google's review lets the store copy follow, so the check would
 * send every store user to a zip that installs a second copy with another
 * id. Its manifest has no "alarms" permission either (finalizeManifest), so
 * nothing here may touch chrome.alarms outside a `!__STORE_BUILD__` branch:
 * in that build chrome.alarms is undefined, and a throw at the top level
 * would stop the listeners below from being registered.
 */
import {
  UPDATE_CHECK_META_KEY,
  UPDATE_KEY,
  isNewerVersion,
  isUpdateCheckFresh,
  parseLatestRelease,
  RELEASE_ASSET_CHROME,
  RELEASE_ASSET_FIREFOX,
  type UpdateCheckMeta,
  type UpdateInfo,
} from "./core/update-check";
import { getConfig } from "./core/config.ts";
import { resolveLang, setLang, t } from "./core/i18n/i18n.ts";

// ---------------------------------------------------------------------------
// Update check (GitHub Releases of __REPO_URL__)
// ---------------------------------------------------------------------------
const UPDATE_ALARM = "better-intra-update-check";
const UPDATE_PERIOD_MINUTES = 6 * 60;
const RELEASES_API = __REPO_RELEASES_API__;
/** Delay between a new CLOUD_TOKEN and the Intra tabs reload (see onChanged). */
const RELOAD_AFTER_LOGIN_DELAY_MS = 500;
/**
 * Longest wait for one Intra page (FT_FETCH_INTRA_PAGE). The v2 Intra is often
 * slow; without a bound the card that asked keeps its skeleton up until the
 * browser's own network timeout, minutes later.
 */
const INTRA_PAGE_TIMEOUT_MS = 15000;
/** Builds before 1.8.20 kept one `FT_PROFILE_STATS_<login>` key per profile. */
const LEGACY_PROFILE_STATS_PREFIX = "FT_PROFILE_STATS_";
const PROFILE_STATS_CACHE_KEY = "FT_PROFILE_STATS_CACHE";

/**
 * In-flight update check. The alarm and the browser start-up can land in the
 * same service-worker lifetime; a second GitHub request would only get the
 * same answer (and count against the unauthenticated rate limit twice).
 */
let updateCheckInFlight: Promise<void> | null = null;

/**
 * Run a check unless one completed less than UPDATE_CHECK_INTERVAL_MS ago.
 * Only the stored result is ever shown (popup banner, hub About tab, badge),
 * so a check that is not due costs a request and changes nothing.
 */
function checkForUpdate(): Promise<void> {
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = runUpdateCheckIfDue().finally(() => {
    updateCheckInFlight = null;
  });
  return updateCheckInFlight;
}

/**
 * The toolbar badge of a known update, in the language of the settings. Read
 * at each use: the service worker can outlive a change of UI_LANGUAGE.
 */
async function updateBadgeText(): Promise<string> {
  try {
    setLang(resolveLang(await getConfig("UI_LANGUAGE")));
  } catch {
    // storage unavailable: the browser's language (the default) stays
  }
  return t("NEW");
}

/** The language changed: a badge already up follows it. */
async function relabelUpdateBadge(): Promise<void> {
  try {
    const store = await chrome.storage.local.get(UPDATE_KEY);
    if (!store[UPDATE_KEY]) return;
    await chrome.action.setBadgeText({ text: await updateBadgeText() });
  } catch {
    /* best effort */
  }
}

async function readCheckMeta(): Promise<UpdateCheckMeta | null> {
  try {
    const store = await chrome.storage.local.get(UPDATE_CHECK_META_KEY);
    const meta = store[UPDATE_CHECK_META_KEY] as UpdateCheckMeta | undefined;
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

async function runUpdateCheckIfDue(): Promise<void> {
  const meta = await readCheckMeta();
  if (isUpdateCheckFresh(meta)) return;
  await runUpdateCheck(meta);
}

async function runUpdateCheck(meta: UpdateCheckMeta | null): Promise<void> {
  const current = chrome.runtime.getManifest().version;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    // GitHub answers 304 with no body when the release did not change, and
    // documents that such conditional requests do not count against the
    // primary rate limit.
    if (meta?.etag) headers["If-None-Match"] = meta.etag;
    const res = await fetch(RELEASES_API, { headers });
    if (res.status === 304) {
      await chrome.storage.local.set({
        [UPDATE_CHECK_META_KEY]: { checkedAt: Date.now(), etag: meta?.etag } satisfies UpdateCheckMeta,
      });
      return;
    }
    if (!res.ok) return; // rate-limited or no release yet: keep previous state
    const latest = parseLatestRelease(
      await res.json(),
      __TARGET__ === "firefox" ? RELEASE_ASSET_FIREFOX : RELEASE_ASSET_CHROME,
    );
    if (!latest) return;
    const etag = res.headers.get("ETag") ?? undefined;
    const nextMeta: UpdateCheckMeta = etag
      ? { checkedAt: Date.now(), etag }
      : { checkedAt: Date.now() };
    if (isNewerVersion(latest.version, current)) {
      const info: UpdateInfo = {
        version: latest.version,
        url: latest.url,
        checkedAt: Date.now(),
      };
      await chrome.storage.local.set({
        [UPDATE_KEY]: info,
        [UPDATE_CHECK_META_KEY]: nextMeta,
      });
      await chrome.action.setBadgeBackgroundColor({ color: "#00babc" });
      await chrome.action.setBadgeText({ text: await updateBadgeText() });
    } else {
      await chrome.storage.local.remove(UPDATE_KEY);
      await chrome.storage.local.set({ [UPDATE_CHECK_META_KEY]: nextMeta });
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    console.warn("checkForUpdate: fetch failed");
  }
}

/**
 * Firefox drops alarms at browser exit and onInstalled does not fire on a
 * plain restart: without this, a session only ever got the start-up check.
 * The get() guard keeps an existing alarm's schedule (Chrome restores it).
 */
async function ensureUpdateAlarm(): Promise<void> {
  try {
    const existing = await chrome.alarms.get(UPDATE_ALARM);
    if (existing) return;
    chrome.alarms.create(UPDATE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_PERIOD_MINUTES,
    });
  } catch {
    // alarms unavailable (tests, odd runtimes): the start-up check still runs
  }
}

/**
 * Older builds stored the profile stats under one key per visited login. The
 * scan of the whole storage area this takes belongs here, once per update,
 * not in every profile tab that writes the stats cache.
 */
async function removeLegacyProfileStatsKeys(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const legacy = Object.keys(all).filter(
      (k) =>
        k.startsWith(LEGACY_PROFILE_STATS_PREFIX) && k !== PROFILE_STATS_CACHE_KEY,
    );
    if (legacy.length > 0) await chrome.storage.local.remove(legacy);
  } catch {
    /* best effort */
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  // A fresh install/update is by definition up to date: clear any stale flag.
  // The store build clears it too, in case an earlier version left one.
  void chrome.storage.local.remove([UPDATE_KEY, UPDATE_CHECK_META_KEY]);
  void chrome.action.setBadgeText({ text: "" });
  if (!__STORE_BUILD__) {
    chrome.alarms.create(UPDATE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_PERIOD_MINUTES,
    });
  }
  if (details.reason === "update") void removeLegacyProfileStatsKeys();
});

if (!__STORE_BUILD__) {
  chrome.runtime.onStartup.addListener(() => {
    void ensureUpdateAlarm();
    void checkForUpdate();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) void checkForUpdate();
  });
}

chrome.storage.onChanged.addListener((changes) => {
  if ("CLOUD_TOKEN" in changes && changes.CLOUD_TOKEN.newValue) {
    // Give the content script that just stored the session time to answer
    // the popup (FT_INTRA_LOGIN) before its tab is torn down by the reload.
    setTimeout(() => void reloadIntraTabs(), RELOAD_AFTER_LOGIN_DELAY_MS);
  }
  if ("UI_LANGUAGE" in changes) void relabelUpdateBadge();
});

/**
 * Fetch an Intra page on behalf of a content script (cross-origin, with the
 * user's Intra cookies). Content scripts are bound by the page's CORS; the
 * background is not, thanks to the *.intra.42.fr host permission.
 */
async function fetchIntraPage(
  url: unknown,
): Promise<{ ok: boolean; status?: number; text?: string }> {
  if (typeof url !== "string") return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (
    parsed.protocol !== "https:" ||
    !/(^|\.)intra\.42\.fr$/.test(parsed.hostname)
  ) {
    return { ok: false };
  }
  try {
    const res = await fetch(parsed.toString(), {
      credentials: "include",
      redirect: "follow",
      // also bounds res.text() below: the body stream is aborted with it
      signal: AbortSignal.timeout(INTRA_PAGE_TIMEOUT_MS),
    });
    // a redirect to the sign-in page means the session is gone
    if (!res.ok || /signin\.intra\.42\.fr/.test(res.url)) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status, text: await res.text() };
  } catch {
    return { ok: false };
  }
}

/**
 * The two pages the correction stats read (profile-stats-intra.ts), and
 * nothing else: the fetch carries the user's Intra cookies.
 */
const INTRA_PAGE_PATHS = [
  /^https:\/\/projects\.intra\.42\.fr\/users\/[a-z0-9_.-]+\/feedbacks\?as=corrector&page=\d+$/i,
  /^https:\/\/profile\.intra\.42\.fr\/users\/[a-z0-9_.-]+\/correction_point_historics$/i,
];

/** One of our content scripts on an Intra page, not another context. */
function fromIntraPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    return /(^|\.)intra\.42\.fr$/.test(new URL(sender.url ?? sender.tab?.url ?? "").hostname);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FT_FETCH_INTRA_PAGE") {
    if (
      !fromIntraPage(sender) ||
      typeof message.url !== "string" ||
      !INTRA_PAGE_PATHS.some((allowed) => allowed.test(message.url))
    ) {
      sendResponse({ ok: false });
      return false;
    }
    fetchIntraPage(message.url)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "FT_RELOAD_INTRA_TABS") {
    reloadIntraTabs()
      .catch(() => undefined)
      .finally(sendResponse);
    return true;
  }
  return undefined;
});

/**
 * Reload the open v3 profile tabs so their widgets pick up the new session.
 * Only that SPA latches a signed-out state (friends widget, hub cloud gates,
 * the cards that need a session). The v2 hosts read CLOUD_TOKEN at use time
 * through the settings snapshot, which storage.onChanged keeps current, and a
 * reload there would throw away whatever is being typed: an evaluation
 * feedback on projects.intra.42.fr, a forum post, a slot form.
 */
async function reloadIntraTabs() {
  const tabs = await chrome.tabs.query({
    url: "https://profile-v3.intra.42.fr/*",
  });
  // nothing to refresh: never reload an unrelated active tab
  if (tabs.length === 0) return;
  for (const tab of tabs) {
    if (tab.id) chrome.tabs.reload(tab.id);
  }
}

// Every event-page load / service-worker wake repairs a missing alarm, even
// when onStartup did not fire (e.g. the add-on re-enabled mid-session).
if (!__STORE_BUILD__) void ensureUpdateAlarm();
