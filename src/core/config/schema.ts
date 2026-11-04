/**
 * The shape of every Cuter Intra setting: BetterIntraConfig and ConfigKey.
 *
 * Types only, so that the defaults, the key lists and the storage code share
 * one definition without depending on each other. Import them from
 * src/core/config.ts, the public entry point.
 */

/**
 * Defines the complete shape and types for all configuration options.
 * Using a strict interface ensures type safety across the application
 * and provides excellent autocompletion in the IDE.
 */
export interface BetterIntraConfig {
  // General Settings
  ACTIVE_SCRIPTS: string[];
  BETTER_INTRA_THEME: "dark" | "light" | "system";
  DISABLE_ANIMATIONS: boolean;

  // Cloud Sync Settings
  CLOUD_SYNC_ENABLED: boolean;
  LAST_CLOUD_SYNC: number | null;
  CLOUD_TOKEN: string;
  CLOUD_LOGIN: string;
  CLOUD_AUTH_FAILED: boolean;
  /**
   * The revision of the cloud settings this browser last pulled or pushed
   * (the worker's settingsRev); a full push sends it as baseRev, and the
   * worker refuses it (409) when another browser wrote since. null: never
   * known (a browser from before revisions, or just signed in).
   */
  CLOUD_SETTINGS_REV: number | null;
  /**
   * Public settings changed here and not published yet, each with when it
   * changed (publish.ts). Kept in storage so that a reload or a link within
   * the publish delay does not lose the change: the next page sends it.
   */
  LOOK_PUBLISH_PENDING: Record<string, number>;
  /** The sign-in notice was read and accepted on this browser (loginWith42). */
  SIGNIN_DISCLOSURE_ACCEPTED: boolean;
  ACCOUNT: object | null; // Stores user account info from 42 API

  // Logtime Feature Settings
  LOGTIME_GOAL_HOURS: number;
  LOGTIME_SHOW_AVERAGE: boolean;
  LOGTIME_SHOW_GOAL: boolean;
  /** The streak badge (records in its tooltip) in the widget's header. */
  LOGTIME_SHOW_RECORDS: boolean;
  LOGTIME_SHOW_TACOS: boolean;
  LOGTIME_EMOJI: string;
  LOGTIME_EMOJI_DIVISOR: number;
  LOGTIME_EMOJI_RATE: number;
  LOGTIME_MAX_EARNINGS: number;
  LOGTIME_SHOW_DAYS_MODE: "date" | "days" | "both";
  LOGTIME_CALENDAR_COLOR: string;
  LOGTIME_LABELS_COLOR: string;
  LOGTIME_RAINBOW_PALETTE: string;
  LOGTIME_CALENDAR_VIEW: string;

  // Clusters Feature Settings
  CLUSTERS_SHOW_MARKERS: boolean;
  CLUSTERS_DEFAULT_ID: string;
  CLUSTERS_OPEN_NEW_TAB: boolean;

  // Profile Feature Settings
  PROFILE_EVENT_TYPE_FILTER: string;
  CLUSTERS_CAMPUS: string;
  PROFILE_IMAGE_URL: string;
  PROFILE_BANNER_URL: string;
  PROFILE_BANNER_MODE: "fill" | "fit";
  PROFILE_BANNER_COLOR: string;
  PROFILE_BACKGROUND_URL: string;
  PROFILE_BACKGROUND_MODE: "fill" | "fit";
  PROFILE_BACKGROUND_COLOR: string;
  PROFILE_CARD_ORDER: string[];
  PROFILE_USE_CUSTOM_COLOR: boolean;
  PROFILE_THEME_PRESET: string;
  PROFILE_SHOW_MARKS: boolean;
  PROFILE_SHOW_ROULETTE: boolean;
  PROFILE_SHOW_ROULETTE_HISTORY: boolean;
  PROFILE_MARKS_SORT_ORDER: "newest_first" | "oldest_first";
  PROFILE_PROJECTS_SORT: boolean;
  PROFILE_MARKS_SHOW_REAL_DATE: boolean;
  PROFILE_SHOW_ACHIEVEMENTS: boolean;
  PROFILE_SHOW_EVALUATIONS: boolean;
  PROFILE_USE_MODERN_INFO_CARD: boolean;
  PROFILE_AVATAR_BG: string;
  PROFILE_DECORATION: string;
  PROFILE_AVATAR_POSITION_X: number;
  PROFILE_AVATAR_POSITION_Y: number;
  PROFILE_AVATAR_SCALE: number;
  PROFILE_BADGE_BG: string;
  PROFILE_BADGE_ORDER: string[];
  PROFILE_BADGE_WRAP: boolean;
  PROFILE_IMAGE_HISTORY: string[];
  PROFILE_BANNER_HISTORY: string[];
  PROFILE_BACKGROUND_HISTORY: string[];

