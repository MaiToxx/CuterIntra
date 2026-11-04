/**
 * What the settings hub is made of: its tabs (FEATURE_DEFS), the shape of a
 * setting (HubSettingDef) and every setting of every tab (HUB_SETTING_DEFS).
 *
 * The settings of each tab live in settings/<tab>.ts and are only assembled
 * here, so a tab reads on its own. The imports go one way: a tab module takes
 * the types from this file with `import type` (erased at build time) and the
 * option lists several tabs share from settings/options.ts. A value imported
 * back from this file would be a cycle.
 */
import CLOCK from "../../assets/svg/clock.svg?raw";
import CALENDAR from "../../assets/svg/calendar.svg?raw";
import CLUSTERS from "../../assets/svg/clusters.svg?raw";
import USER from "../../assets/svg/user.svg?raw";
import SHORTCUT from "../../assets/svg/shortcut.svg?raw";
import ABOUT from "../../assets/svg/about.svg?raw";
import ADVANCED_SVG from "../../assets/svg/advanced.svg?raw";
import GRID_SVG from "../../assets/svg/grid.svg?raw";
// A filled icon, like every tab: the tab sheet (style.css) fills the icons and
// drops strokes, which left the stroked sun this tab had as a bare dot.
import CUSTOMIZE_SVG from "../../assets/svg/palette.svg?raw";
import type { ConfigKey } from "../../core/config.ts";
import { msg } from "../../core/i18n/i18n.ts";
import { LOGTIME_SETTINGS } from "./settings/logtime.ts";
import { CLUSTERS_SETTINGS } from "./settings/clusters.ts";
import { PROFILE_SETTINGS } from "./settings/profile.ts";
import { SHORTCUTS_SETTINGS } from "./settings/shortcuts.ts";
import { EXTRAS_SETTINGS } from "./settings/extras.ts";
import { CALENDAR_SETTINGS } from "./settings/calendar.ts";
import { ABOUT_SETTINGS } from "./settings/about.ts";
import { CUSTOMIZE_SETTINGS } from "./settings/customize.ts";
import { ADVANCED_SETTINGS } from "./settings/advanced.ts";

// Repository links come from package.json "repository" (see scripts/repo-info.js)
export const HUB_INFO = {
  name: "Cuter Intra",
  version: __APP_VERSION__,
  author: __REPO_URL__.replace(/\/[^/]+$/, ""),
  github: __REPO_URL__,
  issues: `${__REPO_URL__}/issues`,
  privacy: `${__REPO_URL__}/blob/main/PRIVACY.md`,
  upstream: "https://github.com/nicopasla/better-intra",
  upstreamAuthor: "nicopasla",
  license: "MIT",
} as const;

/**
 * The tabs. `name` and `desc` are marked with msg() (this runs before the
 * language is known) and translated with t() where they are shown.
 * `toggleable` is the one place that says whether a feature has an on/off
 * switch: the tab header draws it, ACTIVE_SCRIPTS falls back to those ids,
 * and main.ts has an initializer for exactly those features (a tab that is
 * not toggleable is always on and needs none).
 */
export const FEATURE_DEFS = [
  {
    id: "profile",
    name: msg("Profile"),
    icon: USER,
    desc: msg("Improves readability; custom avatar, banner and background images once signed in."),
    cols: 2,
    toggleable: true,
  },
  {
    id: "extras",
    name: msg("Extras"),
    icon: GRID_SVG,
    desc: msg("Enable or disable optional add-ons. More can be added later."),
    cols: 3,
    toggleable: false,
  },
  {
    id: "clusters",
    name: msg("Clusters"),
    icon: CLUSTERS,
    desc: msg("Cluster map dialog, default cluster picker and profiles opening in a new tab; chair direction markers where the campus provides them."),
    cols: 2,
    toggleable: true,
  },
  {
    id: "logtime",
    name: msg("Logtime"),
    icon: CLOCK,
    desc: msg("Redesign the logtime to show weekly and total hours."),
    cols: 3,
    toggleable: true,
  },
  {
    id: "shortcuts",
    name: msg("Shortcuts"),
    icon: SHORTCUT,
    desc: msg("Manage custom navigation links."),
    cols: 3,
    toggleable: true,
  },
  {
    id: "calendar",
    name: msg("Calendar"),
    icon: CALENDAR,
    desc: msg("Subscribe to your 42 events in Google Calendar, Apple Calendar, or any calendar app."),
    toggleable: false,
  },
  {
    id: "customize",
    name: msg("Customize"),
    icon: CUSTOMIZE_SVG,
    desc: msg("Accent colour, fonts, size, corners and your own CSS on every Intra page."),
    cols: 2,
    toggleable: false,
  },
  {
    id: "advanced",
    name: msg("Advanced"),
    icon: ADVANCED_SVG,
    desc: msg("General behavior settings."),
    cols: 2,
    toggleable: false,
  },
  {
    id: "about",
    name: msg("About"),
    icon: ABOUT,
    desc: msg("Information about Cuter Intra and its technical stack."),
    toggleable: false,
  },
] as const;

export type FeatureId = (typeof FEATURE_DEFS)[number]["id"];
export const FEATURE_IDS = new Set<FeatureId>(FEATURE_DEFS.map((f) => f.id));
/** The features with an on/off switch, in tab order. */
export const TOGGLEABLE_FEATURE_IDS: readonly FeatureId[] = FEATURE_DEFS.filter(
  (f) => f.toggleable,
).map((f) => f.id);

export const STORAGE_KEY = "ACTIVE_SCRIPTS";

