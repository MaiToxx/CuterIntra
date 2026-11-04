import { html, nothing, type TemplateResult } from "lit-html";
import { getConfig } from "../config.ts";

/**
 * The compiled Tailwind/daisyUI sheet weighs ~130 KB (~300 KB before
 * style.css limited what Tailwind scans and what daisyUI builds). Concatenating
 * it into a <style> inside every shadow root meant the browser tokenised and
 * parsed all of it once per widget on every page load, and both JS bundles had
 * to carry the text.
 *
 * It now ships as a real `shared-styles.css` file next to content.js (the bare
 * import below plus `cssCodeSplit: false` in vite.config.ts is what makes Vite
 * emit it) and is shared: fetched once, parsed once into a constructable
 * CSSStyleSheet, then handed to every root.
 *
 * THEMES. A widget shows one daisyUI theme at a time: light or dark
 * (BETTER_INTRA_THEME), or the hub preset (PROFILE_THEME_PRESET). Only light
 * and dark are in shared-styles.css; the other 34 presets are cut out of it at
 * build time into `shared-themes.css` (splitDaisyThemes() in vite.config.ts),
 * which a page loads only when its preset needs it. Same mechanism: fetched
 * once, parsed once, adopted by every root right after the shared sheet, or a
 * <link> right after the shared <link>. What decides it:
 *  - at document_start, the preset the previous page of this tab saw
 *    (sessionStorage), so the file is parsed before any widget mounts;
 *  - then the stored preset, read through the settings snapshot. The widgets
 *    read theirs the same way after this module did, so by the time one
 *    renders a preset theme this module knows it;
 *  - chrome.storage.onChanged, for a preset picked while the page is open:
 *    the file is then added to every root already served.
 * Once a page has needed it, it keeps it (see `themesInUse`).
 *
 * MOTION. style.css stops every looping animation and transition of a root
 * under prefers-reduced-motion. The Advanced "Disable animations" switch
 * (DISABLE_ANIMATIONS) asks for the same without the OS preference: while it
 * is on, every root this module serves also gets NO_MOTION_CSS, those rules
 * without the media query, as one more adopted sheet (read through the
 * settings snapshot, then chrome.storage.onChanged, so switching it in the
 * hub reaches the widgets already on screen, both ways).
 */

// Side-effect import: this is the only reason the asset exists in the output.
// Nothing reads a value from it.
import "./style.css";

/** Name of the emitted asset; must match `assetFileNames` in vite.config.ts. */
const SHARED_CSS_FILE = "shared-styles.css";

/** Emitted next to it; must match SHARED_THEMES_CSS_FILE in vite.config.ts. */
const THEMES_CSS_FILE = "shared-themes.css";

/**
 * The daisyUI themes shared-styles.css carries itself. Every other preset needs
 * shared-themes.css. Must match CORE_THEMES in vite.config.ts.
 */
const CORE_THEMES: ReadonlySet<string> = new Set(["light", "dark"]);

/** sessionStorage key: the preset of the last page of this tab on this site. */
const PRESET_CACHE_KEY = "better-intra-theme-preset";

/** One of the two sheets: fetched and parsed at most once per page. */
type SheetFile = {
  readonly file: string;
  sheet: CSSStyleSheet | null;
  promise: Promise<CSSStyleSheet | null> | null;
};

const sharedFile: SheetFile = { file: SHARED_CSS_FILE, sheet: null, promise: null };
const themesFile: SheetFile = { file: THEMES_CSS_FILE, sheet: null, promise: null };

/** Roots already served, so a second call is a no-op instead of a duplicate. */
const served = new WeakSet<ShadowRoot>();

/**
 * This page shows, or may show, a theme only shared-themes.css has. Never goes
 * back to false: a root that got the file keeps it, and sharedStylesLink()
 * keeps rendering the same <link> instead of dropping it on a re-render of a
 * widget whose data-theme was computed earlier.
 */
let themesInUse = false;

/** Roots that already have shared-themes.css. */
const themed = new WeakSet<ShadowRoot>();

/**
 * Roots served without shared-themes.css, to be given it if a preset that
 * needs it shows up. Weak, so a widget removed for good is not kept alive.
 */
const unthemed = new Set<WeakRef<ShadowRoot>>();
const unthemedRoots = new WeakSet<ShadowRoot>();
/** Size at which `unthemed` drops its dead entries (a tab can live for hours). */
let sweepAt = 64;

/**
 * The reduced-motion rules of style.css without their media query: what a
 * root gets while DISABLE_ANIMATIONS is on. Same layer, so the same reasons
 * hold (see the comment above `@layer bi-motion` in style.css), and
 * tests/shared-styles.test.ts checks that the two stay identical.
 */
