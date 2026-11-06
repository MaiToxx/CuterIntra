import { updateEventFilters, injectEventsSelect } from "./cards/events/events.ts";
import { findSlotsButton, redirectDefenseLinks } from "./shortcuts.ts";
import { replaceMoulinetteImage } from "./moulinette.ts";
import { injectCustomStyles, updateVisuals } from "./header/visuals.ts";
import { handleProfileRedirect } from "./layout/highlight.ts";
import { initLayoutManager } from "./layout/layout.ts";
import { initMilestones } from "./cards/milestones.ts";
import { initFreezeCard } from "./cards/freeze.ts";
import { findProfileCard, initProfileCardStyling } from "./header/profile-card.ts";
import { injectFriendsWidget } from "../friends/friends.ui.ts";
import { colorTrackerBadge } from "../logtime/tracker-card.ts";
import { initAchievements } from "./cards/achievements.ts";
import { initMarks } from "./cards/marks.ts";
import { initProjectBadges } from "./cards/project-badges.ts";
import { initProjectsSort } from "./cards/projects-sort.ts";
import { initRouletteStats } from "./cards/roulette-stats.ts";
import { initEvaluations } from "./cards/evaluations.ts";
import { initBadges, applyTitleBadgeWrap } from "./header/badges.ts";
import { initTranscript } from "./cards/transcript.ts";
import { initPace } from "./cards/pace.ts";
import { initCampusCard } from "./cards/campus.ts";
import { ensureCampusData } from "../clusters/clusters.data.ts";
import { tagDashboardCards } from "../customize/cards.ts";
import { waitForElement } from "../../core/dom/dom-wait.ts";
import { isOwnId } from "../../core/lifecycle/own-ids.ts";
import { holdAvatar, releaseAvatar } from "./header/visuals-apply.ts";

/**
 * Overlays that come and go on their own (tooltip, dialogs, toasts). Their
 * removal never means a feature has to re-mount, so it must not cost a pass.
 */
const OWN_EPHEMERAL_IDS = new Set([
  "ft-floating-tooltip",
  "ft-confirm-dialog",
  "ft-egg-toast",
  "ft-visitor-look-badge",
  "profile-modal-host",
]);

/** How far up the tree we look for one of our hosts, to bound the work per record. */
const MAX_ANCESTOR_DEPTH = 24;
/** Above this many records a burst is certainly a real React render. */
const MAX_RECORDS_INSPECTED = 64;

/** Our own node, by id (the list is shared with the stale-instance cleanup). */
const isOwnElement = (el: Element): boolean => isOwnId(el.id);

const isOwnNode = (node: Node): boolean => {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  for (let depth = 0; el && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (isOwnElement(el)) return true;
    el = el.parentElement;
  }
  return false;
};

const isEphemeralOwnNode = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE &&
  OWN_EPHEMERAL_IDS.has((node as Element).id);

const every = (nodes: NodeList, fn: (n: Node) => boolean): boolean => {
  for (const node of nodes) {
    if (!fn(node)) return false;
  }
  return true;
};

/**
 * True when a record can only be our own doing.
 *
 * WHY: the pass below re-runs ~20 feature inits, and several of them read
 * chrome.storage before they can decide to do nothing. Our own injections (and
 * a hovered tooltip, which is appended to <body> and removed again) used to
 * re-trigger that whole pass, so simply moving the mouse over the dashboard
 * cost a dozen storage round-trips. The Intra DOM did not change, so no init
 * can behave differently: skip it.
 */
const isSelfInflicted = (record: MutationRecord): boolean => {
  // A change inside one of our own widgets (lit-html re-render, shadow host).
  if (isOwnNode(record.target)) return true;
  // We just injected something into an Intra container.
  if (
    record.removedNodes.length === 0 &&
    record.addedNodes.length > 0 &&
    every(record.addedNodes, isOwnNode)
  ) {
    return true;
  }
  // One of our overlays closed.
  if (
    record.addedNodes.length === 0 &&
    record.removedNodes.length > 0 &&
    every(record.removedNodes, isEphemeralOwnNode)
  ) {
    return true;
  }
  return false;
};

