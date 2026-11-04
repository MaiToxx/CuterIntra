/**
 * Identity part of the public profile extras: a small block under the login
 * of the profile header (status, pronouns, bio, flair, links) and the
 * greeting shown once to visitors.
 *
 * Everything displayed here was typed by ANOTHER user. It already went
 * through sanitizeProfileExtras(), and this module still never trusts it:
 * texts only ever reach the DOM through lit text / attribute bindings, a
 * link is dropped unless its href parses as a plain https URL, and the only
 * markup injected as HTML is our own bundled SVG icons, picked by a switch
 * on the link kind (never looked up with a key chosen by the stranger).
 *
 * mountIdentity() runs on every mutation pass of a React page: the render is
 * memoised on the identity fields, and a pass with unchanged data only
 * checks that the block still sits right after the login line (React drops
 * foreign nodes when it re-renders the header).
 */
import { html, render, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import GITHUB_SVG from "../../../assets/svg/github.svg?raw";
import DISCORD_SVG from "../../../assets/svg/discord.svg?raw";
import GLOBE_SVG from "../../../assets/svg/globe-lucide.svg?raw";
import LINK_SVG from "../../../assets/svg/link.svg?raw";
import { toast } from "../../eggs/eggs.ts";
import { t } from "../../../core/i18n/i18n.ts";
import {
  EXTRAS_IDENTITY_ID,
  LIMITS,
  LOGIN_SELECTOR,
  PROFILE_CARD,
  type ProfileExtras,
  type ProfileLink,
} from "./extras.ts";
import { css } from "../../../core/dom/css.ts";

export interface IdentityOptions {
  /** Login of the profile being displayed. */
  login: string;
  /** True on the viewer's own profile. */
  own: boolean;
}

/** What is actually rendered, once empty and unsafe entries are gone. */
interface IdentityView {
  statusEmoji: string;
  statusText: string;
  pronouns: string;
  bio: string;
  flair: string[];
  links: ProfileLink[];
}

/** One link per kind at most: anything longer is not what the sanitizer built. */
const MAX_LINKS = 5;
const COPIED_MS = 1500;
const GREETING_MS = 6000;

const ID = EXTRAS_IDENTITY_ID;
const ACCENT = "var(--user-color, hsl(var(--primary, 181 100% 37%)))";
const MUTED = "hsl(var(--muted-foreground, 220 9% 60%))";
const BORDER = "hsl(var(--border, 220 13% 28%))";

/**
 * Constant stylesheet (no user value ever enters it), scoped to the block.
 * `overflow: hidden` on the text holders keeps stacked combining characters
 * ("zalgo") from painting over the rest of the header. From 1024px the
 * header is a row (lg:flex-row) and the name column is sized by its content:
 * the narrower cap keeps a long bio from squeezing the level column.
 */
const STYLE = css`
  #${ID} {
    display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
    box-sizing: border-box; width: 100%; max-width: 36rem; margin: 0.5rem auto 0;
    text-align: center; font-size: 0.875rem; font-weight: 400; line-height: 1.4;
    overflow-wrap: anywhere; word-break: break-word;
  }
  @media (min-width: 1024px) { #${ID} { max-width: 24rem; } }
  #${ID} .ft-x-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 0.375rem; max-width: 100%;
  }
  #${ID} .ft-x-chip {
    display: inline-flex; align-items: center; gap: 0.3rem;
    box-sizing: border-box; max-width: 100%; overflow: hidden;
    padding: 0.15rem 0.65rem; border: 1px solid ${BORDER}; border-radius: 999px;
    background: hsl(var(--background, 220 20% 8%) / 0.35);
  }
  #${ID} .ft-x-status { border-color: ${ACCENT}; }
  #${ID} .ft-x-pronouns { color: ${MUTED}; font-size: 0.75rem; }
  #${ID} .ft-x-bio { max-width: 100%; margin: 0; overflow: hidden; }
  #${ID} .ft-x-flair { gap: 0.45rem; font-size: 1.5rem; line-height: 1.25; }
  #${ID} .ft-x-flair > span { max-width: 100%; overflow: hidden; }
  #${ID} .ft-x-link {
    display: inline-flex; align-items: center; gap: 0.35rem;
    box-sizing: border-box; max-width: 100%; margin: 0;
    padding: 0.2rem 0.65rem; border: 1px solid ${BORDER}; border-radius: 999px;
    background: hsl(var(--background, 220 20% 8%) / 0.35);
    color: ${MUTED}; font: inherit; font-size: 0.75rem; line-height: 1.2;
    text-decoration: none; cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  #${ID} .ft-x-link:hover,
  #${ID} .ft-x-link:focus-visible { color: ${ACCENT}; border-color: ${ACCENT}; }
  #${ID} .ft-x-link:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
  /* No ellipsis: a truncated host would hide the real domain of a link
     ("intra.42.fr.evil.example" reading as "intra.42.fr…"). */
  #${ID} .ft-x-label { max-width: 14rem; overflow-wrap: anywhere; }
  #${ID} .ft-x-via {
    color: ${MUTED}; font-size: 0.625rem; line-height: 1; opacity: 0.6;
    margin-top: 0.125rem; letter-spacing: 0.02em;
  }
  #${ID} .ft-x-ico {
    display: inline-flex; flex: none; width: 0.875rem; height: 0.875rem; color: ${ACCENT};
  }
  #${ID} .ft-x-ico svg { display: block; width: 100%; height: 100%; fill: currentColor; }
  #${ID} .ft-x-ico[data-outlined] svg { fill: none; }
`;

let host: HTMLElement | null = null;
/** JSON of the identity fields + login of the last render ("" = none). */
let memoKey = "";
/** View rendered for memoKey; null when there is nothing to show. */
let shown: IdentityView | null = null;
let copiedLabel: string | null = null;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
/** Fallback of the session flag when sessionStorage is blocked. */
const greetedThisLoad = new Set<string>();

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Second look at an href the sanitizer already built. It ends up in a
 * clickable attribute, the one place where a missed `javascript:` would run,
 * so it is parsed again here. The serialised form is what gets displayed in
 * the tooltip: a look-alike host shows up as punycode there. URLs carrying
 * credentials are refused (https://github.com@evil.example reads as GitHub).
 */
function safeHref(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function buildView(extras: ProfileExtras): IdentityView | null {
  const flair = (Array.isArray(extras.flair) ? extras.flair : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, LIMITS.flairItems);

  const links: ProfileLink[] = [];
  for (const link of Array.isArray(extras.links) ? extras.links : []) {
    if (links.length >= MAX_LINKS) break;
    const label = clean(link?.label);
    if (!label) continue;
    const raw = clean(link.href);
    const href = raw ? safeHref(raw) : "";
    // an href that was given but refused must not turn into a "copy" pill
    if (raw && !href) continue;
    links.push({ kind: link.kind, label, href });
  }

  const view: IdentityView = {
    statusEmoji: clean(extras.statusEmoji),
    statusText: clean(extras.statusText),
    pronouns: clean(extras.pronouns),
    bio: clean(extras.bio),
    flair,
    links,
  };
  const empty =
    !view.statusEmoji &&
    !view.statusText &&
    !view.pronouns &&
    !view.bio &&
    flair.length === 0 &&
    links.length === 0;
  return empty ? null : view;
}

const identityKey = (extras: ProfileExtras, login: string): string =>
  JSON.stringify([
    login,
    extras.statusEmoji,
    extras.statusText,
    extras.pronouns,
    extras.bio,
    extras.flair,
    extras.links,
  ]);

/**
 * Icon and name of a link kind. A switch rather than a lookup table: the
 * kind comes from the wire, and `table["constructor"]` is not an icon.
 */
function linkMeta(kind: string): {
  kind: string;
  name: string;
  svg: string;
  outlined: boolean;
} {
  switch (kind) {
    case "github":
      return { kind: "github", name: "GitHub", svg: GITHUB_SVG, outlined: false };
    case "discord":
      return { kind: "discord", name: "Discord", svg: DISCORD_SVG, outlined: false };
    case "website":
      return { kind: "website", name: t("Website"), svg: GLOBE_SVG, outlined: true };
    case "gitlab":
      return { kind: "gitlab", name: "GitLab", svg: LINK_SVG, outlined: false };
    case "linkedin":
      return { kind: "linkedin", name: "LinkedIn", svg: LINK_SVG, outlined: false };
    default:
      return { kind: "link", name: t("Link"), svg: LINK_SVG, outlined: false };
  }
}

async function copyLabel(label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(label);
  } catch {
    // refused (permission, insecure context): saying "Copied" would be a
    // lie, and the handle stays readable on the pill
    return;
  }
  copiedLabel = label;
  renderBlock();
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedTimer = null;
    copiedLabel = null;
    renderBlock();
  }, COPIED_MS);
}

