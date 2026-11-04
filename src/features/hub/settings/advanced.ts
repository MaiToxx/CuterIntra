/**
 * Advanced tab of the settings hub: general behaviour, backup and campus
 * maintenance, the cloud account (signed-in browsers, Download my cloud
 * data), the "Lighten the Intra" switches, and Reset.
 */
import { CONFIG_DEFAULT } from "../../../core/config.ts";
import { msg } from "../../../core/i18n/i18n.ts";
import type { HubSettingDef } from "../hubSettings.data.ts";

export const ADVANCED_SETTINGS: readonly HubSettingDef[] = [
  {
    feature: "advanced",
    key: "UI_LANGUAGE",
    label: "Language",
    desc: "The language of Cuter Intra. Auto follows your browser.",
    kind: "radio-group",
    defaultValue: CONFIG_DEFAULT.UI_LANGUAGE,
    // The two languages are written in their own language, whatever the
    // current one (tests/i18n-catalog.test.ts leaves them untranslated;
    // t() gives them back as written, having no entry for them).
    options: [
      { label: "Auto", value: "auto" },
      { label: "Français", value: "fr" },
      { label: "English", value: "en" },
    ],
    grid: false,
  },
  {
    feature: "advanced",
    key: "ADVANCED_OPEN_LINKS_NEW_TAB",
    label: "Open links in new tab",
    desc: "Your shortcuts and the links of the profile card open in a new tab instead of the current one.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.ADVANCED_OPEN_LINKS_NEW_TAB,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    key: "EASTER_EGGS_ENABLED",
    label: "Easter eggs",
    desc: "Nine small secrets are hidden in the Intra. The About tab counts the ones you found.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.EASTER_EGGS_ENABLED,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    key: "DISABLE_ANIMATIONS",
    label: "Disable animations",
    desc: "Removes transition effects across all Cuter Intra features.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.DISABLE_ANIMATIONS,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    label: "Auto-detected campus",
    desc: "Your campus, detected automatically via the 42 API.",
    kind: "campus-info",
    fullWidth: false,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    label: "Backup & Restore",
    desc: "Export or import your Cuter Intra settings as a JSON file.",
    kind: "action",
    actionType: "backup",
    // the button labels are shown through t() (controls/actions.ts)
    actionLabel: msg("Backup"),
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    label: "Reload campus config",
    desc: "Clears the cached campus/cluster configuration and re-fetches it.",
    kind: "action",
    actionType: "reload-campus",
    actionLabel: msg("Reload"),
    grid: true,
    colSpan: 1,
  },
  // What the Cuter Intra server keeps about the student, and the browsers
  // signed in to the account (controls/cloud-account.ts).
  { feature: "advanced", label: "Cloud account", kind: "divider" },
  {
    feature: "advanced",
    label: "Signed-in browsers",
    desc: "Sign out the browsers you no longer use, such as a campus computer.",
    kind: "action",
    actionType: "cloud-sessions",
    fullWidth: true,
    grid: true,
    colSpan: 2,
  },
  {
    feature: "advanced",
    label: "Download my cloud data",
    desc: "Everything the Cuter Intra server keeps about you, as a JSON file.",
    kind: "action",
    actionType: "cloud-export",
    grid: true,
    colSpan: 1,
  },
  { feature: "advanced", label: "Lighten the Intra", kind: "divider" },
  {
    feature: "advanced",
    key: "PERF_DEFER_OFFSCREEN",
    label: "Skip off-screen blocks",
    desc: "The browser stops laying out and painting the project rows, achievement tiles and logtime months you have scrolled past. Long lists get much smoother. Costs: a block is drawn the moment it reaches the screen, so a very fast scroll can flash blank for a frame.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PERF_DEFER_OFFSCREEN,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    key: "PERF_PAUSE_HIDDEN",
    label: "Pause when tab is hidden",
    desc: "While this tab is in the background, the Intra's animations and transitions are paused, so it stops using your CPU and battery. Costs: nothing visible - everything resumes the instant you come back.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PERF_PAUSE_HIDDEN,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "advanced",
    key: "PERF_PRECONNECT",
    label: "Warm up the avatar CDN",
    desc: "Opens the connection to cdn.intra.42.fr as the page starts, so the first avatar does not wait for DNS and the TLS handshake. Costs: three empty <link> tags and one early connection.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PERF_PRECONNECT,
    grid: true,
    colSpan: 1,
  },

  { feature: "advanced", label: "Reset", kind: "divider" },
  {
    feature: "advanced",
    label: "Reset all data",
    desc: "Clears every Cuter Intra setting on this browser and signs you out. This cannot be undone.",
    kind: "action",
    actionType: "reset",
    actionLabel: msg("Reset"),
  },
];