export const NO_MOTION_CSS =
  "@layer bi-motion{" +
  "*,::before,::after{" +
  "animation-duration:1ms!important;animation-delay:0s!important;" +
  "animation-iteration-count:1!important;animation-fill-mode:both!important;" +
  "transition-duration:0s!important;transition-delay:0s!important;" +
  "scroll-behavior:auto!important}" +
  ".spinning{animation-duration:2.4s!important;" +
  "animation-iteration-count:infinite!important;animation-fill-mode:none!important}" +
  "}";

/** DISABLE_ANIMATIONS, as last read. */
let motionOff = false;
/** Built on first use and shared by every root, like the shared sheet. */
let noMotionSheet: CSSStyleSheet | null = null;
/** Marks the <style> fallback of NO_MOTION_CSS, to find it again. */
const NO_MOTION_ATTR = "data-bi-no-motion";

/**
 * Every root served, adopted or linked, so that switching animations off
 * (or on) while the page is open reaches them. Weak, like `unthemed`.
 */
const motionRoots = new Set<WeakRef<ShadowRoot>>();
const motionTracked = new WeakSet<ShadowRoot>();
let motionSweepAt = 64;

/** Extension URL of a packaged file, or null without an extension context. */
function extensionURL(file: string): string | null {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
    return chrome.runtime.getURL(file);
  } catch {
    return null;
  }
}

/**
 * Extension URL of the sheet, or null when there is no extension context
 * (unit tests, or a context invalidated by a reload/update). Callers degrade to
 * "unstyled but working" rather than throwing.
 */
export function sharedStylesURL(): string | null {
  return extensionURL(SHARED_CSS_FILE);
}

/** Safari < 16.4 and old Firefox have no constructable stylesheets. */
function supportsConstructableSheets(): boolean {
  const Ctor = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet })
    .CSSStyleSheet;
  return (
    typeof Ctor === "function" && typeof Ctor.prototype?.replaceSync === "function"
  );
}

async function loadSheet(
  target: SheetFile,
  url: string,
): Promise<CSSStyleSheet | null> {
  if (!supportsConstructableSheets() || typeof fetch !== "function") return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await res.text());
    target.sheet = sheet;
    return sheet;
  } catch {
    // Network/context failure: adoptSharedStyles() falls back to <link>, and if
    // that fails too the widget renders unstyled instead of not at all.
    return null;
  }
}

function preload(target: SheetFile): Promise<CSSStyleSheet | null> {
  if (target.promise) return target.promise;
  const url = extensionURL(target.file);
  // No extension context yet: do not memoise a failure, a later call may work.
  if (!url) return Promise.resolve(null);
  target.promise = loadSheet(target, url);
  return target.promise;
}

/**
 * Fetch and parse the sheet once for the whole page. Memoised, so calling it
 * from anywhere is free after the first time.
 */
export function preloadSharedStyles(): Promise<CSSStyleSheet | null> {
  return preload(sharedFile);
}

/**
 * Give `root` the shared sheet, followed by the widget's own `extraCSS` (the
 * rules that used to sit after `sharedCSS` in the same <style>).
 *
 * Use this only when this helper owns *every* stylesheet of the root: adopted
 * sheets are applied AFTER the root's own <style>/<link> elements, so a root
 * that also renders its own <style> would see those rules start losing ties to
 * Tailwind. Such roots must use {@link sharedStylesLink} instead.
 */
export function adoptSharedStyles(root: ShadowRoot, extraCSS?: string): void {
  if (served.has(root)) return;
  served.add(root);
  void preloadSharedStyles();
  const withThemes = themesInUse;
  if (withThemes) void preload(themesFile);
  const ready =
    sharedFile.sheet !== null && (!withThemes || themesFile.sheet !== null);
  if (!ready || !adopt(root, withThemes, extraCSS)) {
    // A preset theme that is not parsed yet takes this path too: a widget must
    // not render in the wrong colours first, then change.
    appendFallback(root, withThemes, extraCSS);
  }
  if (withThemes) themed.add(root);
  else waitForThemes(root);
  trackMotion(root);
}

function adopt(
  root: ShadowRoot,
  withThemes: boolean,
  extraCSS?: string,
): boolean {
  try {
    const sheets: CSSStyleSheet[] = [sharedFile.sheet!];
    if (withThemes) sheets.push(themesFile.sheet!);
    if (extraCSS) {
      const own = new CSSStyleSheet();
      own.replaceSync(extraCSS);
      // After the shared sheet, so the widget's rules keep winning ties exactly
      // as they did when both strings were concatenated into one <style>.
      sheets.push(own);
    }
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...sheets];
    return true;
  } catch {
    return false;
  }
}

