/**
 * Profile tab of the settings hub: the visuals editor's button, theme
 * accent, dashboard card order, the cards the profile page shows, then the
 * public profile section, which has a contract of its own and lives in
 * profile-public.ts.
 */
import { CONFIG_DEFAULT } from "../../../core/config.ts";
import type { HubSettingDef } from "../hubSettings.data.ts";
import { PUBLIC_PROFILE_SETTINGS } from "./profile-public.ts";
import { THEME_OPTIONS } from "./theme-options.ts";

export const PROFILE_SETTINGS: readonly HubSettingDef[] = [
  {
    feature: "profile",
    label: "Appearance",
    kind: "divider",
  },
  {
    // The editor used to open only from a click on my own avatar, which
    // nothing in the hub mentioned. The desc keeps "click your avatar" for
    // the settings search.
    feature: "profile",
    label: "Edit avatar, banner and background",
    desc: "Custom images and colours for your profile, which other Cuter Intra users see too. Needs the cloud account. Shortcut: click your avatar on your own profile page.",
    kind: "action",
    actionType: "open-visuals-editor",
  },
  {
    feature: "profile",
    key: "PROFILE_THEME_PRESET",
    label: "Theme",
    desc: "Colours of the whole intranet: backgrounds, cards, text and accent. Visitors of your profile see it too, unless you turn off \"Publish my look\" (Customize tab).",
    kind: "theme-preset",
    fullWidth: true,
    defaultValue: CONFIG_DEFAULT.PROFILE_THEME_PRESET,
    options: THEME_OPTIONS,
  },
  {
    feature: "profile",
    key: "PROFILE_CARD_ORDER",
    label: "Dashboard Cards Order",
    desc: "Drag and drop the colored cards to prioritize your dashboard sections.",
    kind: "card-order",
    fullWidth: true,
    defaultValue: CONFIG_DEFAULT.PROFILE_CARD_ORDER,
  },
  {
    feature: "profile",
    key: "PROFILE_USE_CUSTOM_COLOR",
    label: "Use custom color on card",
    desc: "Applies the logtime calendar color to the profile card.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_USE_CUSTOM_COLOR,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "profile",
    key: "PROFILE_USE_MODERN_INFO_CARD",
    label: "Modern info card",
    desc: "Replace the native stats bar with sleek info badges.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_USE_MODERN_INFO_CARD,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "profile",
    label: "Achievements",
    kind: "divider",
  },
  {
    feature: "profile",
    key: "PROFILE_SHOW_ACHIEVEMENTS",
    label: "Show all achievements",
    desc: "Replaces the native achievements card with a scrollable list of all achievements.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_SHOW_ACHIEVEMENTS,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "profile",
    label: "Projects",
    kind: "divider",
  },
  {
    feature: "profile",
    key: "PROFILE_SHOW_MARKS",
    label: "Show past marks",
    desc: "Adds a list of completed project marks in the Projects card.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_SHOW_MARKS,
    grid: true,
    colSpan: 1,
    // No requiresCloud: the list is read from intrapy with the page's own
    // Intra token and login (marks.ts), so it runs signed out too, and a
    // signed-out student must be able to turn it off.
  },
  {
    feature: "profile",
    key: "PROFILE_MARKS_SORT_ORDER",
    label: "Marks sort order",
    desc: "Sort completed projects by date.",
    kind: "select",
    defaultValue: CONFIG_DEFAULT.PROFILE_MARKS_SORT_ORDER,
    options: [
      { label: "Newest first", value: "newest_first" },
      { label: "Oldest first", value: "oldest_first" },
    ],
    grid: true,
    colSpan: 1,
    dependsOn: "PROFILE_SHOW_MARKS",
  },
  {
    feature: "profile",
    key: "PROFILE_PROJECTS_SORT",
    label: "Projects sort",
    desc: "Adds a sort dropdown to the Marks list on user profiles.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_PROJECTS_SORT,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "profile",
    key: "PROFILE_MARKS_SHOW_REAL_DATE",
    label: "Enhance marks display",
    desc: `Replaces relative dates with absolute dates (e.g. "19/06/26 11:13") on other users' profiles.`,
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.PROFILE_MARKS_SHOW_REAL_DATE,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "profile",
    label: "Events",
    kind: "divider",
  },
  {
    feature: "profile",
    key: "PROFILE_EVENT_TYPE_FILTER",
    label: "Event visibility",
    desc: "Choose which types of events you want to see.",
    kind: "radio-group",
    defaultValue: CONFIG_DEFAULT.PROFILE_EVENT_TYPE_FILTER,
    // The event types come from the Intra when the hub opens; without them
    // (offline, a failed read) the control used to show no button at all.
    options: [{ label: "Show All", value: "all" }],
  },

  // Last on purpose: the public section closes the tab, behind its divider
  // (tests/hub-public-profile.test.ts).
  ...PUBLIC_PROFILE_SETTINGS,
];
