/**
 * The "public look": the part of a user's Customize settings that they can
 * publish on their profile so that other Cuter Intra users see their
 * profile page the way they styled it.
 *
 * Only presentation values that are safe to receive from a stranger are
 * included: the theme preset (a known key), colours (strict hex), enumerated
 * presets, clamped numbers and an http(s) image URL. Fonts, font scale, scrollbars, density and above all
 * the free-form CSS stay with their author.
 */
import { CONFIG_DEFAULT } from "../../core/config.ts";
import {
  sanitizeCssUrl,
  sanitizeHexColor,
} from "../../core/security/css-sanitize.ts";
import {
  AVATAR_RADIUS,
  BG_PRESETS,
  CARD_STYLES,
  RADIUS,
  sanitizeCardMap,
  type CustomizeConfig,
} from "./customize.ts";
import { THEME_IDS } from "../../core/theme/theme-ids.ts";

export const PUBLIC_LOOK_KEYS = [
  "PROFILE_THEME_PRESET",
  "CUSTOM_ACCENT_ENABLED",
  "CUSTOM_ACCENT_COLOR",
  "CUSTOM_ACCENT_GRADIENT",
  "CUSTOM_ACCENT_COLOR_2",
  "CUSTOM_RADIUS",
  "CUSTOM_THEME_ENABLED",
  "CUSTOM_THEME_BG",
  "CUSTOM_THEME_CARD",
  "CUSTOM_THEME_TEXT",
  "CUSTOM_PAGE_BG_URL",
  "CUSTOM_PAGE_BG_DIM",
  "CUSTOM_PAGE_BG_PRESET",
  "CUSTOM_BG_ANIMATE",
  "CUSTOM_CARD_OPACITY",
  "CUSTOM_CARD_STYLE",
  "CUSTOM_AVATAR_SHAPE",
  "CUSTOM_CARD_BORDER_MODE",
  "CUSTOM_CARD_BORDER_COLOR",
  "CUSTOM_CARD_BORDER_WIDTH",
  "CUSTOM_CARD_GLOW",
  "CUSTOM_CARD_TITLE_MODE",
  "CUSTOM_CARD_TITLE_COLOR",
  "CUSTOM_CARDS",
] as const;

export type PublicLookKey = (typeof PUBLIC_LOOK_KEYS)[number];
export type PublicLook = Partial<Pick<CustomizeConfig, PublicLookKey>>;

const HEX_KEYS = new Set<PublicLookKey>([
  "CUSTOM_ACCENT_COLOR",
  "CUSTOM_ACCENT_COLOR_2",
  "CUSTOM_THEME_BG",
  "CUSTOM_THEME_CARD",
  "CUSTOM_THEME_TEXT",
  "CUSTOM_CARD_BORDER_COLOR",
  "CUSTOM_CARD_TITLE_COLOR",
]);

const ENUMS: Partial<Record<PublicLookKey, Record<string, string>>> = {
  CUSTOM_RADIUS: RADIUS,
  CUSTOM_PAGE_BG_PRESET: BG_PRESETS,
  CUSTOM_CARD_STYLE: CARD_STYLES,
  CUSTOM_AVATAR_SHAPE: AVATAR_RADIUS,
  CUSTOM_CARD_BORDER_MODE: { none: "", accent: "", custom: "" },
  CUSTOM_CARD_TITLE_MODE: { default: "", accent: "", custom: "" },
};

const RANGES: Partial<Record<PublicLookKey, [number, number]>> = {
  CUSTOM_PAGE_BG_DIM: [0, 90],
  CUSTOM_CARD_OPACITY: [30, 100],
  CUSTOM_CARD_BORDER_WIDTH: [1, 6],
};

/**
 * Validate a look received from the cloud. Unknown keys and invalid values
 * are dropped; returns null when nothing visible remains (every kept value
 * equals its default).
 */
export function sanitizePublicLook(raw: unknown): PublicLook | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_LOOK_KEYS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    const def = CONFIG_DEFAULT[key];
    if (key === "CUSTOM_CARDS") {
      const cards = sanitizeCardMap(v);
      if (Object.keys(cards).length) out[key] = cards;
    } else if (typeof def === "boolean") {
      out[key] = v === true;
    } else if (typeof def === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [min, max] = RANGES[key] ?? [-Infinity, Infinity];
      out[key] = Math.min(max, Math.max(min, Math.round(n)));
    } else if (typeof v !== "string") {
      continue;
    } else if (HEX_KEYS.has(key)) {
      const hex = sanitizeHexColor(v);
      if (hex) out[key] = hex;
    } else if (key === "PROFILE_THEME_PRESET") {
      // a preset this build knows, nothing else reaches the theme manager
      if (THEME_IDS.has(v)) out[key] = v;
    } else if (key === "CUSTOM_PAGE_BG_URL") {
      out[key] = sanitizeCssUrl(v);
    } else if (ENUMS[key]) {
      if (v in ENUMS[key]!) out[key] = v;
    }
  }
  const visible = PUBLIC_LOOK_KEYS.some(
    (key) => key in out && out[key] !== CONFIG_DEFAULT[key],
  );
  return visible ? (out as PublicLook) : null;
}

/** Pick the publishable subset of a full customisation. */
export function pickPublicLook(values: Partial<CustomizeConfig>): PublicLook {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_LOOK_KEYS) {
    if (key in values) out[key] = values[key];
  }
  return out as PublicLook;
}
