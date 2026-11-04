/**
 * "Public profile" extras: everything a student can add to their own profile
 * page that every other Cuter Intra user sees when visiting it.
 *
 *   identity   bio, status (emoji + text), pronouns, flair emoji, links,
 *              a greeting shown once to visitors
 *   style      name colour / gradient / rainbow / glow / neon and font,
 *              avatar frame, level bar style, banner gradient / dim / blur,
 *              profile card glow
 *   effect     animated particles over the page (snow, stars, fireflies…)
 *
 * Wire format: the worker publishes the raw PROFILE_PUB_* settings of the
 * profile owner (see PUBLIC_EXTRAS_KEYS in the worker's settings handler) in
 * the `extras` field of /api/v1/public/visuals. They come from a stranger:
 * nothing is used before sanitizeProfileExtras() (extras-sanitize.ts) has
 * rebuilt a ProfileExtras object from it, key by key. The owner's own page
 * goes through the very same function, fed from local storage.
 *
 * This file is the contract shared by the modules of this folder:
 *   extras-sanitize.ts   raw settings  -> ProfileExtras | null
 *   extras-style.ts      ProfileExtras -> stylesheet text (pure)
 *   extras-identity.ts   ProfileExtras -> DOM block under the name + greeting
 *   extras-effects.ts    particle effects on a canvas
 *   extras-apply.ts      orchestration (viewer settings, lifecycle)
 */
import type { BetterIntraConfig } from "../../../core/config.ts";

/** Settings published to other users (all of them are PROFILE_PUB_*). */
export const EXTRAS_KEYS = [
  "PROFILE_PUB_ENABLED",
  "PROFILE_PUB_BIO",
  "PROFILE_PUB_STATUS_EMOJI",
  "PROFILE_PUB_STATUS_TEXT",
  "PROFILE_PUB_PRONOUNS",
  "PROFILE_PUB_FLAIR",
  "PROFILE_PUB_GREETING",
  "PROFILE_PUB_LINK_GITHUB",
  "PROFILE_PUB_LINK_GITLAB",
  "PROFILE_PUB_LINK_LINKEDIN",
  "PROFILE_PUB_LINK_WEBSITE",
  "PROFILE_PUB_LINK_DISCORD",
  "PROFILE_PUB_NAME_STYLE",
  "PROFILE_PUB_NAME_COLOR",
  "PROFILE_PUB_NAME_COLOR_2",
  "PROFILE_PUB_NAME_FONT",
  "PROFILE_PUB_FRAME",
  "PROFILE_PUB_FRAME_COLOR",
  "PROFILE_PUB_FRAME_COLOR_2",
  "PROFILE_PUB_LEVEL_STYLE",
  "PROFILE_PUB_LEVEL_COLOR",
  "PROFILE_PUB_LEVEL_COLOR_2",
  "PROFILE_PUB_BANNER_GRADIENT",
  "PROFILE_PUB_BANNER_DIM",
  "PROFILE_PUB_BANNER_BLUR",
  "PROFILE_PUB_CARD_GLOW",
  "PROFILE_PUB_EFFECT",
  "PROFILE_PUB_EFFECT_INTENSITY",
  "PROFILE_PUB_EFFECT_TINT",
  "PROFILE_PUB_EFFECT_COLOR",
] as const;

export type ExtrasKey = (typeof EXTRAS_KEYS)[number];
export type ExtrasConfig = Pick<BetterIntraConfig, ExtrasKey>;

export const NAME_STYLES = [
  "default",
  "accent",
  "custom",
  "gradient",
  "rainbow",
  "glow",
  "neon",
] as const;
export type NameStyle = (typeof NAME_STYLES)[number];

/** Name fonts: presets only (a stranger never chooses a font-family string). */
export const NAME_FONTS = [
  "default",
  "system",
  "humanist",
  "rounded",
  "serif",
  "mono",
] as const;
export type NameFont = (typeof NAME_FONTS)[number];

export const FRAMES = [
  "none",
  "solid",
  "double",
  "dashed",
  "gradient",
  "rainbow",
  "glow",
  "neon",
] as const;
export type Frame = (typeof FRAMES)[number];

export const LEVEL_STYLES = [
  "default",
  "custom",
  "gradient",
  "rainbow",
  "striped",
] as const;
export type LevelStyle = (typeof LEVEL_STYLES)[number];

export const EFFECTS = [
  "none",
  "snow",
  "stars",
  "fireflies",
  "confetti",
  "bubbles",
  "sakura",
  "rain",
  "embers",
] as const;
export type Effect = (typeof EFFECTS)[number];

export const INTENSITIES = ["low", "medium", "high"] as const;
export type Intensity = (typeof INTENSITIES)[number];

export type LinkKind = "github" | "gitlab" | "linkedin" | "website" | "discord";

export interface ProfileLink {
  kind: LinkKind;
  /** What is displayed (user name, host, handle). */
  label: string;
  /** https URL to open; empty for kinds that are copied instead (discord). */
  href: string;
}

/** Limits applied by the sanitizer (characters, after normalisation). */
export const LIMITS = {
  bio: 160,
  statusEmoji: 16,
  statusText: 60,
  pronouns: 24,
  greeting: 80,
  flairItems: 6,
  flairItemLength: 16,
  bannerDimMax: 80,
  bannerBlurMax: 12,
} as const;

/**
 * Sanitised, render-ready extras. Every string is plain text (rendered
 * through text bindings, never as HTML), every colour a strict #rrggbb,
 * every enum one of the lists above, every href an https URL built or
 * validated by the sanitizer.
 */
export interface ProfileExtras {
  bio: string;
  statusEmoji: string;
  statusText: string;
  pronouns: string;
  flair: string[];
  greeting: string;
  links: ProfileLink[];

  nameStyle: NameStyle;
  nameColor: string;
  nameColor2: string;
  nameFont: NameFont;

  frame: Frame;
  frameColor: string;
  frameColor2: string;

  levelStyle: LevelStyle;
  levelColor: string;
  levelColor2: string;

  /** Key of BG_PRESETS (customize.ts); "none" = no gradient. */
  bannerGradient: string;
  bannerDim: number;
  bannerBlur: number;
  cardGlow: boolean;

  effect: Effect;
  effectIntensity: Intensity;
  /** "" = the effect's own colours. */
  effectColor: string;
}

/* ------------------------------------------------------------------ */
/* DOM anchors on the v3 profile page (kept next to each other so a    */
/* change of the Intra markup is fixed in one place)                   */
/* ------------------------------------------------------------------ */

/** Added by profile-card.ts on the header card of a profile. */
export const PROFILE_CARD = ".ft-profile-card";
/** Display name, inside the profile card. */
export const NAME_SELECTOR = `${PROFILE_CARD} h2.text-2xl`;
/** Login line under the name (exact class attribute, as profile-card.ts uses). */
export const LOGIN_SELECTOR = 'p[class="text-sm"]';
/** Fill of the level progress bar. */
export const LEVEL_FILL_SELECTOR = `${PROFILE_CARD} div[role="progressbar"] > div`;

export const EXTRAS_STYLE_ID = "ft-profile-extras-style";
export const EXTRAS_IDENTITY_ID = "ft-profile-extras";
export const EXTRAS_EFFECT_ID = "ft-profile-extras-effect";