  // Shortcuts Feature Settings
  SHORTCUTS_LINKS: { name: string; url: string }[];
  SHORTCUTS_HIDE_IMPORTANT_LINKS: boolean;
  SHORTCUTS_ALIGNMENT: "left" | "center" | "right";

  FRIENDS_LIST: string[];
  FRIENDS_SORT_MODE: "name" | "level" | "wallet" | "correction";
  FRIENDS_SORT_DIR: "asc" | "desc";
  FRIENDS_ONLINE_ONLY: boolean;
  SHOW_FRIENDS_WIDGET: boolean;
  SHOW_CUSTOM_AVATARS_IN_FRIENDS: boolean;
  FRIENDS_DATA_CACHE: { data: unknown[]; timestamp: number } | null;
  TRACKER_MODE:
    | "off"
    | "phoenix-1"
    | "phoenix-2"
    | "phoenix-3"
    | "phoenix-4"
    | "pegasus-bronze"
    | "pegasus-silver"
    | "pegasus-gold"
    | "pegasus-diamond"
    | "pegasus-vibranium";

  // Calendar Sync
  CALENDAR_SYNC_TOKEN: string;
  CALENDAR_EVENTS_HASH: string;
  ADVANCED_OPEN_LINKS_NEW_TAB: boolean;
  /** Seven small secrets hidden in the Intra (see features/eggs). */
  EASTER_EGGS_ENABLED: boolean;
  /** Language of Cuter Intra: "auto" follows the browser (core/i18n). */
  UI_LANGUAGE: "auto" | "en" | "fr";
  EGGS_FOUND: string[];

  // Customize (look & feel of every Intra page)
  CUSTOM_ACCENT_ENABLED: boolean;
  CUSTOM_ACCENT_COLOR: string;
  CUSTOM_FONT: "default" | "system" | "humanist" | "rounded" | "serif" | "mono" | "custom";
  CUSTOM_FONT_FAMILY: string;
  CUSTOM_FONT_SCALE: number;
  CUSTOM_RADIUS: "default" | "none" | "small" | "large" | "full";
  CUSTOM_CSS: string;
  CUSTOM_THEME_ENABLED: boolean;
  CUSTOM_THEME_BG: string;
  CUSTOM_THEME_CARD: string;
  CUSTOM_THEME_TEXT: string;
  CUSTOM_PAGE_BG_URL: string;
  CUSTOM_PAGE_BG_DIM: number;
  CUSTOM_CARD_OPACITY: number;
  CUSTOM_AVATAR_SHAPE: "circle" | "rounded" | "square";
  CUSTOM_PAGE_BG_PRESET:
    | "none"
    | "aurora"
    | "sunset"
    | "ocean"
    | "forest"
    | "mono"
    | "midnight"
    | "candy"
    | "lava"
    | "nord"
    | "dracula"
    | "teal"
    | "space"
    | "mesh";
  CUSTOM_CARD_STYLE: "default" | "flat" | "soft" | "strong" | "outlined" | "glass" | "stripe";
  CUSTOM_SCROLLBAR: "default" | "thin" | "accent" | "hidden";
  CUSTOM_ACCENT_GRADIENT: boolean;
  CUSTOM_ACCENT_COLOR_2: string;
  CUSTOM_BG_ANIMATE: boolean;
  CUSTOM_DENSITY: "default" | "compact" | "comfortable";
  CUSTOM_HIDE_FOOTER: boolean;
  // Dashboard cards (Agenda, Evaluations, Achievements, Projects, Roulette, Logtime)
  CUSTOM_CARD_BORDER_MODE: "none" | "accent" | "custom";
  CUSTOM_CARD_BORDER_COLOR: string;
  CUSTOM_CARD_BORDER_WIDTH: number;
  CUSTOM_CARD_GLOW: boolean;
  CUSTOM_CARD_TITLE_MODE: "default" | "accent" | "custom";
  CUSTOM_CARD_TITLE_COLOR: string;
  /** Per-card overrides keyed by card id (see CARD_IDS in customize.ts). */
  CUSTOM_CARDS: Record<string, { bg?: string; border?: string; title?: string; glow?: boolean }>;
  CUSTOM_PRESETS: { name: string; values: Record<string, unknown> }[];
  /** Publish my look (accent, palette, background, cards) on my profile for other Cuter Intra users. */
  CUSTOM_SHARE_LOOK: boolean;
  /** Apply the look other users publish when I visit their profile. */
  CUSTOM_SHOW_OTHERS_LOOK: boolean;

