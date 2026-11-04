/**
 * Custom profile visuals (avatar, banner, background, badge colour, and the
 * look a user published): decides, on every mutation pass of a profile page,
 * whether the visuals of the profile on screen must be read, fetched,
 * re-applied or left alone.
 *
 * The work itself lives next door, so that every import points one way:
 *   visuals-types.ts   the VisualUrls shape
 *   visuals-cache.ts   own login, per-login storage cache, "applied" key
 *   visuals-apply.ts   painting the page and checking it is still painted
 *   avatar-clicks.ts   the avatar click (editor on my page, toggle elsewhere)
 * The names other modules import from here are re-exported unchanged.
 */
import { getConfig, getConfigMany } from "../../../core/config.ts";
import { waitForElement } from "../../../core/dom/dom-wait.ts";
import { AVATAR_SELECTOR, EDIT_VISUALS_HASH } from "../../../core/intra/selectors.ts";
import { fetchUserVisuals } from "../../account/account.ts";
import { sanitizeVisualUrls } from "./visuals-sanitize.ts";
import { applyOwnProfileExtras } from "../extras/extras-apply.ts";
import type { VisualUrls } from "./visuals-types.ts";
import {
  getCachedVisuals,
  getVisualKey,
  installHistoryListener,
  knownToHaveNoVisuals,
  readOwnLogin,
  rememberNoVisuals,
  setCachedVisuals,
  visualsAreFresh,
} from "./visuals-cache.ts";
import {
  applyImgs,
  injectCustomStyles,
  needsReapply,
  pageState,
  showVisitorLook,
} from "./visuals-apply.ts";
import { attachEditorListener, attachToggleListener } from "./avatar-clicks.ts";
import { retryPendingUploadCleanup } from "./upload-cleanup.ts";

export type { VisualUrls } from "./visuals-types.ts";
export { applyImgs, badgeColorCss, injectCustomStyles } from "./visuals-apply.ts";

/** Budget for the avatar to be rendered by React (~30 frames, as before). */
const AVATAR_WAIT_MS = 500;

let isFetching = false;
let visualCache: VisualUrls | null = null;
let lastAppliedUser: string | null = null;
let lastAppliedKey: string | null = null;

const pendingRevalidations = new Set<string>();

/** Does another user's record carry anything to paint or show? */
const hasVisuals = (urls: VisualUrls): boolean =>
  !!(
    urls.avatar ||
    urls.banner ||
    urls.bannerColor ||
    urls.background ||
    urls.backgroundColor ||
    urls.badgeBg ||
    urls.theme ||
    urls.logtime ||
    urls.look ||
    urls.extras
  );

/**
 * First look at a peer with nothing stored: ask the worker without holding up
 * the pass.
 *
 * WHY: the pass used to await this request before any card init, so the marks
 * dates, the freeze countdown, the roulette card, the info card and the Add
 * friend button all waited for the worker (up to the 8 s timeout when it
 * hangs), mostly to learn that the student publishes nothing. The answer is
 * painted when it lands, as revalidateVisuals() already does. The avatar hold
 * still ends with the watcher (profile.ts): an answer slower than the whole
 * pass shows the Intra picture first rather than no avatar for 8 s.
 */
const fetchPeerVisuals = (login: string, avatarEl: HTMLElement): void => {
  isFetching = true;
  void fetchUserVisuals(login)
    .then((cloudUrls) => {
      if (login !== pageState.lastUser) return;
      if (cloudUrls && hasVisuals(cloudUrls)) {
        visualCache = cloudUrls;
        setCachedVisuals(login, cloudUrls);
        applyImgs(cloudUrls);
        lastAppliedUser = login;
        lastAppliedKey = getVisualKey(cloudUrls);
        // React may have swapped the avatar element while the request was out.
        const avatar = document.querySelector<HTMLElement>(AVATAR_SELECTOR);
        if (cloudUrls.avatar && avatar) {
          attachToggleListener(avatar, () => visualCache);
        }
      } else if (cloudUrls) {
        // A failed request (null) is not "no visuals": the next pass asks again.
        rememberNoVisuals(login);
      }
    })
    .catch((e) => console.warn("Cuter Intra: visuals", e))
    .finally(() => {
      // Another profile's pass owns the flag and the avatar by now.
      if (login !== pageState.lastUser) return;
      isFetching = false;
      // applyImgs() has revealed the current avatar; this covers "no
      // visuals" and a failure, on the element React may have replaced too.
      avatarEl.style.setProperty("opacity", "1", "important");
      document
        .querySelector<HTMLElement>(AVATAR_SELECTOR)
        ?.style.setProperty("opacity", "1", "important");
    });
};

