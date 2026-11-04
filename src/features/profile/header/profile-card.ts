import { getConfig } from "../../../core/config.ts";
import { CLUSTERS, getClusterData } from "../../clusters/clusters.data.ts";
import { openClusterDialog } from "../../clusters/map-dialog.ts";
import { findClusterForSeat } from "../../clusters/map-dialog/helpers.ts";
import { adoptSharedStyles } from "../../../core/styles/shared-styles.ts";
import { bindTooltips } from "../../../core/dom/tooltip.ts";
import { appendSvg } from "../../../core/dom/svg.ts";
import {
  getIsLight,
  onThemeChange,
  widgetTheme,
} from "../../../core/theme/theme-manager.ts";
import {
  PROFILE_CARD_SELECTOR,
  PROFILE_PASS_DEADLINE_MS,
  probeSelectorAt,
} from "../../../core/intra/selectors.ts";
import ARROW_SHARE_SVG from "../../../assets/svg/arrow_share.svg?raw";
import { initShortcutButtons, initFriendBadge } from "./personal-info.ts";
import { injectCampusFlag } from "../../campus/campus-flags.ts";
import { t } from "../../../core/i18n/i18n.ts";
import { css } from "../../../core/dom/css.ts";

const PROFILE_CARD_CLASS = "ft-profile-card";
const SHADOW_HOST_ID = "profile-badges-shadow";
const INFO_CARD_ID = "ft-info-card";

let _badgeTheme: string = "dark";
let _cursusListenerInitialized = false;
let _themeListenerInitialized = false;

/**
 * The hub's theme toggle restyles the page live; the info card sits in a
 * shadow root with its own data-theme and would keep the old one until a
 * reload.
 */
function followThemeChanges() {
  if (_themeListenerInitialized) return;
  _themeListenerInitialized = true;
  onThemeChange(({ theme, preset }) => {
    _badgeTheme = widgetTheme(theme, preset);
    document
      .getElementById(SHADOW_HOST_ID)
      ?.shadowRoot?.getElementById(INFO_CARD_ID)
      ?.setAttribute("data-theme", _badgeTheme);
  });
}

/**
 * Enter and Space activate `el` as they would a native button. For badges that
 * must stay <div>s (the flex/badge layout and the [data-ft-seat] rules depend
 * on it) but used to answer clicks only, out of reach from the keyboard and of
 * link-hint extensions.
 */
function onKeyboardActivate(el: HTMLElement, activate: () => void) {
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // Space would scroll the page
    activate();
  });
}

function extractItems(statsBar: HTMLElement) {
  const items: { label: string; value: string }[] = [];
  for (const child of statsBar.children) {
    const el = child as HTMLElement;
    const children = Array.from(el.querySelectorAll("b, span, strong"));
    if (children.length < 2) continue;
    const label = children[0].textContent?.trim() ?? "";
    const value = children[children.length - 1].textContent?.trim() ?? "";
    if (!label || !value) continue;
    items.push({ label, value });
  }
  return items;
}

function applyBadgeLayout(container: HTMLElement) {
  const count =
    container.querySelectorAll<HTMLElement>("[data-ft-badge]").length;
  const seatBadge = container.querySelector<HTMLElement>("[data-ft-seat]");
  if (count >= 4) {
    container.style.justifyContent = "space-between";
    if (seatBadge) seatBadge.style.marginBottom = "";
  } else {
    container.style.justifyContent = "flex-end";
    if (seatBadge) seatBadge.style.marginBottom = "auto";
  }
}

