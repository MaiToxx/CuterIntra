import { CONFIG_DEFAULT, type ConfigKey } from "../../core/config.ts";
import { isValidStoredValue } from "../../core/config/access.ts";
import { sanitizeCssUrl } from "../../core/security/css-sanitize.ts";
import { CUSTOMIZE_KEYS } from "../customize/customize.ts";
import { sanitizeCustomization } from "../customize/presets.ts";
import { EXTRAS_KEYS } from "../profile/extras/extras.ts";
import { HUB_SETTING_DEFS } from "./hubSettings.data.ts";

/**
 * Keys that must never leave the browser in a backup file, nor be written
 * back from one: credentials, session state and caches.
 */
export const BACKUP_EXCLUDED_KEYS: ReadonlySet<string> = new Set<ConfigKey>([
  "CLOUD_TOKEN",
  "CLOUD_LOGIN",
  "CLOUD_AUTH_FAILED",
  // consent given on one browser, not carried to another in a file
  "SIGNIN_DISCLOSURE_ACCEPTED",
  // likewise (as cloud sync leaves them out, core/config/keys.ts): someone
  // else's file turned automatic pushes and subject sharing back on
  "CLOUD_SYNC_ENABLED",
  "SUBJECT_TRACKER_ENABLED",
  "SUBJECT_TRACKER_SEND_DATA",
  "LAST_CLOUD_SYNC",
  // sync state of this browser: restored elsewhere, a revision would hide
  // another browser's changes from the conflict check
  "CLOUD_SETTINGS_REV",
  "LOOK_PUBLISH_PENDING",
  "ACCOUNT",
  "CALENDAR_SYNC_TOKEN",
  "CALENDAR_EVENTS_HASH",
  "FRIENDS_DATA_CACHE",
]);

/**
 * Settings a backup made by someone else could turn against the user: a free
 * stylesheet applied to every Intra page, and the public profile fields the
 * next push publishes under the user's own login. Theme codes refuse them;
 * an import asks before restoring them (see backupSensitiveKeys).
 */
export const BACKUP_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
  "CUSTOM_CSS",
  ...EXTRAS_KEYS,
]);

/** Image links of the look: only plain http(s) URLs are restored. */
const URL_KEYS: readonly ConfigKey[] = [
  "CUSTOM_PAGE_BG_URL",
  "PROFILE_IMAGE_URL",
  "PROFILE_BANNER_URL",
  "PROFILE_BACKGROUND_URL",
];

/**
 * Selects whose options are only known at run time (the campus list, the
 * event types of the feed): their stored value cannot be checked against
 * the def.
 */
const DYNAMIC_OPTION_KEYS: ReadonlySet<string> = new Set([
  "CLUSTERS_DEFAULT_ID",
  "PROFILE_EVENT_TYPE_FILTER",
  "CLUSTERS_CAMPUS",
]);

/** The metadata an export carries around its settings. */
export interface BackupMeta {
  version?: string;
  exportedAt?: string;
}

export interface BackupFile extends BackupMeta {
  settings: Record<string, unknown>;
}

/**
 * Several UI paths store arrays as JSON strings (FRIENDS_LIST, SHORTCUTS_LINKS,
 * ACTIVE_SCRIPTS); getConfig() parses them back. Do the same here so that the
 * shape check below compares the real value.
 */
function parseLegacyJson(value: unknown): unknown {
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Keep only known, non-sensitive settings from a raw storage dump.
 * Used when exporting.
 */
export function exportableSettings(
  items: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(items)) {
    if (!(key in CONFIG_DEFAULT)) continue;
    if (BACKUP_EXCLUDED_KEYS.has(key)) continue;
    out[key] = parseLegacyJson(value);
  }
  return out;
}

/** What the Export button writes: the settings with when and what made them. */
export function wrapBackup(
  settings: Record<string, unknown>,
  version: string,
  now = new Date(),
): BackupFile {
  return { version, exportedAt: now.toISOString(), settings };
}

/**
 * Reads either shape of a backup file: the wrapped one with its metadata, or
 * the bare key -> value object of the versions before it.
 *
 * @throws if the payload is not a plain object.
 */
export function unwrapBackup(data: unknown): BackupFile {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Backup must be a JSON object");
  }
  const obj = data as Record<string, unknown>;
  const wrapped =
    obj.settings &&
    typeof obj.settings === "object" &&
    !Array.isArray(obj.settings) &&
    !("settings" in CONFIG_DEFAULT);
  if (!wrapped) return { settings: obj };
  return {
    settings: obj.settings as Record<string, unknown>,
    version: typeof obj.version === "string" ? obj.version : undefined,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : undefined,
  };
}