  // Public profile extras (features/profile/extras): visible to every
  // Cuter Intra user who opens my profile.
  PROFILE_PUB_ENABLED: boolean;
  PROFILE_PUB_BIO: string;
  PROFILE_PUB_STATUS_EMOJI: string;
  PROFILE_PUB_STATUS_TEXT: string;
  PROFILE_PUB_PRONOUNS: string;
  /** Space-separated emoji shown next to the name. */
  PROFILE_PUB_FLAIR: string;
  PROFILE_PUB_GREETING: string;
  PROFILE_PUB_LINK_GITHUB: string;
  PROFILE_PUB_LINK_GITLAB: string;
  PROFILE_PUB_LINK_LINKEDIN: string;
  PROFILE_PUB_LINK_WEBSITE: string;
  PROFILE_PUB_LINK_DISCORD: string;
  PROFILE_PUB_NAME_STYLE: "default" | "accent" | "custom" | "gradient" | "rainbow" | "glow" | "neon";
  PROFILE_PUB_NAME_COLOR: string;
  PROFILE_PUB_NAME_COLOR_2: string;
  PROFILE_PUB_NAME_FONT: "default" | "system" | "humanist" | "rounded" | "serif" | "mono";
  PROFILE_PUB_FRAME: "none" | "solid" | "double" | "dashed" | "gradient" | "rainbow" | "glow" | "neon";
  PROFILE_PUB_FRAME_COLOR: string;
  PROFILE_PUB_FRAME_COLOR_2: string;
  PROFILE_PUB_LEVEL_STYLE: "default" | "custom" | "gradient" | "rainbow" | "striped";
  PROFILE_PUB_LEVEL_COLOR: string;
  PROFILE_PUB_LEVEL_COLOR_2: string;
  PROFILE_PUB_BANNER_GRADIENT: string;
  PROFILE_PUB_BANNER_DIM: number;
  PROFILE_PUB_BANNER_BLUR: number;
  PROFILE_PUB_CARD_GLOW: boolean;
  PROFILE_PUB_EFFECT: "none" | "snow" | "stars" | "fireflies" | "confetti" | "bubbles" | "sakura" | "rain" | "embers";
  PROFILE_PUB_EFFECT_INTENSITY: "low" | "medium" | "high";
  PROFILE_PUB_EFFECT_TINT: boolean;
  PROFILE_PUB_EFFECT_COLOR: string;
  /** Viewer side: show the extras other people publish on their profile. */
  PROFILE_SHOW_OTHERS_EXTRAS: boolean;

  // Lighten the Intra (features/performance): make the Intra's own pages
  // cheaper to render. All four default to on; see features/performance/perf.ts.
  /** content-visibility on the long repeated lists, so off-screen rows cost nothing. */
  PERF_DEFER_OFFSCREEN: boolean;
  /** loading="lazy" / decoding="async" on the page's own off-screen images. */
  PERF_LAZY_IMAGES: boolean;
  /** Pause the page's CSS animations and transitions while the tab is hidden. */
  PERF_PAUSE_HIDDEN: boolean;
  /** Warm the avatar CDN connection before the page asks for the first avatar. */
  PERF_PRECONNECT: boolean;

  // Subject Tracker
  SUBJECT_TRACKER_ENABLED: boolean;
  SUBJECT_TRACKER_SEND_DATA: boolean;
  SUBJECT_TRACKER_STATE: Record<
    string,
    {
      lastUrl?: string;
      versionDate?: number;
      changedAt?: number;
      checkedAt?: number;
    }
  >;
}

/**
 * A type representing all possible configuration keys, derived directly
 * from the BetterIntraConfig interface to prevent any mismatches.
 */
export type ConfigKey = keyof BetterIntraConfig;