function populateMainBadges(
  container: HTMLElement,
  items: { label: string; value: string }[],
) {
  container
    .querySelectorAll("[data-ft-badge]:not([data-ft-seat])")
    .forEach((b) => b.remove());

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // The wallet opens the shop: a real link (focusable, Enter, middle-click,
    // Ctrl+click, the URL in the status bar) rather than a <div> with
    // window.open(). Same classes, and preflight gives links `color: inherit`
    // and no underline, so it looks the same.
    const isWallet = item.label.includes("₳");
    const badge = document.createElement(isWallet ? "a" : "div");
    if (badge instanceof HTMLAnchorElement) {
      badge.href = "https://shop.intra.42.fr/";
      badge.target = "_blank";
      badge.rel = "noopener";
    }
    badge.setAttribute("data-ft-badge", "");
    badge.className =
      "badge badge-lg h-auto flex w-full justify-between gap-4 px-5 py-1.5 text-lg";
    badge.style.backgroundColor = "var(--ft-card-bg)";
    badge.style.color = "var(--ft-card-text)";
    badge.style.borderRadius = "0.75rem";

    badge.style.setProperty("border", "3px solid", "important");
    badge.style.setProperty(
      "border-color",
      "var(--user-color, hsl(var(--legacy-main)))",
      "important",
    );

    const label = document.createElement("span");
    label.className = "label text-lg font-medium";
    label.style.color = "color-mix(in oklab, currentcolor 80%, transparent)";
    label.textContent = item.label;

    const value = document.createElement("span");
    value.className = "value text-lg font-semibold";
    value.textContent = item.value;

    if (isWallet) {
      badge.style.cursor = "pointer";
      // The link opens the shop by itself; the page's handlers above it still
      // must not see the click.
      badge.addEventListener("click", (e) => e.stopPropagation());
    }

    badge.appendChild(label);
    badge.appendChild(value);
    container.appendChild(badge);
  }

  const seatBadge = container.querySelector<HTMLElement>("[data-ft-seat]");
  if (seatBadge) container.prepend(seatBadge);
  applyBadgeLayout(container);
}

async function injectSeatBadge(profileCard: HTMLElement) {
  const shadowHost = document.getElementById(SHADOW_HOST_ID);
  if (!shadowHost) return;
  const shadowRoot = shadowHost.shadowRoot;
  if (!shadowRoot) return;
  const wrapper = shadowRoot.getElementById(INFO_CARD_ID);
  if (!wrapper) return;

  const seatEl = profileCard.querySelector<HTMLElement>(
    ".absolute.px-2.py-1.border.rounded-full.border-neutral-600.bg-ft-gray.top-2.right-4",
  );
  const seatText = seatEl?.textContent?.trim() || null;
  if (!seatText || !seatEl) return;
  // The Intra's own pill is hidden once ours is in place, never before: on a
  // campus without cluster data the lookup below threw, and the seat was
  // shown nowhere.
  const hideIntraPill = () => seatEl.style.setProperty("display", "none", "important");

  const existing = wrapper.querySelector<HTMLElement>("[data-ft-seat]");
  if (existing) {
    existing.querySelector(".value")!.textContent = seatText;
    hideIntraPill();
    return;
  }

  const isUnavailable = seatText.toLowerCase() === "unavailable";

  if (isUnavailable) {
    const badge = document.createElement("div");
    badge.setAttribute("data-ft-badge", "");
    badge.setAttribute("data-ft-seat", "");
    badge.setAttribute("data-ft-unavailable", "");
    badge.className =
      "badge badge-lg h-auto flex w-full justify-center px-5 py-1.5 text-lg";
    badge.style.backgroundColor = "var(--ft-card-bg)";
    badge.style.color = "var(--ft-card-text)";
    badge.style.border = "3px solid transparent";
    badge.style.borderRadius = "0.75rem";
    badge.style.cursor = "default";
    badge.textContent = t("unavailable");
    wrapper.prepend(badge);
    hideIntraPill();
    applyBadgeLayout(wrapper);
    return;
  }

  const badge = document.createElement("div");
  badge.setAttribute("data-ft-badge", "");
  badge.setAttribute("data-ft-seat", "");
  badge.className =
    "badge badge-lg h-auto flex items-center justify-between w-full px-5 py-1.5 text-lg whitespace-nowrap";
  badge.style.backgroundColor = "var(--ft-card-bg)";
  badge.style.color = "var(--ft-card-text)";
  badge.style.border = "3px solid transparent";
  badge.style.borderRadius = "0.75rem";
  badge.style.color = "inherit";
  badge.style.fontWeight = "600";

  // Thirteen campuses have no cluster data: the seat is then plain text,
  // not a link. No campus known yet: no lookup (an empty id loads another
  // campus's file).
  let clusters: readonly { id: string; name: string }[] = CLUSTERS;
  if (clusters.length === 0) {
    const campus = await getConfig("CLUSTERS_CAMPUS");
    try {
      clusters = campus ? (await getClusterData(campus)).clusters : [];
    } catch {
      clusters = [];
    }
  }
  // Another pass may have added the badge during the lookup.
  if (wrapper.querySelector("[data-ft-seat]")) {
    hideIntraPill();
    return;
  }

  const cluster = findClusterForSeat(clusters, seatText);

  const value = document.createElement("span");
  value.className = "value text-lg font-semibold";
  value.textContent = seatText;
  badge.appendChild(value);

  // Pointer, tooltip and arrow only when the seat is on a cluster we can
  // show: a seat on another campus looked like a link and did nothing.
  if (cluster) {
    const open = () => void openClusterDialog({ seatId: seatText });
    badge.style.cursor = "pointer";
    badge.setAttribute("data-tip", t("View on cluster map"));
    badge.tabIndex = 0;
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-label", t("Show {seat} on the cluster map", { seat: seatText }));
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      open();
    });
    onKeyboardActivate(badge, open);

    const linkIcon = document.createElement("span");
    linkIcon.className = "size-3.5 flex items-center justify-center fill-current";
    appendSvg(linkIcon, ARROW_SHARE_SVG);
    badge.appendChild(linkIcon);
  }

  wrapper.prepend(badge);
  hideIntraPill();
  applyBadgeLayout(wrapper);
}