function resetCopied(): void {
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = null;
  copiedLabel = null;
}

function linkTemplate(link: ProfileLink): TemplateResult {
  const meta = linkMeta(link.kind);
  // our own bundled asset, chosen by the switch above: never user data
  const icon = html`<span class="ft-x-ico" ?data-outlined=${meta.outlined} aria-hidden="true"
    >${unsafeHTML(meta.svg)}</span
  >`;
  if (!link.href) {
    // nothing to open (a Discord handle): the pill copies it instead
    const copied = copiedLabel === link.label;
    return html`<button
      type="button"
      class="ft-x-link"
      data-kind=${meta.kind}
      title=${t("Copy this {name} handle", { name: meta.name })}
      @click=${() => void copyLabel(link.label)}
    >
      ${icon}<span class="ft-x-label" aria-live="polite">${copied ? t("Copied") : link.label}</span>
    </button>`;
  }
  return html`<a
    class="ft-x-link"
    data-kind=${meta.kind}
    href=${link.href}
    target="_blank"
    rel="noopener noreferrer nofollow"
    title=${link.href}
    aria-label=${t("{name}: {label}", { name: meta.name, label: link.label })}
  >
    ${icon}<span class="ft-x-label">${link.label}</span>
  </a>`;
}

function template(view: IdentityView): TemplateResult {
  const hasStatus = !!(view.statusEmoji || view.statusText);
  return html`<style>
      ${STYLE}
    </style>
    ${hasStatus || view.pronouns
      ? html`<div class="ft-x-row">
          ${hasStatus
            ? html`<span class="ft-x-chip ft-x-status"
                >${view.statusEmoji ? html`<span>${view.statusEmoji}</span>` : nothing}${view.statusText
                  ? html`<span>${view.statusText}</span>`
                  : nothing}</span
              >`
            : nothing}
          ${view.pronouns
            ? html`<span class="ft-x-chip ft-x-pronouns">${view.pronouns}</span>`
            : nothing}
        </div>`
      : nothing}
    ${view.bio ? html`<div class="ft-x-bio">${view.bio}</div>` : nothing}
    ${view.flair.length
      ? html`<div class="ft-x-row ft-x-flair">
          ${view.flair.map((item) => html`<span>${item}</span>`)}
        </div>`
      : nothing}
    ${view.links.length
      ? html`<div class="ft-x-row ft-x-links">${view.links.map(linkTemplate)}</div>`
      : nothing}
    <div class="ft-x-via">${t("added by this student with Cuter Intra")}</div>`;
}