/** The hub's rules for a key: its option values and its numeric bounds. */
function hubRule(key: string): {
  options?: Set<string>;
  min?: number;
  max?: number;
} | null {
  for (const defs of Object.values(HUB_SETTING_DEFS)) {
    for (const def of defs) {
      if (def.key !== key) continue;
      const values = (def.options ?? [])
        .map((o) => o.value)
        .filter((v): v is string => typeof v === "string");
      const enumerated =
        (def.kind === "select" ||
          def.kind === "radio-group" ||
          def.kind === "theme-preset") &&
        values.length > 0 &&
        !DYNAMIC_OPTION_KEYS.has(key);
      return {
        options: enumerated ? new Set(values) : undefined,
        min: def.min,
        max: def.max,
      };
    }
  }
  return null;
}

/**
 * Validate an imported backup before it is written to storage.
 * Unknown keys, sensitive keys and values whose type does not match the
 * default are dropped instead of being blindly persisted. Beyond the shape,
 * a select must hold one of its options, a number must sit within its def's
 * bounds, an image link must be a plain http(s) URL and the Customize keys
 * present in the file go through the sanitiser theme codes use.
 *
 * @throws if the payload is not a plain object.
 */
export function sanitizeBackup(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Backup must be a JSON object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (!(key in CONFIG_DEFAULT)) continue;
    if (BACKUP_EXCLUDED_KEYS.has(key)) continue;
    const value = parseLegacyJson(raw);
    if (key === "CUSTOM_PRESETS") {
      const presets = sanitizeBackupPresets(value);
      if (presets) out[key] = presets;
      continue;
    }
    if (!isValidStoredValue(key, value)) continue;
    const rule = hubRule(key);
    if (rule) {
      if (rule.options && !rule.options.has(String(value))) continue;
      if (typeof value === "number") {
        if (rule.min !== undefined && value < rule.min) continue;
        if (rule.max !== undefined && value > rule.max) continue;
      }
    }
    out[key] = value;
  }
  for (const key of URL_KEYS) {
    // an empty string means "no image" and is kept; a link that is not
    // plain http(s) (javascript:, data:) is not
    const url = out[key];
    if (typeof url === "string" && url.trim() !== "" && !sanitizeCssUrl(url)) {
      delete out[key];
    }
  }
  // Only the Customize keys the file holds: filling the absent ones with
  // defaults would reset settings the backup never mentioned.
  const customize = CUSTOMIZE_KEYS.filter((key) => key in out);
  if (customize.length > 0) {
    const clean = sanitizeCustomization(out) as Record<string, unknown>;
    for (const key of customize) out[key] = clean[key];
  }
  return out;
}

/** presets.ts limits, repeated: that module is not this one's to export from. */
const MAX_PRESETS = 20;
const MAX_PRESET_NAME = 40;

/**
 * The saved Customize presets of a backup, or null when the list is not one.
 *
 * isValidStoredValue only knows lists of strings, so every import dropped
 * the presets an export had written. Each preset goes through the sanitiser
 * theme codes use, and loses its custom CSS the way a theme code does: a
 * stylesheet in a friendly-named preset of someone else's file would apply
 * on Apply, past the import's custom CSS question.
 */
export function sanitizeBackupPresets(
  value: unknown,
): { name: string; values: Record<string, unknown> }[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: { name: string; values: Record<string, unknown> }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { name, values } = item as { name?: unknown; values?: unknown };
    if (typeof name !== "string") continue;
    const clean = name.trim().slice(0, MAX_PRESET_NAME);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const raw =
      values && typeof values === "object" && !Array.isArray(values)
        ? (values as Record<string, unknown>)
        : {};
    const sanitized = sanitizeCustomization({ ...raw, CUSTOM_CSS: "" }) as Record<
      string,
      unknown
    >;
    // the same rule as the top-level image links (URL_KEYS)
    const bg = sanitized.CUSTOM_PAGE_BG_URL;
    if (typeof bg === "string" && bg.trim() !== "" && !sanitizeCssUrl(bg)) {
      sanitized.CUSTOM_PAGE_BG_URL = "";
    }
    out.push({ name: clean, values: { ...sanitized, CUSTOM_CSS: "" } });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/**
 * The sensitive keys of a sanitised backup that would change something: the
 * ones the import asks about. A default or empty value is not worth a prompt.
 */
export function backupSensitiveKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).filter((key) => {
    if (!BACKUP_SENSITIVE_KEYS.has(key)) return false;
    const value = settings[key];
    if (typeof value === "string") return value.trim() !== "";
    return (
      JSON.stringify(value) !== JSON.stringify(CONFIG_DEFAULT[key as ConfigKey])
    );
  });
}
