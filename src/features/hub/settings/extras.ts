/**
 * Extras tab of the settings hub: optional add-ons, each one a feature card
 * with its switch and, for some, a sub-switch.
 */
import type { HubSettingDef } from "../hubSettings.data.ts";
import { AUTH_MODE } from "../../../core/worker.ts";

/**
 * The roulette card reads its numbers from the worker in oauth mode, but in
 * intra mode from the Intra v2 pages with the student's own cookies
 * (profile-stats-intra.ts): there it runs signed out, so the hub must not
 * lock its switches.
 */
const ROULETTE_NEEDS_CLOUD = AUTH_MODE !== "intra";

export const EXTRAS_SETTINGS: readonly HubSettingDef[] = [
  {
    feature: "extras",
    label: "",
    kind: "feature-cards",
    fullWidth: true,
    options: [
      {
        label: "Subject tracker",
        value: "SUBJECT_TRACKER_ENABLED",
        color: "warning",
        big: true,
        desc: "Shows a badge on project pages when a subject has been updated, using update data shared by the community.",
        subToggle: {
          label: "Share with the community",
          value: "SUBJECT_TRACKER_SEND_DATA",
          requiresCloud: true,
          desc: "Send subject links so everyone sees when subjects are updated - and you benefit from updates others have spotted.",
        },
      },
      {
        label: "Friends widget",
        value: "SHOW_FRIENDS_WIDGET",
        color: "success",
        big: true,
        desc: "Adds the friends button and widget to your profile page.",
        subToggle: {
          label: "Show custom avatars in friends",
          value: "SHOW_CUSTOM_AVATARS_IN_FRIENDS",
          desc: "When available, displays friends custom profile pictures instead of 42 avatars.",
          dependsOn: "SHOW_FRIENDS_WIDGET",
        },
      },
      {
        label: "Pending evaluations",
        value: "PROFILE_SHOW_EVALUATIONS",
        color: "primary",
        big: true,
        desc: "Organizes the pending evaluations card into Evaluator and Evaluated sections.",
      },
      {
        label: "Campus card",
        value: "PROFILE_SHOW_CAMPUS",
        color: "success",
        big: true,
        desc: "Adds a card to your dashboard with your next exam and, when signed in, your coalition standings and correction points over time.",
      },
      {
        label: "Thursday Roulette",
        value: "PROFILE_SHOW_ROULETTE",
        color: "info",
        big: true,
        desc: "Adds a card with roulette wins, points, and next draw countdown.",
        requiresCloud: ROULETTE_NEEDS_CLOUD,
        subToggle: {
          label: "Show roulette history",
          value: "PROFILE_SHOW_ROULETTE_HISTORY",
          desc: "Displays the full timeline of past roulette wins inside the card.",
          dependsOn: "PROFILE_SHOW_ROULETTE",
          requiresCloud: ROULETTE_NEEDS_CLOUD,
        },
      },
    ],
  },
];