function stylesheetLink(url: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  return link;
}

/**
 * The sheet is not ready (or not supported): a <link> keeps the widget styled.
 * The nodes go first in the root so the cascade order is unchanged: shared
 * sheet, themes, then the widget's own rules.
 */
function appendFallback(
  root: ShadowRoot,
  withThemes: boolean,
  extraCSS?: string,
): void {
  const nodes: Node[] = [];
  const url = sharedStylesURL();
  if (url) {
    nodes.push(stylesheetLink(url));
    const themesURL = withThemes ? extensionURL(THEMES_CSS_FILE) : null;
    if (themesURL) nodes.push(stylesheetLink(themesURL));
  }
  if (extraCSS) {
    const style = document.createElement("style");
    style.textContent = extraCSS;
    nodes.push(style);
  }
  if (nodes.length) root.prepend(...nodes);
}

/**
 * lit binding for shadow roots that keep their own rules in a <style> inside
 * the template. A <link> is a tree stylesheet, so placing it before that
 * <style> reproduces the old cascade exactly, which adoption cannot do. The
 * file is already in the HTTP cache thanks to {@link preloadSharedStyles}, and
 * both engines share the parsed sheet between roots pointing at the same URL.
 * When the page's preset needs it, a second <link> to shared-themes.css
 * follows. The first one reports its root when it loads, so that a preset
 * picked later reaches this root too.
 */
export function sharedStylesLink(): TemplateResult | typeof nothing {
  const url = sharedStylesURL();
  if (!url) return nothing;
  const themesURL = themesInUse ? extensionURL(THEMES_CSS_FILE) : null;
  return html`<link rel="stylesheet" href="${url}" @load=${onSharedLinkLoad} />${
    themesURL ? html`<link rel="stylesheet" href="${themesURL}" />` : nothing
  }`;
}

function findLink(root: ShadowRoot, url: string | null): HTMLLinkElement | null {
  if (!url) return null;
  for (const link of root.querySelectorAll("link")) {
    if (link.getAttribute("href") === url) return link;
  }
  return null;
}

/** A root rendered by sharedStylesLink(): the shared <link> just loaded. */
function onSharedLinkLoad(event: Event): void {
  const root = (event.currentTarget as Node | null)?.getRootNode?.();
  if (!(root instanceof ShadowRoot)) return;
  trackMotion(root);
  if (themed.has(root)) return;
  if (findLink(root, extensionURL(THEMES_CSS_FILE))) {
    themed.add(root);
  } else if (themesInUse) {
    void preload(themesFile).then(() => addThemes(root));
  } else {
    waitForThemes(root);
  }
}

function waitForThemes(root: ShadowRoot): void {
  if (themed.has(root) || unthemedRoots.has(root)) return;
  unthemedRoots.add(root);
  unthemed.add(new WeakRef(root));
  if (unthemed.size >= sweepAt) {
    for (const ref of unthemed) if (!ref.deref()) unthemed.delete(ref);
    sweepAt = Math.max(64, unthemed.size * 2);
  }
}

/**
 * Give a root that is already on screen the themes sheet: adopted right after
 * the shared sheet (or first, when the shared sheet is a <link>, which tree
 * order already puts before any adopted sheet), or else a <link> right after
 * the shared <link>. Either way the themes come after the shared sheet, which
 * is all the cascade needs (see splitDaisyThemes() in vite.config.ts).
 */
function addThemes(root: ShadowRoot): void {
  if (themed.has(root)) return;
  const sheet = themesFile.sheet;
  if (sheet) {
    try {
      const sheets = [...root.adoptedStyleSheets];
      const at = sharedFile.sheet ? sheets.indexOf(sharedFile.sheet) + 1 : 0;
      sheets.splice(at, 0, sheet);
      root.adoptedStyleSheets = sheets;
      themed.add(root);
      return;
    } catch {
      /* fall back to a <link> */
    }
  }
  const url = extensionURL(THEMES_CSS_FILE);
  const sharedLink = findLink(root, sharedStylesURL());
  if (!url || !sharedLink) return;
  sharedLink.after(stylesheetLink(url));
  themed.add(root);
}

/** From now on every root gets shared-themes.css, and those served before too. */
function useThemes(): void {
  if (themesInUse) return;
  themesInUse = true;
  void preload(themesFile).then(() => {
    for (const ref of unthemed) {
      const root = ref.deref();
      if (root) addThemes(root);
    }
    unthemed.clear();
  });
}

