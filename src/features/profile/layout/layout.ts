import { getConfig } from "../../../core/config.ts";
import {
  DASHBOARD_CARD_SELECTOR,
  dashboardCardTitle,
} from "../../../core/intra/selectors.ts";

let cachedCards: HTMLElement[] | null = null;
let cachedGrid: HTMLElement | null = null;

// The card layout only applies to the user's own dashboard ("/").
// The previous regex /^\/(\??.*)?$/ matched every path, so the dashboard card
// order and hidden cards were also applied on other users' profiles.
const isDashboardPath = () => location.pathname === "/";

function getCards(): HTMLElement[] {
  if (!isDashboardPath()) {
    cachedCards = [];
    cachedGrid = null;
    return [];
  }

  const currentElements = document.querySelectorAll<HTMLElement>(
    `#logtime-shadow-wrapper, ${DASHBOARD_CARD_SELECTOR}, .lt-box-container`,
  );
  const validCards: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  const hasShadowHost =
    document.getElementById("logtime-shadow-wrapper") !== null;

  currentElements.forEach((el) => {
    if (seen.has(el)) return;

    const title = getCardTitle(el);
    const validTitles = [
      "LOGTIME",
      "AGENDA",
      "PENDING EVALUATIONS",
      "LAST ACHIEVEMENTS",
      "PROJECTS",
      "THURSDAY ROULETTE",
    ];

    if (validTitles.includes(title)) {
      if (
        title === "LOGTIME" &&
        el.id !== "logtime-shadow-wrapper" &&
        hasShadowHost
      )
        return;
      seen.add(el);
      validCards.push(el);
    }
  });

  if (
    !cachedCards ||
    cachedCards.length !== validCards.length ||
    cachedCards[0] !== validCards[0]
  ) {
    cachedCards = validCards;
    cachedGrid =
      document.querySelector(".dash-main") ||
      validCards[0]?.parentElement ||
      document.querySelector<HTMLElement>("main div[class*='grid']") ||
      null;
  }

  return cachedCards;
}

/**
 * The roulette card is ours (roulette-stats.ts) and its title is translated:
 * it is known by its id, under the English name the card order stores.
 */
const ROULETTE_CARD_ID = "ft-roulette-card";

function getCardTitle(card: HTMLElement): string {
  if (card.id === "logtime-shadow-wrapper") return "LOGTIME";
  if (card.id === ROULETTE_CARD_ID) return "THURSDAY ROULETTE";
  const heading = dashboardCardTitle(card);
  if (heading) return heading;

  const text = (card.textContent || "").toUpperCase();
  for (const token of [
    "LOGTIME",
    "AGENDA",
    "PENDING EVALUATIONS",
    "LAST ACHIEVEMENTS",
    "PROJECTS",
    "THURSDAY ROULETTE",
  ]) {
    if (text.includes(token)) return token;
  }
  return "";
}

function reorderCards(
  grid: HTMLElement,
  customOrder: string[],
  cards: HTMLElement[],
): boolean {
  if (!cards.length) return false;

  const normalizedOrder = customOrder.map((name) => {
    const clean = name.trim().toUpperCase();
    return clean.startsWith("-") ? clean.substring(1) : clean;
  });

  const sortedCards = [...cards].sort((a, b) => {
    const posA = normalizedOrder.findIndex((name) =>
      getCardTitle(a).includes(name),
    );
    const posB = normalizedOrder.findIndex((name) =>
      getCardTitle(b).includes(name),
    );
    return (posA === -1 ? Infinity : posA) - (posB === -1 ? Infinity : posB);
  });

  const hasMoved = sortedCards.some((child, idx) => cards[idx] !== child);
  if (hasMoved) sortedCards.forEach((child) => grid.appendChild(child));

  return hasMoved;
}

export async function optimizeLayout() {
  if (location.hostname !== "profile-v3.intra.42.fr") return;
  if (!isDashboardPath()) return;

  const cardOrder = (await getConfig("PROFILE_CARD_ORDER")) as string[] | null;
  const hideCardByText = (searchText: string, shouldHide: boolean) => {
    const cleanSearch = searchText.toUpperCase().trim();

    if (cleanSearch === "LOGTIME") {
      const host = document.getElementById("logtime-shadow-wrapper");
      if (host) host.style.display = shouldHide ? "none" : "";
    }

    document
      .querySelectorAll<HTMLElement>(DASHBOARD_CARD_SELECTOR)
      .forEach((c) => {
        // The title only, as reorderCards() matches it: the whole text of
        // a card hid the agenda with PROJECTS as soon as an event was named
        // "... projects ...".
        if (getCardTitle(c).includes(cleanSearch)) {
          c.style.display = shouldHide ? "none" : "";
        }
      });
  };

  const hiddenCards = cardOrder
    ? cardOrder
        .filter((name) => name.startsWith("-"))
        .map((name) => name.substring(1).trim().toUpperCase())
    : [];

  hiddenCards.forEach((cardTitle) => {
    hideCardByText(cardTitle, true);
  });

  const cards = getCards();
  if (!cards.length) return;

  if (cachedGrid && cardOrder && cardOrder.length > 0) {
    if (reorderCards(cachedGrid, cardOrder, cards)) cachedCards = null;
  }
}

let layoutInitialised = false;

export async function initLayoutManager() {
  const isOwnProfile =
    location.hostname === "profile-v3.intra.42.fr" && isDashboardPath();

  if (!isOwnProfile) return;

  // Called on every mutation pass of profile.ts: without this guard each call
  // added another resize listener, rAF poll loop and MutationObserver.
  if (layoutInitialised) return;
  layoutInitialised = true;

  void optimizeLayout();
  window.addEventListener("resize", () => void optimizeLayout());

  let isUpdating = false;
  let observer: MutationObserver | null = null;

  const setupObserver = (parent: HTMLElement) => {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (isUpdating) return;
      isUpdating = true;
      requestAnimationFrame(() => {
        optimizeLayout().finally(() => {
          isUpdating = false;
        });
      });
    });
    observer.observe(parent, { childList: true, subtree: false });
  };

  let pollAttempts = 0;
  const MAX_POLL_ATTEMPTS = 600; // ~10 s at 60 fps
  const poll = () => {
    const cards = getCards();
    if (cards.length && cachedGrid) {
      setupObserver(cachedGrid);
    } else if (pollAttempts++ < MAX_POLL_ATTEMPTS) {
      requestAnimationFrame(poll);
    }
  };
  requestAnimationFrame(poll);
}