const revalidateVisuals = async (login: string, cached: VisualUrls) => {
  if (pendingRevalidations.has(login)) return;
  pendingRevalidations.add(login);
  try {
    const fresh = await fetchUserVisuals(login);
    if (!fresh || login !== pageState.lastUser) return;
    const freshKey = getVisualKey(fresh);
    const cachedKey = getVisualKey(cached);
    if (freshKey === cachedKey) {
      // Identical to what is stored (the key covers every field of
      // VisualUrls): re-writing it would only wake every storage.onChanged
      // listener, including the background service worker.
      return;
    }
    visualCache = fresh;
    setCachedVisuals(login, fresh);
    if (
      lastAppliedUser === login &&
      lastAppliedKey === freshKey &&
      !needsReapply(fresh)
    )
      return;
    applyImgs(fresh);
    lastAppliedUser = login;
    lastAppliedKey = freshKey;
  } finally {
    pendingRevalidations.delete(login);
  }
};

export const updateVisuals = async () => {
  const pathParts = location.pathname.split("/").filter((p) => p);
  injectCustomStyles();
  installHistoryListener();

  let avatarEl = document.querySelector(AVATAR_SELECTOR) as HTMLElement;

  let myLogin = await readOwnLogin();
  if (!myLogin) myLogin = "me";
  pageState.ownLogin = myLogin;

  const targetLogin =
    pathParts[0] === "users" && pathParts[1] ? pathParts[1] : myLogin;

  if (targetLogin !== pageState.lastUser) {
    visualCache = null;
    pageState.originalAvatarUrl = null;
    pageState.showingOriginalAvatar = false;
    pageState.lastUser = targetLogin;
    isFetching = false;
    lastAppliedUser = null;
    lastAppliedKey = null;
    showVisitorLook(null);
    if (avatarEl) avatarEl.style.setProperty("opacity", "1", "important");
  }

  if (!avatarEl) {
    // ~30 frames, but observed instead of polled: the element is picked up on
    // the microtask that follows its insertion (so the avatar stops flashing
    // sooner) and a page without one costs a single observer instead of 30
    // querySelectors spread over half a second of held-up pass.
    avatarEl = (await waitForElement<HTMLElement>(AVATAR_SELECTOR, {
      timeoutMs: AVATAR_WAIT_MS,
    })) as HTMLElement;
    if (!avatarEl) return;
  }

  if (targetLogin === myLogin) {
    void applyOwnProfileExtras(myLogin);
    // A removed upload whose delete had to wait (the push before it failed)
    // is tried again here, once per page: see upload-cleanup.ts.
    void retryPendingUploadCleanup();
    attachEditorListener(avatarEl, (updatedVisuals) => {
      visualCache = updatedVisuals;
      setCachedVisuals(targetLogin, updatedVisuals);
      applyImgs(visualCache);
      lastAppliedUser = targetLogin;
      lastAppliedKey = getVisualKey(visualCache);
    });
    // Sent here by the hub's Edit from another page: open the editor through
    // the avatar (its listener holds the save callback above), once. The
    // hash goes first, so a reload or the next pass does not open it again.
    if (location.hash === EDIT_VISUALS_HASH) {
      history.replaceState(history.state, "", location.pathname + location.search);
      avatarEl.click();
    }
  }

  if (visualCache) {
    if (document.getElementById("profile-modal-host")) return;
    const key = getVisualKey(visualCache);
    const reapply = needsReapply(visualCache);
    if (lastAppliedUser === targetLogin && lastAppliedKey === key && !reapply) {
      if (targetLogin !== myLogin) {
        showVisitorLook(
          visualCache.look ?? null,
          visualCache.extras ?? null,
          !!visualCache.background,
        );
      }
      return;
    }

    applyImgs(visualCache);
    lastAppliedUser = targetLogin;
    lastAppliedKey = key;
    return;
  }

  if (!isFetching) {
    if (targetLogin === myLogin) {
      // one storage read instead of thirteen serial ones
      const c = await getConfigMany([
        "PROFILE_IMAGE_URL",
        "PROFILE_BANNER_URL",
        "PROFILE_BANNER_MODE",
        "PROFILE_BANNER_COLOR",
        "PROFILE_BACKGROUND_URL",
        "PROFILE_BACKGROUND_MODE",
        "PROFILE_BACKGROUND_COLOR",
        "PROFILE_AVATAR_BG",
        "PROFILE_DECORATION",
        "PROFILE_AVATAR_POSITION_X",
        "PROFILE_AVATAR_POSITION_Y",
        "PROFILE_AVATAR_SCALE",
        "PROFILE_BADGE_BG",
      ] as const);
      visualCache = {
        avatar: c.PROFILE_IMAGE_URL,
        banner: c.PROFILE_BANNER_URL,
        bannerMode: c.PROFILE_BANNER_MODE || "fill",
        bannerColor: c.PROFILE_BANNER_COLOR,
        background: c.PROFILE_BACKGROUND_URL,
        backgroundMode: c.PROFILE_BACKGROUND_MODE || "fill",
        backgroundColor: c.PROFILE_BACKGROUND_COLOR,
        avatarBg: c.PROFILE_AVATAR_BG,
        decoration: c.PROFILE_DECORATION,
        avatarPosX: c.PROFILE_AVATAR_POSITION_X,
        avatarPosY: c.PROFILE_AVATAR_POSITION_Y,
        avatarScale: c.PROFILE_AVATAR_SCALE,
        badgeBg: c.PROFILE_BADGE_BG,
      };
      // sanitise at ingestion so that needsReapply()/getVisualKey() compare
      // exactly what applyImgs() writes (otherwise a normalised URL would
      // look "not applied" and trigger a re-apply on every mutation pass)
      visualCache = sanitizeVisualUrls(visualCache);

      if (
        !visualCache.avatar &&
        !visualCache.banner &&
        !visualCache.bannerColor &&
        !visualCache.background &&
        !visualCache.backgroundColor &&
        !visualCache.badgeBg
      ) {
        avatarEl.style.setProperty("opacity", "1", "important");
      } else if (!document.getElementById("profile-modal-host")) {
        applyImgs(visualCache);
        lastAppliedUser = targetLogin;
        lastAppliedKey = getVisualKey(visualCache);
      }
    } else {
      // Negative cache: a user without cloud visuals used to be re-fetched on
      // every mutation pass. Checked before the storage read (it used to sit
      // after it), those passes now cost nothing at all: visualCache stays
      // null for such a user, so every pass came back here.
      if (knownToHaveNoVisuals(targetLogin)) {
        avatarEl.style.setProperty("opacity", "1", "important");
        return;
      }
      const cached = await getCachedVisuals(targetLogin);
      // A record stored less than ten minutes ago (typically by the friends
      // widget, a click before this visit) is what the worker would answer:
      // asking again cost a worker call and a KV read of the whole record, on
      // a URL the browser's cache could not serve (?login= vs ?logins=).
      const fresh = visualsAreFresh(cached);
      if (cached && hasVisuals(cached)) {
        visualCache = sanitizeVisualUrls(cached);
        applyImgs(visualCache);
        lastAppliedUser = targetLogin;
        lastAppliedKey = getVisualKey(visualCache);
        if (visualCache.avatar) attachToggleListener(avatarEl, () => visualCache);
        if (!fresh) void revalidateVisuals(targetLogin, cached);
      } else if (cached && fresh) {
        // The friends widget stores "no visuals" answers too.
        rememberNoVisuals(targetLogin);
        avatarEl.style.setProperty("opacity", "1", "important");
      } else {
        fetchPeerVisuals(targetLogin, avatarEl);
      }
    }
  }
};

const NAV_AVATAR_SELECTOR =
  'img.aspect-square.h-full.w-full[src*="cdn.intra.42.fr"]';
/** Same budget as the old 20 x 250 ms poll. */
const NAV_AVATAR_WAIT_MS = 5000;
let _navAvatarDone = false;

export async function updateNavAvatar(): Promise<void> {
  if (_navAvatarDone) return;
  const customUrl = await getConfig("PROFILE_IMAGE_URL");

  // Observed, not polled: 20 timer wake-ups and 20 document-wide
  // querySelectors on every Intra page became one observer that fires once.
  const img = await waitForElement<HTMLImageElement>(NAV_AVATAR_SELECTOR, {
    timeoutMs: NAV_AVATAR_WAIT_MS,
  });
  if (!img || img.dataset.ftNavAvatar) return;
  img.style.objectFit = "cover";
  if (customUrl) {
    img.src = customUrl;
  }
  img.dataset.ftNavAvatar = "1";
  _navAvatarDone = true;
}
