/**
 * Named presets and shareable "theme codes" for the Customize tab.
 *
 * A preset is a snapshot of every Customize setting (CUSTOMIZE_KEYS). Presets
 * are stored in CUSTOM_PRESETS (cloud-synced like the rest) and a preset can
 * be exported as a short code ("BI1.<base64url json>") that another user
 * pastes to get the same look. Codes are validated key by key against the
 * defaults before anything is written to storage.
 */
import { CONFIG_DEFAULT, getConfigMany } from "../../core/config.ts";
import { CUSTOMIZE_KEYS, sanitizeCardMap, type CustomizeConfig } from "./customize.ts";
import { THEME_IDS } from "../../core/theme/theme-ids.ts";

export interface CustomPreset {
  name: string;
  values: CustomizeConfig;
}

export const PRESETS_KEY = "CUSTOM_PRESETS";
export const CODE_PREFIX = "BI1.";
const MAX_PRESETS = 20;
const MAX_NAME = 40;

function sameShape(value: unknown, reference: unknown): boolean {
  if (Array.isArray(reference)) return Array.isArray(value);
  return typeof value === typeof reference && !Array.isArray(value);
}

/** Keep only known Customize keys with the right type; others fall back to defaults. */
export function sanitizeCustomization(raw: unknown): CustomizeConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<string, unknown>;
  for (const key of CUSTOMIZE_KEYS) {
    const def = CONFIG_DEFAULT[key];
    let v = src[key];
    // The hub stores <input type="number"> values as strings: accept them
    // (a snapshot used to silently reset size, dim and opacity to defaults).
    if (typeof def === "number" && typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) v = n;
    }
    if (key === "CUSTOM_CARDS") {
      out[key] = sanitizeCardMap(v);
      continue;
    }
    if (key === "PROFILE_THEME_PRESET") {
      // a code from another build may name a theme this one does not have
      out[key] = typeof v === "string" && THEME_IDS.has(v) ? v : def;
      continue;
    }
    out[key] = sameShape(v, def) ? v : def;
  }
  return out as CustomizeConfig;
}

export async function snapshotCustomization(): Promise<CustomizeConfig> {
  return sanitizeCustomization(await getConfigMany(CUSTOMIZE_KEYS));
}

export async function applyCustomization(values: CustomizeConfig): Promise<void> {
  await chrome.storage.local.set(sanitizeCustomization(values));
}

export async function resetCustomization(): Promise<void> {
  const defaults = {} as Record<string, unknown>;
  // Reset is the Customize tab's button: the theme picked in the Profile tab
  // stays (a preset or a theme code still sets it).
  for (const key of CUSTOMIZE_KEYS) {
    if (key !== "PROFILE_THEME_PRESET") defaults[key] = CONFIG_DEFAULT[key];
  }
  await chrome.storage.local.set(defaults);
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Theme codes travel between users, so the free-form stylesheet never rides
 * along: a pasted code could otherwise hide parts of the Intra or draw fake
 * prompts on every page. Local presets keep it.
 */
const CODE_EXCLUDED_KEYS: ReadonlySet<string> = new Set(["CUSTOM_CSS"]);

/** Only the values that differ from the defaults are encoded (shorter codes). */
export function encodePresetCode(values: CustomizeConfig): string {
  const diff: Record<string, unknown> = {};
  for (const key of CUSTOMIZE_KEYS) {
    if (CODE_EXCLUDED_KEYS.has(key)) continue;
    if (JSON.stringify(values[key]) !== JSON.stringify(CONFIG_DEFAULT[key])) {
      diff[key] = values[key];
    }
  }
  return CODE_PREFIX + b64urlEncode(JSON.stringify(diff));
}

/** Returns null when the code is not a valid Cuter Intra theme code. */
export function decodePresetCode(code: unknown): CustomizeConfig | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(trimmed.slice(CODE_PREFIX.length)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const key of CODE_EXCLUDED_KEYS) delete (parsed as Record<string, unknown>)[key];
    return sanitizeCustomization(parsed);
  } catch {
    return null;
  }
}

/** Host of the background image a code would load, if any (shown before applying). */
export function presetImageHost(values: CustomizeConfig): string | null {
  try {
    return values.CUSTOM_PAGE_BG_URL ? new URL(values.CUSTOM_PAGE_BG_URL).host : null;
  } catch {
    return null;
  }
}

export async function listPresets(): Promise<CustomPreset[]> {
  const store = await chrome.storage.local.get(PRESETS_KEY);
  const raw = store[PRESETS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is CustomPreset => !!p && typeof p === "object" && typeof (p as CustomPreset).name === "string")
    .map((p) => ({ name: p.name.slice(0, MAX_NAME), values: sanitizeCustomization(p.values) }));
}

export async function savePreset(name: string, values: CustomizeConfig): Promise<CustomPreset[]> {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) throw new Error("Preset name is empty");
  const presets = (await listPresets()).filter((p) => p.name !== clean);
  presets.unshift({ name: clean, values: sanitizeCustomization(values) });
  const next = presets.slice(0, MAX_PRESETS);
  await chrome.storage.local.set({ [PRESETS_KEY]: next });
  return next;
}

export async function deletePreset(name: string): Promise<CustomPreset[]> {
  const next = (await listPresets()).filter((p) => p.name !== name);
  await chrome.storage.local.set({ [PRESETS_KEY]: next });
  return next;
}