function renderBlock(): void {
  if (!host || !shown) return;
  render(template(shown), host);
}

function removeBlock(): void {
  host?.remove();
  host = null;
  // a block left by a previous instance of the extension (update, reload)
  document.getElementById(ID)?.remove();
}

function ensureHost(login: string): HTMLElement {
  if (!host) {
    document.getElementById(ID)?.remove();
    host = document.createElement("div");
    host.id = ID;
    host.setAttribute("role", "note");
  }
  // so that nobody mistakes the block for official Intra content
  host.title = t("Added by {login} with Cuter Intra", { login });
  return host;
}

/** The login line of the header: the one of the profile card when several match. */
function findLoginElement(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(`${PROFILE_CARD} ${LOGIN_SELECTOR}`) ??
    document.querySelector<HTMLElement>(LOGIN_SELECTOR)
  );
}

/**
 * Show the identity block of `extras` under the login line, or remove it
 * (null, or nothing to show). Safe to call on every mutation pass.
 */
export function mountIdentity(extras: ProfileExtras | null, opts: IdentityOptions): void {
  if (!extras) {
    unmountIdentity();
    return;
  }

  const key = identityKey(extras, opts.login);
  if (key !== memoKey) {
    memoKey = key;
    shown = buildView(extras);
    resetCopied();
    if (!shown) {
      removeBlock();
      return;
    }
    // rendered even while the header is missing: the block is then ready
    // (and never shows the previous profile) when a later pass places it
    ensureHost(opts.login);
    renderBlock();
  }
  if (!shown || !host) return;

  const anchor = findLoginElement();
  if (!anchor) return;
  // React re-rendered the header and dropped or displaced the block
  if (anchor.nextElementSibling !== host) anchor.after(host);
}

/** Remove the block and forget what was rendered. */
export function unmountIdentity(): void {
  resetCopied();
  removeBlock();
  memoKey = "";
  shown = null;
}

/**
 * Greeting of the profile owner, shown to a visitor once per browser
 * session and per login (a toast on every mutation pass, or on every visit
 * of a friend's page, would be unbearable). Never on one's own profile.
 */
export function showGreeting(extras: ProfileExtras | null, opts: IdentityOptions): void {
  const greeting = clean(extras?.greeting);
  if (!greeting || opts.own || !opts.login) return;
  if (greetedThisLoad.has(opts.login)) return;
  greetedThisLoad.add(opts.login);

  const flag = `ft-greeted-${opts.login}`;
  try {
    if (sessionStorage.getItem(flag)) return;
    sessionStorage.setItem(flag, "1");
  } catch {
    // storage blocked: greetedThisLoad still limits it to once per page load
  }
  // The login comes first and the source is named: a greeting must not be
  // mistakable for a message from Cuter Intra or from the Intra itself.
  toast(
    t("{login} wrote on their profile: “{greeting}”", { login: opts.login, greeting }),
    GREETING_MS,
  );
}