function injectGivePointsButton(statsBar: HTMLElement, container: HTMLElement) {
  const giveBtn = statsBar.querySelector<HTMLElement>(
    'button[aria-haspopup="dialog"]',
  );
  if (!giveBtn) return;

  const svg = giveBtn.querySelector("svg");
  if (!svg) return;

  const evBadges = container.querySelectorAll<HTMLElement>(
    "[data-ft-badge]:not([data-ft-seat])",
  );
  let evBadge: HTMLElement | null = null;
  for (const b of evBadges) {
    const labelEl = b.querySelector(".label");
    if (labelEl?.textContent?.trim() === "Ev.P") {
      evBadge = b;
      break;
    }
  }
  if (!evBadge || evBadge.querySelector("[data-ft-give-points]")) return;

  // No pointer on the whole badge: only the icon below reacts to a click.
  evBadge.style.justifyContent = "space-between";

  // The modern card hides the Intra's stats bar, and with it the Intra's own
  // give-points <button>. Its stand-in has to be a button as well (focusable,
  // Enter and Space, announced with a name), or keyboard and screen-reader
  // users lose the feature. Preflight strips the button's own look, and the
  // inline reset does the same while the shared sheet is still loading.
  const wrapper = document.createElement("button");
  wrapper.type = "button";
  wrapper.setAttribute("data-ft-give-points", "");
  wrapper.setAttribute(
    "aria-label",
    giveBtn.getAttribute("aria-label") || t("Give evaluation points"),
  );
  wrapper.style.cssText =
    "display:inline-flex;align-items:center;margin-left:auto;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer;";
  const icon = iconCopy(svg);
  // The name comes from aria-label; the icon itself is decoration.
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  wrapper.appendChild(icon);
  wrapper.addEventListener("click", (e) => {
    e.stopPropagation();
    giveBtn.click();
  });

  evBadge.appendChild(wrapper);
}

/** A length an SVG width/height attribute accepts ("16", "1.5em", "100%"). */
const SVG_LENGTH = /^\d+(\.\d+)?(px|em|rem|%)?$/;

/**
 * The Intra's icon rebuilt in a new <svg>, with a real size. Its own svg
 * carries height="auto", which is not an SVG length: every clone of it made
 * Chrome log "<svg> attribute height: Expected length, 'auto'" against
 * Cuter Intra. Its shapes are copied as they are.
 */
function iconCopy(source: SVGElement): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const { name, value } of Array.from(source.attributes)) {
    if (name !== "width" && name !== "height") icon.setAttribute(name, value);
  }
  const width = source.getAttribute("width") ?? "";
  const height = source.getAttribute("height") ?? "";
  const size = SVG_LENGTH.test(width) ? width : SVG_LENGTH.test(height) ? height : "16";
  icon.setAttribute("width", SVG_LENGTH.test(width) ? width : size);
  icon.setAttribute("height", SVG_LENGTH.test(height) ? height : size);
  for (const child of Array.from(source.childNodes)) icon.appendChild(child.cloneNode(true));
  return icon;
}