/** Does this burst contain at least one change made by the Intra page itself? */
export const hasIntraMutation = (records: MutationRecord[]): boolean => {
  if (records.length > MAX_RECORDS_INSPECTED) return true;
  for (const record of records) {
    if (!isSelfInflicted(record)) return true;
  }
  return false;
};

/**
 * Resolve once <body> exists. Observer-based: the previous 10 ms poll woke a
 * timer up to a hundred times on a slow first paint.
 */
const waitForBody = async (): Promise<void> => {
  if (document.body) return;
  await waitForElement("body", { timeoutMs: 10000 });
};

export async function initProfile() {
  injectCustomStyles();
  // Only this watcher paints the custom avatar, so the avatar is hidden only
  // while it runs (see holdAvatar): a page-wide rule that outlived it left
  // every avatar React mounted later invisible for the rest of the visit.
  // Held from here, as early as the old rule, so that the Intra picture never
  // flashes before the custom one on load.
  const watchesProfile = location.origin === "https://profile-v3.intra.42.fr";
  if (watchesProfile) holdAvatar();
  await waitForBody();
  if (!document.body) {
    releaseAvatar();
    return;
  }
  if (location.origin === "https://projects.intra.42.fr") {
    await redirectDefenseLinks();
    replaceMoulinetteImage();
  }
  if (!watchesProfile) return;

  void ensureCampusData();

  let isUpdating = false;
  let needsRerun = false;
  // On /users/* the observer is disconnected after a pass, but only once the
  // profile card has actually been found: a first pass on a still-loading
  // page used to disconnect immediately and no feature ever initialised.
  let initialised = false;

  // Mutations arrive in bursts while the React page renders; one pass per
  // burst (trailing 80ms) instead of one per animation frame.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const scheduleUpdate = (immediate = false) => {
    needsRerun = false;
    if (pending !== null) return;
    pending = setTimeout(
      () => {
        pending = null;
        requestAnimationFrame(() => updateUI());
      },
      immediate ? 0 : 80,
    );
  };

  const updateUI = async () => {
    if (isUpdating) return;
    isUpdating = true;
    try {
      await updateVisuals();
      if (location.pathname === "/" || location.pathname.startsWith("/users")) {
        tagDashboardCards();
        if (!findProfileCard()) return;
        initialised = true;

        await Promise.allSettled([
          initLayoutManager(),
          initProfileCardStyling(),
          initAchievements(),
          initMarks(),
          initProjectBadges(),
          initProjectsSort(),
          initRouletteStats(),
          initEvaluations(),
          findSlotsButton(),
          injectEventsSelect(),
          updateEventFilters(),
          handleProfileRedirect(),
          initMilestones(),
          initBadges(),
          applyTitleBadgeWrap(),
          initTranscript(),
          initPace(),
        ]);
        // Fire-and-forget: features with >2s timeouts or slow network fetches
        // Fire-and-forget, but never unhandled: with the worker unreachable
        // (offline, or down) the friends widget's campus lookup rejects.
        void initFreezeCard().catch((e) => console.warn("Cuter Intra: freeze card", e));
        void initCampusCard().catch((e) => console.warn("Cuter Intra: campus card", e));
        void injectFriendsWidget().catch((e) => console.warn("Cuter Intra: friends widget", e));
        if (location.pathname === "/") colorTrackerBadge();
      }
    } finally {
      isUpdating = false;
      if (needsRerun) {
        scheduleUpdate();
      } else if (initialised && location.pathname.startsWith("/users")) {
        observer.disconnect();
        // No pass will run again to reveal a re-mounted avatar.
        releaseAvatar();
      }
    }
  };

  const observer = new MutationObserver((records) => {
    // Bursts that only contain our own DOM writes cannot change what any init
    // would do: skipping them removes the feedback loop where a pass scheduled
    // the next pass (see hasIntraMutation).
    if (!hasIntraMutation(records)) return;
    if (isUpdating) {
      needsRerun = true;
    } else {
      scheduleUpdate();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  scheduleUpdate(true);

  const stop = () => {
    observer.disconnect();
    releaseAvatar();
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  };
  setTimeout(stop, location.pathname !== "/" ? 10000 : 30000);
  // Leave nothing running behind a bfcached page, whatever the path.
  window.addEventListener("pagehide", stop, { once: true });
}