function trackMotion(root: ShadowRoot): void {
  if (motionTracked.has(root)) return;
  motionTracked.add(root);
  motionRoots.add(new WeakRef(root));
  if (motionRoots.size >= motionSweepAt) {
    for (const ref of motionRoots) if (!ref.deref()) motionRoots.delete(ref);
    motionSweepAt = Math.max(64, motionRoots.size * 2);
  }
  if (motionOff) stopMotion(root);
}

function getNoMotionSheet(): CSSStyleSheet | null {
  if (noMotionSheet || !supportsConstructableSheets()) return noMotionSheet;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(NO_MOTION_CSS);
    noMotionSheet = sheet;
  } catch {
    /* the <style> fallback below takes over */
  }
  return noMotionSheet;
}

/**
 * Adopted last, which is fine: in a layer, its !important rules beat the
 * widget's own whatever the order. Without constructable sheets, a <style>
 * goes first in the root, before lit's markers, where no re-render of the
 * widget will remove it (the layer makes its place irrelevant here too).
 */
function stopMotion(root: ShadowRoot): void {
  const sheet = getNoMotionSheet();
  if (sheet) {
    try {
      if (!root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
      return;
    } catch {
      /* fall back to a <style> */
    }
  }
  if (root.querySelector(`style[${NO_MOTION_ATTR}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(NO_MOTION_ATTR, "");
  style.textContent = NO_MOTION_CSS;
  root.prepend(style);
}

function allowMotion(root: ShadowRoot): void {
  try {
    const sheets = root.adoptedStyleSheets;
    if (noMotionSheet && sheets.includes(noMotionSheet)) {
      root.adoptedStyleSheets = sheets.filter((s) => s !== noMotionSheet);
    }
  } catch {
    /* nothing was adopted */
  }
  root.querySelector(`style[${NO_MOTION_ATTR}]`)?.remove();
}

function setMotionOff(off: boolean): void {
  if (off === motionOff) return;
  motionOff = off;
  for (const ref of motionRoots) {
    const root = ref.deref();
    if (!root) motionRoots.delete(ref);
    else if (off) stopMotion(root);
    else allowMotion(root);
  }
}

async function readMotionSetting(): Promise<void> {
  let off: unknown;
  try {
    off = await getConfig("DISABLE_ANIMATIONS");
  } catch {
    return; // no storage (tests, dead context): animations stay as they are
  }
  setMotionOff(off === true);
}

/**
 * Everywhere this module runs: a root is a root, and the switch promises
 * "across all Cuter Intra features".
 */
function watchMotionSetting(): void {
  void readMotionSetting();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.DISABLE_ANIMATIONS) void readMotionSetting();
    });
  } catch {
    /* no storage events here */
  }
}

function needsThemesFile(preset: unknown): boolean {
  return typeof preset === "string" && preset !== "" && !CORE_THEMES.has(preset);
}

function readCachedPreset(): string | null {
  try {
    return sessionStorage.getItem(PRESET_CACHE_KEY);
  } catch {
    return null;
  }
}

function cachePreset(preset: string): void {
  try {
    if (sessionStorage.getItem(PRESET_CACHE_KEY) !== preset) {
      sessionStorage.setItem(PRESET_CACHE_KEY, preset);
    }
  } catch {
    /* storage blocked: the next page just learns it a little later */
  }
}

async function readStoredPreset(): Promise<void> {
  let preset: unknown;
  try {
    preset = await getConfig("PROFILE_THEME_PRESET");
  } catch {
    return; // no storage (tests, dead context): keep what the cache said
  }
  cachePreset(typeof preset === "string" ? preset : "");
  if (needsThemesFile(preset)) useThemes();
}

/**
 * Only where widgets are served: the popup (an extension page) shows light or
 * dark only, never a preset, and links shared-styles.css itself.
 */
function watchThemePreset(): void {
  if (typeof location === "undefined" || location.protocol.endsWith("-extension:")) {
    return;
  }
  if (needsThemesFile(readCachedPreset())) useThemes();
  void readStoredPreset();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.PROFILE_THEME_PRESET) void readStoredPreset();
    });
  } catch {
    /* no storage events here */
  }
}

// Start the fetch as early as the content script itself: this module sits in
// the static import graph of main.ts, so it runs at document_start and the
// sheet is normally parsed long before the first widget mounts. The themes
// sheet follows as soon as the preset is known to need it.
void preloadSharedStyles();
watchThemePreset();
watchMotionSetting();