function pollForUpdatedStats(attempts = 0) {
  const shadowHost = document.getElementById(SHADOW_HOST_ID);
  if (!shadowHost?.shadowRoot) return;
  const wrapper = shadowHost.shadowRoot.getElementById(INFO_CARD_ID);
  if (!wrapper) return;
  const statsBar = document.querySelector<HTMLElement>(".border-t-neutral-600");
  if (!statsBar) return;
  const items = extractItems(statsBar);
  if (items.length >= 3 || (items.length >= 1 && attempts >= 8)) {
    populateMainBadges(wrapper, items);
    injectGivePointsButton(statsBar, wrapper);
    return;
  }
  if (attempts < 30) {
    setTimeout(() => pollForUpdatedStats(attempts + 1), 100);
  }
}

function listenForCursusChange() {
  if (_cursusListenerInitialized) return;
  _cursusListenerInitialized = true;
  document.addEventListener("42_CURSUS_ID", (() => {
    pollForUpdatedStats();
  }) as EventListener);
}

function createInfoCard(
  items: { label: string; value: string }[],
  profileCard: HTMLElement,
) {
  const cardBg = getComputedStyle(profileCard).backgroundColor;
  const cardText = getComputedStyle(profileCard).color;
  const shadowHost = document.createElement("div");
  shadowHost.id = SHADOW_HOST_ID;
  if (cardBg && cardBg !== "transparent" && cardBg !== "rgba(0, 0, 0, 0)")
    shadowHost.style.setProperty("--ft-card-bg", cardBg);
  if (cardText) shadowHost.style.setProperty("--ft-card-text", cardText);

  const shadowRoot = shadowHost.attachShadow({ mode: "open" });
  bindTooltips(shadowRoot, getIsLight);

  const seatStyles = css`
    [data-ft-seat]:not([data-ft-unavailable]) {
      border-color: #10b981 !important;
      box-shadow: 0 0 10px rgba(16,185,129,0.25);
    }
    [data-ft-seat][data-ft-unavailable] {
      border-color: #ef4444 !important;
      box-shadow: 0 0 10px rgba(239,68,68,0.25);
    }
    [data-ft-seat] {
      transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }
    [data-ft-seat]:not([data-ft-unavailable]):hover {
      box-shadow: 0 0 22px 4px rgba(16,185,129,0.35);
      border-color: #34d399 !important;
    }
    /* Keyboard focus only: a mouse click draws nothing new. */
    [data-ft-badge]:focus-visible,
    [data-ft-give-points]:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
  `;

  const badgeResponsiveStyles = css`
    @media (max-width: 1023px) {
      #${INFO_CARD_ID} {
        flex-direction: row !important;
        flex-wrap: wrap !important;
        justify-content: center !important;
        gap: 0.5rem !important;
      }
      #${INFO_CARD_ID} [data-ft-badge] {
        width: auto !important;
        height: auto !important;
      }
    }
    @media (max-width: 767px) {
      /* the desktop overhang made the page 20 px wider than a phone */
      #${INFO_CARD_ID} {
        margin-left: 0 !important;
        margin-right: 0 !important;
      }
    }
  `;

  adoptSharedStyles(shadowRoot, `${seatStyles}\n${badgeResponsiveStyles}`);

  const wrapper = document.createElement("div");
  wrapper.id = INFO_CARD_ID;
  wrapper.setAttribute("data-theme", _badgeTheme);
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "4px";
  wrapper.style.marginLeft = "-20px";
  wrapper.style.marginRight = "-20px";
  wrapper.style.height = "100%";
  wrapper.style.justifyContent = "flex-end";

  populateMainBadges(wrapper, items);
  shadowRoot.appendChild(wrapper);
  profileCard.insertAdjacentElement("afterend", shadowHost);
}

function startStatsPolling(profileCard: HTMLElement, attempts: number) {
  if (document.getElementById(SHADOW_HOST_ID)) return;
  const statsBar = profileCard.querySelector<HTMLElement>(
    ".border-t-neutral-600",
  );
  if (statsBar) {
    const items = extractItems(statsBar);
    if (items.length >= 3 || (items.length >= 1 && attempts >= 5)) {
      createInfoCard(items, profileCard);
      void injectSeatBadge(profileCard);
      const wrapper = document
        .getElementById(SHADOW_HOST_ID)
        ?.shadowRoot?.getElementById(INFO_CARD_ID);
      if (wrapper) injectGivePointsButton(statsBar, wrapper);
      if (items.length < 3) pollForUpdatedStats();
      return;
    }
  }
  if (attempts < 20) {
    setTimeout(() => startStatsPolling(profileCard, attempts + 1), 50);
  }
}

