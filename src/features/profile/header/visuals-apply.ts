/**
 * The apply step of the profile visuals: paints a VisualUrls object onto the
 * page (avatar, banner, background, badge colour, card theme, published look
 * and logtime settings) and answers "is it still painted?".
 *
 * WHY a module of its own: both visuals.ts (every mutation pass) and the
 * editor in profile.modal.ts (live preview) paint visuals. With the painting
 * inside visuals.ts, which also opens the editor, the two modules imported
 * each other. Here it depends on neither, so the edges point one way:
 * visuals.ts -> profile.modal.ts -> visuals-apply.ts.
 */
import { html, render } from "lit-html";
import { getConfig } from "../../../core/config.ts";
import {
  AVATAR_SELECTOR,
  BANNER_SELECTOR,
  BACKGROUND_SELECTOR,
  TITLE_BADGE_SELECTOR,
} from "../../../core/intra/selectors.ts";
import { injectIntraShellFix } from "../../../core/intra/shell-fix.ts";
import { applyThemeToProfileCard } from "./profile-card.ts";
import { applyPublicLogtimeSettings, initLogtime } from "../../logtime/logtime.ts";
import { sanitizeVisualUrls } from "./visuals-sanitize.ts";
import { applyVisitorLook } from "../../customize/customize.ts";
import type { PublicLook } from "../../customize/public-look.ts";
import { savePreset, snapshotCustomization } from "../../customize/presets.ts";
import {
  applyProfileExtras,
  clearProfileExtras,
  extrasAreVisible,
} from "../extras/extras-apply.ts";
import type { VisualUrls } from "./visuals-types.ts";
import { t } from "../../../core/i18n/i18n.ts";
import { css } from "../../../core/dom/css.ts";

/**
 * What the apply step needs to know about the page it paints. visuals.ts
 * writes it when the viewed profile changes and avatar-clicks.ts when the
 * visitor toggles the avatar. One shared object, because a module cannot
 * assign to a `let` it imported.
 */
export const pageState = {
  /** Login of the profile on screen ("me" while my own login is unknown). */
  lastUser: null as string | null,
  /** Login of the signed-in user (null until known), to tell my page from someone else's. */
  ownLogin: null as string | null,
  /** The visitor clicked the avatar to see the Intra picture instead of the custom one. */
  showingOriginalAvatar: false,
  /** Intra's own avatar url, remembered before the custom one replaced it. */
  originalAvatarUrl: null as string | null,
};

// ---------------------------------------------------------------------------
// CSS helpers
// ---------------------------------------------------------------------------

