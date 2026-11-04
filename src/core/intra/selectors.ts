export const AVATAR_SELECTOR = "div.rounded-full.w-52.h-52";
/**
 * Not a selector: the fragment the hub's Edit (avatar, banner and background)
 * adds to my profile's URL from another page, so that visuals.ts opens the
 * editor once my avatar is its button.
 */
export const EDIT_VISUALS_HASH = "#ft-edit-visuals";
export const BANNER_SELECTOR = "div.border-neutral-600.bg-ft-gray\\/50";
export const BACKGROUND_SELECTOR =
  ".w-full.xl\\:h-72.bg-center.bg-cover.bg-ft-black";
export const TITLE_BADGE_SELECTOR =
  '[class*="text-primary-foreground"][class*="inline-flex"]';
/** The login line of the v3 profile card; every profile feature hangs off it. */
export const PROFILE_CARD_SELECTOR = 'p[class="text-sm"]';
/**
 * A native dashboard card (PROJECTS, MARKS, LAST ACHIEVEMENTS, ...). Intra
 * addresses them by utility classes only, so this is the one place to update
 * when a deploy renames them.
 */
export const DASHBOARD_CARD_SELECTOR = ".bg-white.md\\:h-96";
/** The heading inside a dashboard card; its text is the card's identity. */
export const CARD_TITLE_SELECTOR = "[class*='uppercase']";
/**
 * The v3 shell's sidebar column: the 42 tile and the burger menu, 80 px wide
 * and fixed at the left edge (a direct child of `.App` in the shell bundle,
 * `fixed top-0 flex flex-col items-center w-20 z-50`). See shell-fix.ts.
 */
export const INTRA_SIDEBAR_COLUMN_SELECTOR = ".App > div.fixed.top-0.w-20";

export interface FindDashboardCardOptions {
  /**
   * Match a heading that starts with the title instead of equalling it: the
   * MARKS heading of another student's profile carries a count after it.
   */
  prefix?: boolean;
  root?: ParentNode;
}

/** The heading text a dashboard card is matched on. */
export function dashboardCardTitle(card: Element): string {
  return (
    card.querySelector(CARD_TITLE_SELECTOR)?.textContent?.trim().toUpperCase() ??
    ""
  );
}

/**
 * The dashboard card whose heading is `title` (compared trimmed, in upper
 * case), or null. The one matching rule for every card module.
 */
export function findDashboardCard(
  title: string,
  options: FindDashboardCardOptions = {},
): HTMLElement | null {
  const { prefix = false, root = document } = options;
  const wanted = title.trim().toUpperCase();
  for (const card of root.querySelectorAll<HTMLElement>(
    DASHBOARD_CARD_SELECTOR,
  )) {
    const heading = dashboardCardTitle(card);
    if (prefix ? heading.startsWith(wanted) : heading === wanted) return card;
  }
  return null;
}

export interface WaitForDashboardCardOptions extends FindDashboardCardOptions {
  /** Animation frames to keep looking before giving up (default 100). */
  maxFrames?: number;
  /**
   * The card only counts once this passes (its rows have rendered, say).
   * Without it the card is returned as soon as it exists.
   */
  ready?: (card: HTMLElement) => boolean;
  /**
   * After this many frames a card that exists is returned even when `ready`
   * still fails, so a card that legitimately stays empty is not lost.
   */
  readyGraceFrames?: number;
}

/**
 * Resolve with the dashboard card titled `title` once it is in the DOM (and
 * `ready`, when given), or null when the frame budget runs out. Intra renders
 * the dashboard in bursts, so the wait is bounded by frames like the paint
 * it is waiting for, and every card module shares this one deadline shape.
 */
export async function waitForDashboardCard(
  title: string,
  options: WaitForDashboardCardOptions = {},
): Promise<HTMLElement | null> {
  const { maxFrames = 100, ready, readyGraceFrames, ...find } = options;
  for (let frame = 0; frame < maxFrames; frame++) {
    const card = findDashboardCard(title, find);
    if (card) {
      if (!ready || ready(card)) return card;
      if (readyGraceFrames !== undefined && frame >= readyGraceFrames)
        return card;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return null;
}

/**
 * How long the profile pass keeps looking for its anchor before it stops
 * (profile.ts): the dashboard renders in several bursts, other profiles in one.
 */
export const PROFILE_PASS_DEADLINE_MS = (pathname: string) =>
  pathname !== "/" ? 10000 : 30000;

/**
 * Diagnostic for a load-bearing selector that matched nothing by the time its
 * watcher gave up. These selectors are Tailwind utility classes from the Intra
 * front-end: when a deploy renames one, the page looks exactly as if the
 * extension were off, and a bug report carries nothing to go on. One warning
 * per page, naming the selector, and nothing else changes.
 */
let missingSelectorReported = false;

/** Only a rendered v3 profile route is expected to hold the anchors. */
function expectsProfileAnchors(): boolean {
  if (location.hostname !== "profile-v3.intra.42.fr") return false;
  if (!(location.pathname === "/" || /^\/users\/[^/]+\/?$/.test(location.pathname)))
    return false;
  // a blank shell (still loading, or an error page) has nothing to find yet
  const root = document.getElementById("root");
  return !!root && root.children.length > 0;
}

export function reportMissingSelector(
  name: string,
  selector: string,
  afterMs: number,
): void {
  if (missingSelectorReported || !expectsProfileAnchors()) return;
  if (document.querySelector(selector)) return;
  missingSelectorReported = true;
  console.warn(
    `Cuter Intra ${__APP_VERSION__}: ${name} (${selector}) not found on this page after ${Math.round(afterMs / 1000)}s. ` +
      "If the page looks normal, the Intra layout may have changed: please report this line.",
  );
}

const armedProbes = new Set<string>();

/**
 * Check `selector` once the watcher that depends on it has given up, and warn
 * through reportMissingSelector when it still matches nothing. One timer per
 * selector per page, armed the first time the finder comes back empty.
 */
export function probeSelectorAt(
  name: string,
  selector: string,
  afterMs: number,
): void {
  if (armedProbes.has(selector)) return;
  armedProbes.add(selector);
  setTimeout(() => reportMissingSelector(name, selector, afterMs), afterMs);
}

/** Test hook: forget the warnings and probes of the current page. */
export function resetSelectorProbes(): void {
  missingSelectorReported = false;
  armedProbes.clear();
}