function moveStatsBar(profileCard: HTMLElement | null) {
  if (!profileCard) return;
  if (document.getElementById(SHADOW_HOST_ID)) return;
  startStatsPolling(profileCard, 0);
}

function injectProfileCardStyles() {
  const STYLE_ID = "ft-profile-card-styles";
  // The rules are constant, so the existing node is always right. Replacing
  // it invalidated the whole document's styles on every profile pass, and the
  // getComputedStyle in extractLevelColor then forced a full recalculation.
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css`
    /* --- Main Card Container --- */
    .ft-profile-card {
      border: 1px solid var(--user-color-translucent, rgba(255, 255, 255, 0.1)) !important;
      border-radius: 1rem !important;
      transition: border-color 0.3s ease-in-out, box-shadow 0.3s ease-in-out;
    }

    .ft-profile-card:hover {
      border-color: var(--user-color, rgba(255, 255, 255, 0.3)) !important;
      box-shadow: 0 0 20px var(--user-color-translucent, rgba(255,255,255,0.1));
    }

    /* --- Profile Picture --- */
    .ft-profile-card .bg-cover.rounded-full {
      border-color: var(--user-color, #00babc) !important;
    }

    /* The avatar is a button for the keyboard too (avatar-clicks.ts): show
       where focus is, for keyboard focus only. */
    .ft-profile-card [data-modal-listener]:focus-visible,
    .ft-profile-card [data-toggle-listener]:focus-visible {
      outline: 3px solid var(--user-color, #00babc);
      outline-offset: 3px;
    }

    /* --- User Name --- */
    .ft-profile-card h2.text-2xl {
      text-shadow: 0 1px 5px rgba(0,0,0,0.5);
    }

    /* Level & Progress Bar Section */
    .ft-profile-card .px-8.flex.flex-row {
      align-items: center !important;
      padding-left: 1rem !important;
      padding-right: 1rem !important;
      gap: 0.75rem !important;
    }

    /* Level Number (e.g., "01") */
    .ft-profile-card h1.text-4xl {
      font-size: 2.5rem !important;
      line-height: 1 !important;
      height: auto !important;
      color: var(--user-color, hsl(var(--legacy-main)));
    }

    /* Progress bar container - now the liquid container */
    .ft-profile-card div[role="progressbar"] {
      height: 12px !important;
      background-color: rgba(0,0,0,0.4) !important;
      border-radius: 10px !important;
      overflow: hidden !important;
      position: relative !important;
    }

    /* Progress bar fill - now the liquid fill */
    .ft-profile-card div[role="progressbar"] > div {
      background-color: var(--user-color, #00babc) !important;
      position: relative !important;
      transition: width 1s ease-in-out !important;
    }

    /* --- Cursus Dropdown & Percentage --- */
    .ft-profile-card .font-bold.justify-between {
      color: hsl(var(--muted-foreground));
    }

    .ft-profile-card .font-bold.justify-between > div:first-child {
      color: var(--user-color, hsl(var(--legacy-main)));
      font-weight: 700;
      font-size: 1.25rem !important;
    }

    .ft-profile-card .font-bold.justify-between > div:last-child {
      color: var(--user-color, hsl(var(--legacy-main)));
    }

    .ft-profile-card button[role="combobox"] {
      background-color: transparent !important;
      font-size: 0.8rem;
      padding: 2px 4px !important;
      border-radius: 4px;
      color: var(--user-color, hsl(var(--legacy-main)));
    }

    [role="option"]:hover,
    [role="option"]:focus,
    [role="option"][data-highlighted] {
      background-color: var(--user-color, hsl(var(--legacy-main))) !important;
      color: #fff !important;
    }
    .flex.flex-col.justify-center.gap-4 {
      flex-direction: row !important;
      flex-wrap: wrap !important;
      justify-content: center !important;
      align-items: center !important;
    }
    .bg-ft-gray\\/50.border.border-ft-gray-border.w-full.h-full.justify-center.rounded-xl.flex.py-6.xl\\:py-0 {
      align-items: center !important;
    }
    .flex.flex-col.justify-center.gap-4 button {
      border: 2px solid var(--user-color, hsl(var(--legacy-main))) !important;
      border-radius: 0.5rem;
      padding: 0.125rem 0.75rem;
      color: #fff !important;
      flex-grow: 0 !important;
      width: auto !important;
    }
    .flex.flex-col.justify-center.gap-4 button a {
      color: #fff !important;
    }
    html.dark .flex.flex-col.justify-center.gap-4 button {
      color: hsl(var(--foreground)) !important;
    }
    html.dark .flex.flex-col.justify-center.gap-4 button a {
      color: hsl(var(--foreground)) !important;
    }
    .flex.flex-col.justify-center.gap-4 a {
      color: var(--user-color, hsl(var(--legacy-main))) !important;
    }

  `;
  document.head.appendChild(style);
}