const URL_RE = /url\((["']?)(.*?)\1\)/;

/**
 * Is `url` the background image currently showing on `el`?
 *
 * The inline style is read first and getComputedStyle() is only reached when
 * it does not answer: getComputedStyle forces a style recalculation, and this
 * runs on every mutation pass of the profile page.
 */
const hasBackground = (el: HTMLElement | null, url?: string) => {
  if (!url) return true;
  if (!el) return false;
  const inline = el.style.backgroundImage || "";
  if (inline.match(URL_RE)?.[2] === url) return true;
  const computed = window.getComputedStyle(el).backgroundImage || "";
  return computed.match(URL_RE)?.[2] === url;
};

const modeCss: Record<string, string> = {
  fill: "background-size: cover !important; background-repeat: no-repeat !important; background-position: center !important;",
  fit: "background-size: contain !important; background-repeat: no-repeat !important; background-position: center !important;",
  stretch:
    "background-size: 100% 100% !important; background-repeat: no-repeat !important; background-position: center !important;",
  center:
    "background-size: auto !important; background-repeat: no-repeat !important; background-position: center !important;",
  tile: "background-size: auto !important; background-repeat: repeat !important; background-position: top left !important;",
};

/** The exact rule applyImgs() writes for a banner image (shared so both stay in sync). */
const bannerImageCss = (urls: VisualUrls): string =>
  `background-image: url("${urls.banner}") !important; ${
    modeCss[urls.bannerMode || "fill"] || modeCss.fill
  }`;

/** The exact rule applyImgs() writes for a background image. */
const backgroundImageCss = (urls: VisualUrls): string =>
  `background-image: url("${urls.background}") !important; ${
    modeCss[urls.backgroundMode || "fill"] || modeCss.fill
  }`;

/**
 * True when our <style> element already holds exactly the rule we would write.
 *
 * Banners and backgrounds are applied through a stylesheet, not inline, so
 * comparing the rule text answers "is it applied?" with a plain DOM read
 * instead of a forced style recalculation. When the text matches, re-running
 * applyImgs() would write the very same rule, so there is nothing to redo.
 */
const styleRuleIs = (id: string, selector: string, cssText: string): boolean =>
  document.getElementById(id)?.textContent === `${selector} { ${cssText} }`;

const setStyleForSelector = (id: string, selector: string, cssText: string) => {
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = selector ? `${selector} { ${cssText} }` : "";
};

export const badgeColorCss = (badgeBg?: string): string => {
  if (!badgeBg) return "";
  return `background-color: ${badgeBg} !important; border-color: ${badgeBg} !important;`;
};

// ---------------------------------------------------------------------------
// Is it still painted?
// ---------------------------------------------------------------------------

export const needsReapply = (urls: VisualUrls) => {
  const avatar = document.querySelector(AVATAR_SELECTOR) as HTMLElement | null;
  const banner = document.querySelector(BANNER_SELECTOR) as HTMLElement | null;
  const background = document.querySelector(
    BACKGROUND_SELECTOR,
  ) as HTMLElement | null;

  // While the profile watcher holds the avatar (holdAvatar), the page sheet
  // keeps it at opacity 0 until we have applied the visuals, and applyImgs()
  // is what reveals it. React handing us a freshly rendered element (no inline
  // opacity) therefore always needs a re-apply - this check is what makes the
  // cheaper checks below safe to trust.
  if (avatar && !pageState.showingOriginalAvatar && avatar.style.opacity !== "1")
    return true;
  if (
    urls?.avatar &&
    !pageState.showingOriginalAvatar &&
    !hasBackground(avatar, urls.avatar)
  )
    return true;
  if (urls.avatar && avatar) {
    const pos = avatar.style.getPropertyValue("background-position");
    const size = avatar.style.getPropertyValue("background-size");
    const expectedPos = `${urls.avatarPosX ?? 50}% ${urls.avatarPosY ?? 50}%`;
    const expectedSize = `${urls.avatarScale ?? 100}%`;
    if (pos !== expectedPos || size !== expectedSize) return true;
  }
  if (
    urls?.banner &&
    !styleRuleIs("ft-banner-style", BANNER_SELECTOR, bannerImageCss(urls)) &&
    !hasBackground(banner, urls.banner)
  )
    return true;
  if (urls?.bannerColor && banner) {
    const style = document.getElementById("ft-banner-style");
    const expectedColor = `background-color: ${urls.bannerColor} !important; background-image: none !important;`;
    if (
      !style ||
      style.textContent !== `${BANNER_SELECTOR} { ${expectedColor} }`
    )
      return true;
  }
  if (
    urls?.background &&
    !styleRuleIs(
      "ft-bg-style",
      BACKGROUND_SELECTOR,
      backgroundImageCss(urls),
    ) &&
    !hasBackground(background, urls.background)
  )
    return true;
  if (urls?.backgroundColor && background) {
    const style = document.getElementById("ft-bg-style");
    const expectedColor = `background-color: ${urls.backgroundColor} !important; background-image: none !important;`;
    if (
      !style ||
      style.textContent !== `${BACKGROUND_SELECTOR} { ${expectedColor} }`
    )
      return true;
  }
  // applyImgs() always writes this rule, empty braces included, so that is
  // what we have to compare against. Expecting an empty <style> when no badge
  // colour is set (the default!) made needsReapply() return true on every
  // single pass, and applyImgs re-ran for nothing on every mutation burst.
  if (
    !styleRuleIs(
      "ft-badge-color-style",
      TITLE_BADGE_SELECTOR,
      badgeColorCss(urls.badgeBg),
    )
  )
    return true;
  return false;
};

// ---------------------------------------------------------------------------
// Page stylesheet
// ---------------------------------------------------------------------------

/**
 * Class on <html> while the profile watcher runs (profile.ts). The page sheet
 * hides the avatar only under it: an inline `opacity: 1` from applyImgs() is
 * the only thing that shows it again, and nothing sets one once the watcher
 * has stopped, so an unconditional rule left every avatar React mounted after
 * that (a later header render, a route change to another profile) invisible
 * for the rest of the visit. Released, a re-mounted avatar shows the Intra
 * picture instead of nothing.
 */
export const AVATAR_PENDING_CLASS = "ft-avatar-pending";

/** Hide the avatar until the visuals are applied: the watcher is about to paint it. */
export const holdAvatar = (): void => {
  document.documentElement.classList.add(AVATAR_PENDING_CLASS);
};

/** The watcher stopped: nothing will reveal a new avatar element any more. */
export const releaseAvatar = (): void => {
  document.documentElement.classList.remove(AVATAR_PENDING_CLASS);
};

const AVATAR_PENDING_STYLE_ID = "ft-avatar-pending-style";

/**
 * The one rule that makes holdAvatar() effective. Installed by main.ts at
 * document_start, on its own: the hold has to be in place before the React app
 * paints, and the rest of the profile sheet only arrives with initProfile().
 * A static rule replaces the document-wide MutationObserver that used to write
 * an inline `opacity: 0` on the first avatar it saw (and then never
 * disconnected on pages without one). <head> may not be parsed yet at
 * document_start, so the sheet goes on <html> if it has to.
 */
export const injectAvatarPendingRule = (): void => {
  // Rides along: main.ts calls this at document_start on the profile origin
  // whatever the feature toggles, which is what the shell fix needs too.
  injectIntraShellFix();
  if (document.getElementById(AVATAR_PENDING_STYLE_ID)) return;
  const host = document.head || document.documentElement;
  if (!host) return;
  const style = document.createElement("style");
  style.id = AVATAR_PENDING_STYLE_ID;
  style.textContent = `html.${AVATAR_PENDING_CLASS} ${AVATAR_SELECTOR} { opacity: 0 !important; }`;
  host.appendChild(style);
};

export const injectCustomStyles = () => {
  injectAvatarPendingRule();
  if (document.getElementById("ft-profile-host-styles")) return;
  const style = document.createElement("style");
  style.id = "ft-profile-host-styles";
  style.textContent = css`
    .bg-ft-gray b,
      .bg-ft-gray span {font-size: 1.2rem !important;font-weight: bold !important;font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;}
      p.text-sm:nth-child(2) {font-size: 1.3rem !important;}
    #profile-modal-host { 
      position: fixed; inset: 0; z-index: 999999; 
      display: flex; align-items: flex-start; justify-content: center;
      pointer-events: auto; padding-top: 12vh;       
    }
    ${AVATAR_SELECTOR} {
      will-change: background-image, transform;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
    }
    ${AVATAR_SELECTOR}[data-modal-listener] {
      position: relative !important;
    }
    ${AVATAR_SELECTOR}[data-modal-listener]::after {
      content: ${JSON.stringify(t("Edit"))};
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: rgba(0,0,0,0.45);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      font-family: system-ui, sans-serif;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }
    ${AVATAR_SELECTOR}[data-modal-listener]:hover::after {
      opacity: 1;
    }
    ${BANNER_SELECTOR},
    ${BACKGROUND_SELECTOR} {
      will-change: background-image, transform;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
    }
    @media (min-width: 1280px) {
      ${BACKGROUND_SELECTOR} {
        height: auto !important;
        min-height: 18rem !important;
      }
    }
    .bg-mode-fill { background-size: cover !important; background-repeat: no-repeat !important; background-position: center !important; }
    .bg-mode-fit { background-size: contain !important; background-repeat: no-repeat !important; background-position: center !important; }
    .bg-mode-stretch { background-size: 100% 100% !important; background-repeat: no-repeat !important; background-position: center !important; }
    .bg-mode-center { background-size: auto !important; background-repeat: no-repeat !important; background-position: center !important; }
    .bg-mode-tile { background-size: auto !important; background-repeat: repeat !important; background-position: top left !important; }

    .banner-mode-fill { background-size: cover !important; background-repeat: no-repeat !important; background-position: center !important; }
    .banner-mode-fit { background-size: contain !important; background-repeat: no-repeat !important; background-position: center !important; }
    .banner-mode-stretch { background-size: 100% 100% !important; background-repeat: no-repeat !important; background-position: center !important; }
    .banner-mode-center { background-size: auto !important; background-repeat: no-repeat !important; background-position: center !important; }
    .banner-mode-tile { background-size: auto !important; background-repeat: repeat !important; background-position: top left !important; }

    .ft-deco-solid {
      box-shadow: 0 0 0 3px var(--user-color, #00babc) !important;
    }

    html.dark .inline-flex.items-center.rounded.border.shadow-base {
      color: #fff !important;
    }

    html:not(.dark) .inline-flex.items-center.rounded.border.shadow-base {
      color: #fff !important;
    }
  `;
  document.head.appendChild(style);
};

// ---------------------------------------------------------------------------
// Visitor look
// ---------------------------------------------------------------------------

const LOOK_BADGE_ID = "ft-visitor-look-badge";
let lookBadgeLogin: string | null = null;
/** The look on screen, read when "Save" is pressed (it can arrive after the badge). */
let lookOnScreen: PublicLook | null = null;

/**
 * Keeps someone's published look as a preset of mine, named after them. Laid
 * over my own settings: what a look does not carry (fonts, font size, my
 * custom CSS) stays mine. It used to take a theme code sent by the owner.
 */
export async function saveVisitorLook(login: string, look: PublicLook): Promise<string> {
  const name = t("{login}'s style", { login });
  await savePreset(name, { ...(await snapshotCustomization()), ...look });
  return name;
}

/**
 * Apply the look published by the profile's owner (or clear it) and show a
 * small badge saying whose look is displayed, with a way to hide it for
 * this visit. Skipped when the viewer hid it for this login in this tab.
 */
export function showVisitorLook(
  look: PublicLook | null,
  extras: Record<string, unknown> | null = null,
  hasBackgroundImage = false,
): void {
  const { lastUser, ownLogin } = pageState;
  const login = lastUser && lastUser !== "me" ? lastUser : null;
  const hiddenKey = login ? `ft-look-hidden-${login}` : "";
  const hidden = hiddenKey ? sessionStorage.getItem(hiddenKey) === "1" : false;
  // My own page never shows a "visitor" look; its extras are rendered from
  // local settings by applyOwnProfileExtras() (see updateVisuals).
  const own = !login || login === ownLogin;
  // Everyone who syncs publishes the default colours, so a non-null
  // `extras` means nothing by itself: ask the sanitizer.
  const visibleExtras = !!extras && extrasAreVisible(extras);
  const active = !own && !hidden && (!!look || visibleExtras);
  lookOnScreen = active ? look : null;
  void applyVisitorLook(active && look ? look : null);
  if (!own) {
    if (active && visibleExtras) {
      void applyProfileExtras(extras, { login: login!, own: false, hasBackgroundImage });
    } else {
      clearProfileExtras();
    }
  }

  const existing = document.getElementById(LOOK_BADGE_ID);
  if (!active) {
    existing?.remove();
    lookBadgeLogin = null;
    return;
  }
  if (existing && lookBadgeLogin === login) return;
  lookBadgeLogin = login;
  const host = existing ?? document.createElement("div");
  host.id = LOOK_BADGE_ID;
  const hide = () => {
    sessionStorage.setItem(hiddenKey, "1");
    showVisitorLook(null);
  };
  const save = async (e: Event) => {
    const button = e.currentTarget as HTMLButtonElement;
    if (!lookOnScreen || !login) return;
    try {
      const name = await saveVisitorLook(login, lookOnScreen);
      button.textContent = t("✓ Saved");
      button.title = t('Saved as "{name}" in Customize > Presets', { name });
      button.disabled = true;
    } catch {
      button.textContent = t("Not saved");
    }
  };
  render(
    html`<style>
        #${LOOK_BADGE_ID} {
          position: fixed; right: 16px; bottom: 16px; z-index: 99990;
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px 6px 12px; border-radius: 999px;
          font: 500 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
          background: hsl(var(--card, 220 20% 10%)); color: hsl(var(--card-foreground, 0 0% 95%));
          border: 1px solid hsl(var(--border, 220 20% 18%));
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
        }
        #${LOOK_BADGE_ID} button {
          all: unset; cursor: pointer; opacity: 0.6; padding: 2px 6px; border-radius: 999px; line-height: 1;
        }
        #${LOOK_BADGE_ID} button:hover { opacity: 1; background: hsl(var(--muted, 220 20% 15%)); }
      </style>
      <span
        title="${t("This profile is shown with the look and extras its owner published with Cuter Intra")}"
        >🎨 ${t("{login}'s style", { login: login! })}</span
      >
      ${look
        ? html`<button
            type="button"
            title="${t("Keep this style in my presets (Customize > Presets)")}"
            @click=${save}
          >${t("Save")}</button>`
        : ""}
      <button
        type="button"
        title="${t("Show my own style instead (this visit only)")}"
        aria-label="${t("Show my own style instead")}"
        @click=${hide}
      >✕</button>`,
    host,
  );
  if (!existing) (document.body || document.documentElement).appendChild(host);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export const applyImgs = (rawUrls: VisualUrls | null) => {
  if (!rawUrls) return;
  // Values may come from another user's cloud settings and end up in <style>
  // text and class names: never trust them as-is.
  const urls = sanitizeVisualUrls(rawUrls);

  const avatar = document.querySelector(AVATAR_SELECTOR) as HTMLElement | null;

  if (avatar && !pageState.originalAvatarUrl) {
    const inlineStyle = avatar.style.backgroundImage;
    if (
      inlineStyle &&
      inlineStyle !== "none" &&
      !inlineStyle.includes(urls.avatar)
    ) {
      const match = inlineStyle.match(/url\((['"]?)(.*?)\1\)/);
      if (match) pageState.originalAvatarUrl = match[2];
    }
    // Once our own url is the inline background, the computed value can only
    // be that same url: probing it would force a style recalculation to learn
    // nothing. (The inline style always wins over the cascade.)
    if (!pageState.originalAvatarUrl && !inlineStyle.includes(urls.avatar)) {
      const computedBg = window.getComputedStyle(avatar).backgroundImage;
      if (
        computedBg &&
        computedBg !== "none" &&
        !computedBg.includes(urls.avatar)
      ) {
        const match = computedBg.match(/url\((['"]?)(.*?)\1\)/);
        if (match) pageState.originalAvatarUrl = match[2];
      }
    }
  }

  if (avatar && urls.avatar && !pageState.showingOriginalAvatar) {
    avatar.style.setProperty(
      "background-image",
      `url("${urls.avatar}")`,
      "important",
    );
    avatar.style.setProperty(
      "background-color",
      urls.avatarBg || "transparent",
      "important",
    );
    avatar.style.setProperty(
      "background-size",
      `${urls.avatarScale ?? 100}%`,
      "important",
    );
    avatar.style.setProperty(
      "background-position",
      `${urls.avatarPosX ?? 50}% ${urls.avatarPosY ?? 50}%`,
      "important",
    );
  }
  if (avatar && !pageState.showingOriginalAvatar) {
    avatar.style.setProperty("opacity", "1", "important");
  }

  if (avatar) {
    avatar.classList.remove("ft-deco-solid");
    const deco = urls.decoration;
    if (deco && deco !== "none") avatar.classList.add(`ft-deco-${deco}`);
  }

  if (urls.banner) {
    setStyleForSelector("ft-banner-style", BANNER_SELECTOR, bannerImageCss(urls));
  } else if (urls.bannerColor) {
    setStyleForSelector(
      "ft-banner-style",
      BANNER_SELECTOR,
      `background-color: ${urls.bannerColor} !important; background-image: none !important;`,
    );
  } else {
    setStyleForSelector("ft-banner-style", BANNER_SELECTOR, "");
  }

  if (urls.background) {
    setStyleForSelector(
      "ft-bg-style",
      BACKGROUND_SELECTOR,
      backgroundImageCss(urls),
    );
  } else if (urls.backgroundColor) {
    setStyleForSelector(
      "ft-bg-style",
      BACKGROUND_SELECTOR,
      `background-color: ${urls.backgroundColor} !important; background-image: none !important;`,
    );
  } else {
    setStyleForSelector("ft-bg-style", BACKGROUND_SELECTOR, "");
  }

  if (urls.theme) {
    applyThemeToProfileCard(urls.theme);
  }

  showVisitorLook(urls.look ?? null, urls.extras ?? null, !!urls.background);

  setStyleForSelector(
    "ft-badge-color-style",
    TITLE_BADGE_SELECTOR,
    badgeColorCss(urls.badgeBg),
  );

  if (urls.logtime) {
    const logtime = urls.logtime;
    // Respect the user's feature toggle: viewing a profile that publishes
    // logtime settings must not render the widget for someone who disabled it.
    getConfig("ACTIVE_SCRIPTS").then((scripts) => {
      if (!Array.isArray(scripts) || !scripts.includes("logtime")) return;
      return initLogtime().then(() => applyPublicLogtimeSettings(logtime));
    });
  }
};