export type SettingKind =
  | "toggle"
  | "number"
  | "text"
  | "textarea"
  | "custom-presets"
  | "custom-cards"
  | "url"
  | "select"
  | "color"
  | "radio-group"
  | "divider"
  | "shortcuts"
  | "emoji"
  | "about"
  | "card-order"
  | "action"
  | "calendar-panel"
  | "theme-preset"
  | "rainbow-palette"
  | "campus-info"
  | "feature-cards";

export { INTRA_FONT } from "../logtime/constants.ts";

export type FeatureCardOption = {
  label?: string;
  value?: string;
  color?: string;
  /** Theme swatches: the page background under the accent `color`. */
  bg?: string;
  /** Theme swatches: the mode the theme puts the page in. */
  mode?: "dark" | "light";
  desc?: string;
  divider?: boolean;
  dependsOn?: ConfigKey;
  requiresCloud?: boolean;
  big?: boolean;
  subToggle?: {
    label: string;
    value: string;
    desc?: string;
    requiresCloud?: boolean;
    dependsOn?: ConfigKey;
  };
};

export type HubSettingDef = {
  feature: FeatureId;
  label: string;
  key?: ConfigKey;
  desc?: string;
  kind: SettingKind;
  nullable?: boolean;
  defaultValue?: unknown;
  options?: readonly FeatureCardOption[];
  /**
   * false: the option labels are names (themes, palettes, languages) and are
   * shown as written in every language. Otherwise the hub translates them.
   */
  translateOptions?: false;
  grid?: boolean;
  colSpan?: number;
  fullWidth?: boolean;
  dependsOn?: ConfigKey;
  /**
   * Select parents only: the exact values of `dependsOn` that make this
   * setting useful. Without it every value but "", "none" and "default"
   * counts as on, which shows colour pickers for styles that ignore them.
   */
  dependsOnValues?: readonly string[];
  /** Public-profile link field: validated live with this link kind. */
  linkKind?: "github" | "gitlab" | "linkedin" | "website" | "discord";
  requiresCloud?: boolean;
  /** Drawn only when the campus file declares chair positions (Clusters). */
  requiresChairMarkers?: boolean;
  /**
   * The page applies the setting as soon as it is stored (a storage.onChanged
   * listener consumes the key). Everything else takes effect after a reload,
   * and the hub says so next to the setting. isLiveKey() also knows the keys
   * of the tab modules that do not set this.
   */
  live?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** "text" and "emoji": longest value the input accepts (UTF-16 units). */
  maxLength?: number;
  placeholder?: string;
  actionLabel?: string;
  actionType?:
    | "export"
    | "import"
    | "reset"
    | "backup"
    | "reload-campus"
    | "open-visuals-editor"
    | "cloud-sessions"
    | "cloud-export";
};

/** Every setting of every tab, in the order the tab draws them. */
export const HUB_SETTING_DEFS: Record<FeatureId, readonly HubSettingDef[]> = {
  logtime: LOGTIME_SETTINGS,
  clusters: CLUSTERS_SETTINGS,
  profile: PROFILE_SETTINGS,
  shortcuts: SHORTCUTS_SETTINGS,
  extras: EXTRAS_SETTINGS,
  calendar: CALENDAR_SETTINGS,
  about: ABOUT_SETTINGS,
  customize: CUSTOMIZE_SETTINGS,
  advanced: ADVANCED_SETTINGS,
};

/**
 * Keys a storage.onChanged listener applies without a page reload, for the
 * defs that do not carry `live` themselves: the theme (theme-manager.ts,
 * shared-styles.ts), the profile extras (extras-apply.ts), the performance
 * flags (perf.ts), the campus (campus.ts), the Logtime widget (logtime.ts,
 * LOGTIME_LIVE_KEYS). tests/hub-live-keys.test.ts checks
 * the list against the listeners.
 */
export const LIVE_KEYS: ReadonlySet<string> = new Set<string>([
  "BETTER_INTRA_THEME",
  "PROFILE_THEME_PRESET",
  "DISABLE_ANIMATIONS",
  "PROFILE_SHOW_OTHERS_EXTRAS",
  "CUSTOM_SHOW_OTHERS_LOOK",
  "CLUSTERS_CAMPUS",
  "PERF_DEFER_OFFSCREEN",
  "PERF_PAUSE_HIDDEN",
  "PERF_PRECONNECT",
  "LOGTIME_GOAL_HOURS",
  "LOGTIME_SHOW_AVERAGE",
  "LOGTIME_SHOW_GOAL",
  "LOGTIME_SHOW_RECORDS",
  "LOGTIME_SHOW_TACOS",
  "LOGTIME_EMOJI",
  "LOGTIME_EMOJI_DIVISOR",
  "LOGTIME_EMOJI_RATE",
  "LOGTIME_SHOW_DAYS_MODE",
  "LOGTIME_CALENDAR_COLOR",
  "LOGTIME_LABELS_COLOR",
  "LOGTIME_RAINBOW_PALETTE",
  "LOGTIME_MAX_EARNINGS",
]);

/** Prefixes of key families whose listener watches the whole family. */
const LIVE_PREFIXES = ["CUSTOM_", "PROFILE_PUB_"];

const liveDefKeys = new Set<string>();
for (const defs of Object.values(HUB_SETTING_DEFS)) {
  for (const def of defs) if (def.live && def.key) liveDefKeys.add(def.key);
}

/** Whether a change to `key` shows on the page without a reload. */
export function isLiveKey(key: string): boolean {
  return (
    liveDefKeys.has(key) ||
    LIVE_KEYS.has(key) ||
    LIVE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * What the settings search compares: lower case, accents removed, one space
 * between words, so "Couleur d'accent" matches "couleur d accent".
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
