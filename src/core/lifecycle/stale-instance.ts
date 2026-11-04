/**
 * Clears what an earlier instance of Cuter Intra left in this tab, before
 * this instance mounts anything.
 *
 * WHY: when Firefox applies an add-on update (it checks about once a day and
 * installs at once) or the add-on is re-enabled, it tears the old content
 * script down and injects the new content.js into the Intra tabs that are
 * already open. The old script's DOM stays on the page, its listeners dead.
 * Our features guard their mounts by id or by a flag attribute, so the new
 * instance found the dead gear and Clusters button and skipped its own, and
 * the features guarded per instance (friends widget, theme links) mounted a
 * second copy. With the leftovers gone, every feature mounts fresh, working
 * nodes through its normal init.
 *
 * main.ts imports this module first and the work runs at import time: module
 * bodies run in import order, so no other module's top-level code, and none
 * of main.ts's start-up code, can have added a node before it.
 *
 * Chrome never injects into open tabs on update (the orphaned script keeps
 * running there, see hubSettings.ts), so this finds nothing to do on Chrome.
 */
import { OWN_ID_PREFIXES } from "./own-ids.ts";

/** Put on <html> by every instance, so that the next one knows it is not the first. */
export const INSTANCE_ATTR = "data-better-intra";

/**
 * Proof that an instance ran here, for the builds that did not set
 * INSTANCE_ATTR yet (1.11.1 and older): nodes we add on every Intra page, one
 * kind per host (sidebar gear and theme link on profile-v3, cluster picker on
 * meta, the v2 banner, the customize and perf sheets elsewhere).
 */
const EVIDENCE_SELECTOR = [
  "#hub-gear-btn",
  "#ft-clusters-btn",
  "#friends-widget-host",
  "#cluster-shadow-host",
  "#ft-v2-warning",
  "link[data-better-intra-theme]",
  '[id^="better-intra"]',
].join(",");

/**
 * Injected nodes the id prefixes miss: ids outside the list, and controls we
 * add to the Intra's own containers with a flag attribute instead of an id.
 * Their features re-create each of them once it is gone.
 */
const EXTRA_OWN_SELECTORS = [
  "#cluster-map-dialog",
  "#cluster-shadow-host",
  // A theme link loses its id while disabled and the light-preset overrides
  // never have one: the dataset is what marks all of them.
  "link[data-better-intra-theme]",
  "[data-ft-friend]",
  "[data-ft-transcript]",
  "[data-ft-give-points]",
];

/**
 * "Already bound" flags we set on the Intra's own nodes. What they stand for
 * (a listener, an animation loop) died with the old instance, and with the
 * flag still there the new one would never bind it again. Plain tags such as
 * data-ft-card stay: they bind nothing.
 */
const BOUND_FLAGS = [
  "data-ft-days-toggle", // pace.ts: the days/weeks toggle
  "data-ft-pace-listener", // pace.ts: the bar tooltips
  "data-modal-listener", // avatar-clicks.ts: opens the visuals editor
  "data-toggle-listener", // avatar-clicks.ts: the original avatar toggle
  "data-filter-injected", // events.ts: the event type filter
  "data-fire-animated", // milestones.ts: the rotating ring
  "data-ft-shortcuts", // personal-info.ts: its shortcut links replace the content
];

const OWN_NODES_SELECTOR = [
  ...OWN_ID_PREFIXES.map((prefix) => `[id^="${prefix}"]`),
  ...EXTRA_OWN_SELECTORS,
].join(",");

const BOUND_FLAGS_SELECTOR = BOUND_FLAGS.map((attr) => `[${attr}]`).join(",");

/**
 * True when another instance already ran in this page. content.js is
 * declared at document_start, so a page past "loading" means the browser
 * injected it into an open tab (install, update or re-enable); the evidence
 * is what tells an update from a first install, where there is nothing to
 * clear and a prefix match could only hit one of the Intra's own nodes.
 */
export function hasStaleInstance(doc: Document = document): boolean {
  if (doc.readyState === "loading") return false;
  return (
    !!doc.documentElement?.hasAttribute(INSTANCE_ATTR) ||
    !!doc.querySelector(EVIDENCE_SELECTOR)
  );
}

/** Remove the previous instance's nodes and flags; returns how many nodes went. */
export function removeStaleInstance(doc: Document = document): number {
  const nodes = doc.querySelectorAll(OWN_NODES_SELECTOR);
  for (const node of nodes) node.remove();
  for (const el of doc.querySelectorAll(BOUND_FLAGS_SELECTOR)) {
    for (const attr of BOUND_FLAGS) el.removeAttribute(attr);
  }
  return nodes.length;
}

/** Clear an earlier instance's leftovers if there are any, then mark the page. */
export function claimPage(doc: Document = document): void {
  try {
    if (hasStaleInstance(doc)) removeStaleInstance(doc);
  } catch (e) {
    // A leftover must never stop this instance from starting.
    console.warn("Cuter Intra: could not clear the previous instance", e);
  }
  doc.documentElement?.setAttribute(INSTANCE_ATTR, "");
}

claimPage();