function rgbToHex(color: string): string {
  const m = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!m) return color;
  const toHex = (n: string) => parseInt(n).toString(16).padStart(2, "0");
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

function extractLevelColor(profileCard: HTMLElement | null): string | null {
  if (!profileCard) return null;
  const levelEl = profileCard.querySelector<HTMLElement>("h1.text-4xl");
  if (!levelEl) return null;
  return rgbToHex(getComputedStyle(levelEl).color);
}

export function findProfileCard(): HTMLElement | null {
  const loginElement =
    document.querySelector<HTMLElement>(PROFILE_CARD_SELECTOR);
  if (!loginElement) {
    // Nothing mounts without this card. Say so once if it is still missing
    // when the profile pass stops looking (the deadline profile.ts uses).
    probeSelectorAt(
      "profile card",
      PROFILE_CARD_SELECTOR,
      PROFILE_PASS_DEADLINE_MS(location.pathname),
    );
    return null;
  }
  const card = loginElement.closest(
    ".flex.flex-col.lg\\:flex-row",
  )?.parentElement;
  return (card as HTMLElement) || null;
}

export function applyThemeToProfileCard(theme: { profileColor?: string }) {
  const profileCard = findProfileCard();
  if (!profileCard || !theme?.profileColor) return;

  profileCard.style.setProperty("--user-color", theme.profileColor);
  profileCard.style.setProperty(
    "--user-color-translucent",
    `${theme.profileColor}33`,
  );

  const shadowHost = document.getElementById(SHADOW_HOST_ID);
  if (shadowHost) {
    shadowHost.style.setProperty("--user-color", theme.profileColor);
    shadowHost.style.setProperty(
      "--user-color-translucent",
      `${theme.profileColor}33`,
    );
  }
}

export async function initProfileCardStyling() {
  injectProfileCardStyles();

  let profileCard = findProfileCard();
  for (let i = 0; i < 10 && !profileCard; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    profileCard = findProfileCard();
  }

  const effectiveTheme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  const presetKey = await getConfig("PROFILE_THEME_PRESET");
  _badgeTheme = widgetTheme(effectiveTheme, presetKey || "dark");
  followThemeChanges();

  if (profileCard && !profileCard.classList.contains(PROFILE_CARD_CLASS)) {
    profileCard.classList.add(PROFILE_CARD_CLASS);
  }

  if (!profileCard) return;

  const useModern = await getConfig("PROFILE_USE_MODERN_INFO_CARD");
  if (useModern) {
    profileCard
      .querySelector<HTMLElement>(".border-t-neutral-600")
      ?.style.setProperty("display", "none", "important");
    moveStatsBar(profileCard);
    listenForCursusChange();
  }

  const pathParts = location.pathname.split("/").filter(Boolean);
  const isOtherUser = pathParts[0] === "users" && !!pathParts[1];

  let color: string | null = null;

  if (!isOtherUser) {
    const useCustomColor = await getConfig("PROFILE_USE_CUSTOM_COLOR");
    if (useCustomColor) {
      color = await getConfig("LOGTIME_CALENDAR_COLOR");
    }
  }

  if (!color) {
    color = extractLevelColor(profileCard);
  }

  if (color) {
    applyThemeToProfileCard({ profileColor: color });
  }

  void initShortcutButtons();
  void initFriendBadge();
  requestAnimationFrame(() => injectCampusFlag());
}
