/**
 * Cuter Intra in English or in French.
 *
 * The English text IS the key: code writes t("Reload to apply") and the
 * French catalog (src/core/i18n/fr/*.json, English → French) gives the
 * translation. A missing entry falls back to the English text, so an
 * untranslated string still reads. The bundle holds the catalog as a JSON
 * string, parsed on the first French lookup: a page in English never parses
 * it (about 0.15 ms on every Intra page) nor keeps the object.
 *
 * The language is the UI_LANGUAGE setting ("auto", "en", "fr"); "auto" is the
 * browser's language (French for any fr-*, English otherwise). It is read
 * once per page by initI18n(), before anything renders; a change applies on
 * the next page (the hub says "Reload to apply").
 *
 * Rules for callers (tests/i18n-catalog.test.ts checks them):
 *  - the first argument of t() / tp() / msg() is a string literal, so the
 *    catalog test and the build (scripts/i18n-catalog.ts, which keeps in each
 *    bundle only the entries whose English text it contains) can find it;
 *  - values go in {placeholders}: t("Missed by {h}", { h: "19h30" });
 *  - a text defined at module level is marked with msg("...") and translated
 *    with t(CONSTANT) where it is shown: module code runs before the
 *    language is known;
 *  - never translate a string that is matched against the Intra's own page
 *    (labels read from its DOM, selectors).
 */
import FR_JSON from "virtual:bi-fr-catalog";
import { getConfig } from "../config.ts";

export type Lang = "en" | "fr";
export type LangSetting = "auto" | Lang;

export const LANG_SETTINGS: readonly LangSetting[] = ["auto", "fr", "en"];

/** The French catalog once a French text was asked for; null until then. */
let catalog: Readonly<Record<string, string>> | null = null;

function french(key: string): string {
  catalog ??= JSON.parse(FR_JSON) as Readonly<Record<string, string>>;
  return catalog[key] ?? key;
}

/** The browser's language: its UI language for an extension, else the page's. */
export function detectLang(): Lang {
  let raw = "";
  try {
    raw = chrome?.i18n?.getUILanguage?.() ?? "";
  } catch {
    // no extension context (tests, an orphaned script)
  }
  if (!raw && typeof navigator !== "undefined") {
    raw = navigator.languages?.[0] ?? navigator.language ?? "";
  }
  return raw.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** The language a UI_LANGUAGE value stands for. */
export function resolveLang(setting: unknown): Lang {
  return setting === "fr" || setting === "en" ? setting : detectLang();
}

let lang: Lang = detectLang();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
}

let ready: Promise<Lang> | null = null;

/**
 * Reads UI_LANGUAGE once and sets the language. Every entry point (content
 * script, popup) awaits it before rendering text. Idempotent.
 */
export function initI18n(): Promise<Lang> {
  ready ??= getConfig("UI_LANGUAGE")
    .then((setting) => {
      setLang(resolveLang(setting));
      return lang;
    })
    .catch(() => lang);
  return ready;
}

function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** `key` (the English text) in the current language, {placeholders} filled. */
export function t(key: string, params?: Record<string, string | number>): string {
  const text = lang === "fr" ? french(key) : key;
  return fill(text, params);
}

/**
 * A count: `one` or `other` (both English, both keys) by the current
 * language's rule (French: 0 and 1 are singular), with {n} filled.
 */
export function tp(
  n: number,
  one: string,
  other: string,
  params?: Record<string, string | number>,
): string {
  const singular = lang === "fr" ? Math.abs(n) < 2 : n === 1;
  return t(singular ? one : other, { n, ...params });
}

/**
 * Marks a text for translation where it is defined, without translating it
 * (module-level constants): pass it to t() where it is shown.
 */
export function msg(text: string): string {
  return text;
}

/** The locale for Intl formatting: French, or the English one the caller used. */
export function intlLocale(english = "en-US"): string {
  return lang === "fr" ? "fr-FR" : english;
}
