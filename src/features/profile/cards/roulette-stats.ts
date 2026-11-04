import { getConfig } from "../../../core/config.ts";
import { getCloudLogin } from "../../account/account.ts";
import { getLoginFromPage } from "../../../core/intra/profile-login.ts";
import { DASHBOARD_CARD_SELECTOR } from "../../../core/intra/selectors.ts";
import { hashLogin } from "../../../core/crypto.ts";
import { createCountdown } from "../../../core/dom/countdown.ts";
import {
  TOOLTIP_SHOW_DELAY,
  hideFloatingTooltip,
  showFloatingTooltip,
} from "../../../core/dom/tooltip.ts";
import { getIsLight } from "../../../core/theme/theme-manager.ts";
import { createSkeleton, createSkeletonLines } from "../../../core/dom/skeleton.ts";
import { tickWhileVisible } from "../../../core/dom/dom-wait.ts";
import { t } from "../../../core/i18n/i18n.ts";

import { WORKER_URL, AUTH_MODE } from "../../../core/worker.ts";
import {
  fetchProfileStatsViaIntra,
  readProfileStatsCache,
  writeProfileStatsCache,
} from "./profile-stats-intra.ts";
import { fetchOwnEvaluationStats, type OutstandingCounts } from "./evaluations-api.ts";
const CARD_ID = "ft-roulette-card";

let rouletteStatsInitialized = false;
let rouletteStatsPolling = false;
/** Stops the "Next" countdown ticker (see renderCard). */
let stopCountdown: (() => void) | null = null;

interface RouletteEntry {
  historic_id: number;
  sum: number;
  total: number;
  created_at: string;
}

interface EvalStatsData {
  byMonth: Record<
    string,
    { total: number; failed: number; successPercentage: number | null }
  >;
  global: { total: number; failed: number; successPercentage: number | null };
}

/**
 * What the card shows. `roulette` is null when the history could not be
 * fetched: the card then says so, instead of "0 wins / 0 points" passing for
 * the student's real record.
 */
interface ProfileStats {
  roulette: RouletteEntry[] | null;
  evalStats: EvalStatsData | null;
  /** Your Outstanding flags; null when unknown (not your profile, no 42 application). */
  outstanding?: OutstandingCounts | null;
}

const UNAVAILABLE: ProfileStats = { roulette: null, evalStats: null };

function isOutstanding(v: unknown): v is OutstandingCounts {
  if (!v || typeof v !== "object") return false;
  const o = v as { received?: unknown; given?: unknown };
  return typeof o.received === "number" && typeof o.given === "number";
}

function formatRouletteDate(dateStr: string): string {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/** The roulette runs on Fridays at 08:00, Paris time. */
const ROULETTE_ZONE = "Europe/Paris";
const ROULETTE_HOUR = 8;

/** How far `zone`'s wall clock is ahead of UTC at `ts`, in ms. */
function zoneOffsetMs(ts: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * The next roulette after `from`: the next Friday 08:00 in Paris, summer or
 * winter time. It was a fixed 06:00 UTC, which is 08:00 in summer only: from
 * the end of October the countdown reached zero at 07:00 while the label
 * still said 8:00.
 */
export function nextRouletteTimestamp(from: number): number {
  const d = new Date(from);
  for (let i = 0; i < 9; i++) {
    const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, ROULETTE_HOUR);
    const at = guess - zoneOffsetMs(guess - zoneOffsetMs(guess, ROULETTE_ZONE), ROULETTE_ZONE);
    const weekday = new Date(guess).getUTCDay();
    if (weekday === 5 && at > from) return at;
  }
  // unreachable: a Friday comes within a week
  return from + 7 * 86400000;
}

function getNextRoulette(): {
  days: number;
  hours: number;
  minutes: number;
  dateLabel: string;
} {
  const now = Date.now();
  const nextMs = nextRouletteTimestamp(now);
  const diff = nextMs - now;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  // The viewer's own clock, from the same instant as the countdown: 8:00 in
  // Paris, 7:00 in Lisbon, 11:00 in Abu Dhabi.
  const d = new Date(nextMs);
  const time = d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" });
  const dateLabel = `${d.toLocaleDateString("en-US", { weekday: "long" })} ${d.getDate()} ${d.toLocaleDateString("en-US", { month: "long" })}, ${time}`;

  return { days, hours, minutes, dateLabel };
}

function getCountdownParts(): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const now = Date.now();
  const nextMs = nextRouletteTimestamp(now);
  const diff = nextMs - now;
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
  };
}

function getTargetLogin(): string | null {
  if (location.pathname.startsWith("/users/")) {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts[1] || null;
  }
  return null;
}

async function fetchProfileStats(targetLogin: string): Promise<ProfileStats> {
  if (AUTH_MODE === "intra") {
    // No 42 API on the self-hosted worker: read the Intra v2 pages instead
    // (see profile-stats-intra.ts), with the student's own Intra cookies, so
    // no cloud session is needed. Cached locally for an hour per login, but
    // only a complete read: a failed page would otherwise be shown as the
    // real numbers for that hour.
    const cached = await readProfileStatsCache(targetLogin);
    if (cached) {
      // storage is only checked to hold an object: an entry without a list
      // is unknown, not an empty history
      return {
        roulette: Array.isArray(cached.roulette) ? cached.roulette : null,
        evalStats: cached.evalStats ?? null,
        outstanding: isOutstanding(cached.outstanding) ? cached.outstanding : null,
      };
    }
    // On your own profile the worker's 42 application gives the stats in a
    // request or two, instead of up to 40 v2 pages; the roulette history
    // still comes from its Intra page. Anything else falls back to the pages.
    const api = await fetchOwnEvaluationStats(targetLogin).catch(() => null);
    const data = await fetchProfileStatsViaIntra(targetLogin, { feedbacks: !api });
    const evalStats = api ? api.stats : data.evalStats;
    const outstanding = api ? api.outstanding : null;
    if (data.complete) {
      await writeProfileStatsCache(targetLogin, {
        roulette: data.roulette,
        evalStats,
        outstanding,
      });
    }
    return {
      roulette: data.rouletteLoaded ? data.roulette : null,
      evalStats,
      outstanding,
    };
  }

  const cloudLogin = await getCloudLogin();
  const sessionToken = await getConfig("CLOUD_TOKEN");
  if (!cloudLogin || !sessionToken) return UNAVAILABLE;

  const hashedLogin = await hashLogin(cloudLogin);

  try {
    const params = new URLSearchParams({
      login: hashedLogin,
      target: targetLogin,
      force: "1",
    });
    const res = await fetch(
      `${WORKER_URL}/api/v1/private/profile-stats?${params}`,
      {
        headers: { Authorization: `Bearer ${sessionToken}` },
      },
    );
    if (!res.ok) return UNAVAILABLE;

    const data = (await res.json()) as {
      roulette?: { entries?: RouletteEntry[] };
      evalStats?: EvalStatsData;
    };

    const entries = data.roulette?.entries;
    return {
      roulette: Array.isArray(entries) ? entries : null,
      evalStats: data.evalStats || null,
    };
  } catch {
    return UNAVAILABLE;
  }
}

/** Stands in for a count that could not be fetched. */
const NO_VALUE = "—";

function buildRouletteSection(
  entries: RouletteEntry[] | null,
  showHistory: boolean,
  loading: boolean,
): HTMLElement {
  const section = document.createElement("div");

  const wins =
    entries === null
      ? NO_VALUE
      : String(new Set(entries.map((e) => formatRouletteDate(e.created_at))).size);
  const points =
    entries === null
      ? NO_VALUE
      : String(entries.reduce((acc, e) => acc + e.sum, 0));
  const { dateLabel } = getNextRoulette();

  const counters = document.createElement("div");
  counters.className = "flex flex-row items-stretch my-2 gap-3";
  // Wraps: the three tiles need about 510 px, more than the card has inside
  // on a phone and at common desktop widths too (1024-1290 px in two columns,
  // 1536-1890 px in three), where the Next countdown was cut at the edge.
  // Inline, as the tiles are: this card sits in the page, whose utility
  // classes are whatever the Intra's own build kept.
  counters.style.flexWrap = "wrap";
  counters.style.justifyContent = "center";

  const winCol = document.createElement("span");
  winCol.style.cssText =
    "display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 10px; color: rgb(59,130,246); background: rgba(59,130,246,0.1);";
  const winLabel = document.createElement("span");
  winLabel.className =
    "text-sm font-semibold opacity-70 uppercase tracking-wide";
  winLabel.textContent = t("Wins");
  winCol.appendChild(winLabel);
  const winValue = document.createElement("span");
  winValue.style.cssText =
    "font-size: 26px; font-weight: 700; margin-left: 6px;";
  if (loading) {
    winValue.appendChild(createSkeleton({ width: "28px", height: "20px" }));
  } else {
    winValue.textContent = wins;
  }
  winCol.appendChild(winValue);
  counters.appendChild(winCol);

  const ptsCol = document.createElement("span");
  ptsCol.style.cssText =
    "display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 10px; color: rgb(34,197,94); background: rgba(34,197,94,0.1);";
  const ptsLabel = document.createElement("span");
  ptsLabel.className =
    "text-sm font-semibold opacity-70 uppercase tracking-wide";
  ptsLabel.textContent = "Points";
  ptsCol.appendChild(ptsLabel);
  const ptsValue = document.createElement("span");
  ptsValue.style.cssText =
    "font-size: 26px; font-weight: 700; margin-left: 6px;";
  if (loading) {
    ptsValue.appendChild(createSkeleton({ width: "36px", height: "20px" }));
  } else {
    ptsValue.textContent = points;
  }
  ptsCol.appendChild(ptsValue);
  counters.appendChild(ptsCol);

  const nextCol = document.createElement("span");
  nextCol.style.cssText =
    "display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 10px; color: rgb(245,158,11); background: rgba(245,158,11,0.1);";
  const nextLabel = document.createElement("span");
  nextLabel.className =
    "text-sm font-semibold opacity-70 uppercase tracking-wide";
  nextLabel.textContent = t("Next");
  nextCol.appendChild(nextLabel);
  const parts = getCountdownParts();
  const countdown = createCountdown(
    [parts.days, parts.hours, parts.minutes, parts.seconds],
    { digits: 2 },
  );
  countdown.el.id = "ft-roulette-countdown";
  countdown.el.style.cssText =
    "font-size: 26px; font-weight: 700; margin-left: 6px;";
  nextCol.appendChild(countdown.el);
  counters.appendChild(nextCol);

  section.appendChild(counters);

  if (!loading && entries === null) {
    const note = document.createElement("div");
    note.style.cssText = "font-size: 13px; opacity: 0.6; text-align: center;";
    note.textContent = t("Couldn't load roulette history");
    section.appendChild(note);
  }

  if (showHistory && loading) {
    const divider = document.createElement("div");
    divider.style.cssText =
      "border-top: 1px solid hsl(var(--border)); margin: 8px 0;";
    section.appendChild(divider);

    const list = document.createElement("div");
    list.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";
    for (const width of ["120px", "104px", "112px"]) {
      list.appendChild(
        createSkeleton({ width, height: "30px", radius: "999px" }),
      );
    }
    section.appendChild(list);
  }

  if (showHistory && !loading && entries !== null && entries.length > 0) {
    const divider = document.createElement("div");
    divider.style.cssText =
      "border-top: 1px solid hsl(var(--border)); margin: 8px 0;";
    section.appendChild(divider);

    const scrollWrap = document.createElement("div");
    scrollWrap.style.cssText = "overflow-y: auto; max-height: 100px;";

    const list = document.createElement("div");
    list.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";

    const grouped = new Map<string, number>();
    for (const entry of entries) {
      const dateStr = formatRouletteDate(entry.created_at);
      grouped.set(dateStr, (grouped.get(dateStr) || 0) + entry.sum);
    }
    for (const [dateStr, totalSum] of grouped) {
      const badge = document.createElement("span");
      badge.style.cssText =
        "display: inline-flex; align-items: center; gap: 8px; background: rgba(34,197,94,0.1); color: rgb(34,197,94); font-size: 14px; font-weight: 600; padding: 6px 16px; border-radius: 999px; white-space: nowrap;";
      const datePart = document.createElement("span");
      datePart.style.cssText =
        "opacity: 0.65; font-size: 13px; font-weight: 600;";
      datePart.textContent = dateStr;
      badge.appendChild(datePart);
      const plus = document.createElement("span");
      plus.style.cssText = "font-size: 16px; font-weight: 700;";
      plus.textContent = `+${totalSum}`;
      badge.appendChild(plus);
      list.appendChild(badge);
    }

    scrollWrap.appendChild(list);
    section.appendChild(scrollWrap);
  }

  return section;
}

function buildEvalStatsSection(
  data: EvalStatsData,
  outstanding: OutstandingCounts | null = null,
): HTMLElement {
  const section = document.createElement("div");

  const titleRow = document.createElement("div");
  titleRow.style.cssText =
    "display: flex; align-items: center; gap: 8px; margin-bottom: 8px;";

  const titleWrap = document.createElement("div");
  titleWrap.className = "inline-flex";
  const title = document.createElement("span");
  title.className = "font-bold uppercase text-sm cursor-help";
  title.textContent = t("Evaluations as Corrector");
  titleWrap.appendChild(title);
  titleRow.appendChild(titleWrap);

  const tooltipText = t(
    "Shows how many times you acted as a corrector (evaluator) per month, and how many of those evaluations you marked as failed (below 50%) — with the success percentage",
  );
  let hovered = false;
  let tooltipTimer: number | null = null;
  title.addEventListener("mouseenter", () => {
    hovered = true;
    if (tooltipTimer !== null) window.clearTimeout(tooltipTimer);
    tooltipTimer = window.setTimeout(() => {
      tooltipTimer = null;
      void getIsLight().then((isLight) => {
        if (hovered)
          showFloatingTooltip(title, tooltipText, isLight, document.body);
      });
    }, TOOLTIP_SHOW_DELAY);
  });
  title.addEventListener("mouseleave", () => {
    hovered = false;
    if (tooltipTimer !== null) {
      window.clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
    hideFloatingTooltip();
  });

  const badgesWrap = document.createElement("div");
  badgesWrap.style.cssText =
    "display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; white-space: nowrap;";

  function makeBadge(
    containerStyle: string,
    label: string,
    value: string,
  ): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.style.cssText = containerStyle;
    const labelEl = document.createElement("span");
    labelEl.className =
      "text-sm font-semibold opacity-70 uppercase tracking-wide";
    labelEl.textContent = label;
    badge.appendChild(labelEl);
    const valueEl = document.createElement("span");
    valueEl.style.cssText =
      "font-size: 20px; font-weight: 700; margin-left: 6px;";
    valueEl.textContent = value;
    badge.appendChild(valueEl);
    return badge;
  }

  if (data.global.successPercentage !== null) {
    const color =
      data.global.successPercentage >= 67 ? "rgb(34,197,94)" : "rgb(239,68,68)";
    const badge = document.createElement("span");
    badge.style.cssText = `font-size: 20px; font-weight: 700; padding: 10px 20px; border-radius: 10px; color: ${color}; background: rgba(${data.global.successPercentage >= 67 ? "34,197,94" : "239,68,68"},0.1);`;
    badge.textContent = `${data.global.successPercentage}%`;
    badgesWrap.appendChild(badge);
  }

  badgesWrap.appendChild(
    makeBadge(
      "display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 10px; color: rgb(59,130,246); background: rgba(59,130,246,0.1);",
      "total",
      String(data.global.total),
    ),
  );

  badgesWrap.appendChild(
    makeBadge(
      "display: inline-flex; align-items: center; padding: 10px 20px; border-radius: 10px; color: rgb(239,68,68); background: rgba(239,68,68,0.1);",
      t("failed"),
      String(data.global.failed),
    ),
  );

  titleRow.appendChild(badgesWrap);

  section.appendChild(titleRow);

  // Only from the worker's 42 application, on your own profile: the Intra
  // pages the stats are otherwise read from do not say it.
  if (outstanding) {
    const line = document.createElement("div");
    line.className = "text-sm";
    line.style.cssText = "margin-bottom: 8px; color: rgb(234,179,8); font-weight: 600;";
    line.textContent = `★ ${t("Outstanding: {received} received, {given} given", {
      received: outstanding.received,
      given: outstanding.given,
    })}`;
    section.appendChild(line);
  }

  const tableWrap = document.createElement("div");

  const table = document.createElement("table");
  table.style.cssText =
    "width: 100% !important; border-collapse: collapse !important; font-size: 12px !important;";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.style.cssText =
    "border-bottom: 1px solid hsl(var(--primary) / 0.2) !important;";
  const headers = [t("Month"), "Total", t("Failed"), t("Success %")];
  for (const h of headers) {
    const th = document.createElement("th");
    th.style.cssText =
      "text-align: left !important; padding: 4px 4px !important; font-weight: 500 !important; color: hsl(var(--primary) / 0.6) !important;";
    th.textContent = h;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const months = Object.keys(data.byMonth).sort().reverse();
  for (const month of months) {
    const m = data.byMonth[month];
    const tr = document.createElement("tr");
    tr.style.cssText =
      "border-bottom: 1px solid hsl(var(--primary) / 0.2) !important;";

    const dateTd = document.createElement("td");
    dateTd.style.cssText =
      "padding: 4px 4px !important; color: hsl(var(--primary) / 0.5) !important;";
    const [yearNum, monthNum] = month.split("-");
    dateTd.textContent = `${monthNum}/${yearNum}`;
    tr.appendChild(dateTd);

    const totalTd = document.createElement("td");
    totalTd.style.cssText =
      "padding: 4px 4px !important; font-weight: 500 !important; color: inherit !important;";
    totalTd.textContent = String(m.total);
    tr.appendChild(totalTd);

    const failedTd = document.createElement("td");
    failedTd.style.cssText =
      "padding: 4px 4px !important; color: inherit !important;";
    // The priority goes in setProperty's third argument: "... !important"
    // inside a style.color value is invalid, so it was silently dropped and
    // the "inherit !important" above always won.
    if (m.failed > 0)
      failedTd.style.setProperty("color", "rgb(239,68,68)", "important");
    failedTd.textContent = String(m.failed);
    tr.appendChild(failedTd);

    const pctTd = document.createElement("td");
    pctTd.style.cssText =
      "padding: 4px 4px !important; font-weight: 500 !important;";
    if (m.successPercentage !== null) {
      pctTd.style.setProperty(
        "color",
        m.successPercentage >= 80 ? "rgb(34,197,94)" : "rgb(239,68,68)",
        "important",
      );
      pctTd.textContent = `${m.successPercentage}%`;
    } else {
      pctTd.textContent = "—";
      pctTd.style.setProperty("color", "hsl(var(--primary) / 0.3)", "important");
    }
    tr.appendChild(pctTd);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  section.appendChild(tableWrap);

  return section;
}

function buildEvalStatsSkeleton(): HTMLElement {
  const section = document.createElement("div");

  const titleRow = document.createElement("div");
  titleRow.style.cssText =
    "display: flex; align-items: center; gap: 8px; margin-bottom: 8px;";

  const title = document.createElement("span");
  title.className = "font-bold uppercase text-sm";
  title.textContent = t("Evaluations as Corrector");
  titleRow.appendChild(title);

  const badgesWrap = document.createElement("div");
  badgesWrap.style.cssText =
    "display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;";
  for (const width of ["74px", "96px", "104px"]) {
    badgesWrap.appendChild(
      createSkeleton({ width, height: "42px", radius: "10px" }),
    );
  }
  titleRow.appendChild(badgesWrap);
  section.appendChild(titleRow);

  section.appendChild(
    createSkeletonLines(4, { width: "100%", height: "18px" }),
  );

  return section;
}

function ensureCard(force: boolean): HTMLElement | null {
  const existing = document.getElementById(CARD_ID);
  if (existing) return existing;

  const grid =
    document.querySelector(".dash-main") ||
    document.querySelector(DASHBOARD_CARD_SELECTOR)?.parentElement;
  if (!grid) return null;

  // Waiting for intra to have rendered at least one of its own cards keeps our
  // card from sitting alone on an otherwise empty dashboard for a few frames.
  if (!force && grid.querySelector(DASHBOARD_CARD_SELECTOR) === null)
    return null;

  const card = document.createElement("div");
  card.id = CARD_ID;
  // Tagged here, not from its title (customize/cards.ts): the title is
  // translated, and the Customize styles address the card by this id.
  card.dataset.ftCard = "roulette";
  card.className = "bg-white md:h-96 md:drop-shadow-md md:rounded-lg";
  card.style.cssText =
    "overflow: hidden; display: flex; flex-direction: column; height: 384px;";
  grid.appendChild(card);
  return card;
}

/**
 * Fills the card in place. Called once with `loading` while the worker request
 * is in flight, so the card holds its slot in the grid from the first frame,
 * then again with the data once it lands.
 */
function renderCard(
  card: HTMLElement,
  rouletteEntries: RouletteEntry[] | null,
  evalStats: EvalStatsData | null,
  showRouletteHistory: boolean,
  loading: boolean,
  outstanding: OutstandingCounts | null = null,
) {
  if (stopCountdown !== null) {
    stopCountdown();
    stopCountdown = null;
  }
  card.textContent = "";

  const topSection = document.createElement("div");
  topSection.style.cssText =
    "flex: 1; min-height: 0; overflow-y: scroll; padding: 24px 24px 12px 24px;";

  // The title is the first element carrying an "uppercase" class, as on the
  // Intra's own cards. It is translated, so the layout manager recognises this
  // card by its id (layout.ts), not by the title's text.
  const rouletteTitle = document.createElement("div");
  rouletteTitle.className = "font-bold uppercase text-sm";
  rouletteTitle.style.cssText =
    "font-weight: 700; text-transform: uppercase; font-size: 14px; margin-bottom: 8px;";
  rouletteTitle.textContent = t("Thursday Roulette");
  topSection.appendChild(rouletteTitle);

  topSection.appendChild(
    buildRouletteSection(rouletteEntries, showRouletteHistory, loading),
  );

  card.appendChild(topSection);

  if (loading || evalStats) {
    const divider = document.createElement("div");
    divider.style.cssText =
      "border-top: 1px solid hsl(var(--primary) / 0.2); flex-shrink: 0; margin: 0 24px;";
    card.appendChild(divider);

    const bottomSection = document.createElement("div");
    bottomSection.style.cssText =
      "flex: 1; min-height: 0; overflow-y: scroll; padding: 12px 24px 24px 24px;";
    bottomSection.appendChild(
      evalStats ? buildEvalStatsSection(evalStats, outstanding) : buildEvalStatsSkeleton(),
    );
    card.appendChild(bottomSection);
  }

  // The countdown is recomputed from Date.now() on every tick, so it can
  // sleep while the tab is in the background (it used to wake the browser
  // once a second there) and be right again on the first tick after.
  const stop = tickWhileVisible(() => {
    const done = () => {
      if (stopCountdown === stop) stopCountdown = null;
      return true;
    };
    const host = document.getElementById("ft-roulette-countdown");
    if (!host?.shadowRoot) return done();
    const segs =
      host.shadowRoot.querySelectorAll<HTMLSpanElement>(".countdown > span");
    if (segs.length === 0) return done();
    const parts = getCountdownParts();
    const values = [parts.days, parts.hours, parts.minutes, parts.seconds];
    segs.forEach((seg, i) => {
      const value = String(values[i] ?? 0);
      seg.style.setProperty("--value", value);
      seg.setAttribute("aria-label", value);
      seg.textContent = value.padStart(2, "0");
    });
  }, 1000);
  stopCountdown = stop;
}

export async function initRouletteStats() {
  if (rouletteStatsInitialized || rouletteStatsPolling) return;
  if (!(await getConfig("PROFILE_SHOW_ROULETTE"))) return;

  if (
    location.hostname !== "profile-v3.intra.42.fr" ||
    !(location.pathname === "/" || location.pathname.startsWith("/users"))
  )
    return;

  const showHistory = await getConfig("PROFILE_SHOW_ROULETTE_HISTORY");
  const cloudLogin = await getCloudLogin();
  let targetLogin = getTargetLogin();
  if (AUTH_MODE === "intra") {
    // The Intra v2 pages are read with the student's own cookies: no cloud
    // session needed, so on your own profile the page login stands in for
    // the cloud one (as for the marks list).
    targetLogin ||= cloudLogin || getLoginFromPage();
  } else {
    // The worker computes the stats and wants a session: signed out there is
    // nothing to fetch, and a card of zeros would pass for real data.
    if (!cloudLogin || !(await getConfig("CLOUD_TOKEN"))) return;
    targetLogin ||= cloudLogin;
  }
  if (!targetLogin) return;

  rouletteStatsPolling = true;

  // Fire the worker request right away: it must not wait for the intra grid to
  // be in the DOM, otherwise the card can only be filled after both are done.
  const statsPromise = fetchProfileStats(targetLogin).catch(() => UNAVAILABLE);

  let attempts = 0;
  const poll = () => {
    // Past the grace period the card is mounted regardless, so it is never
    // dropped on a dashboard where every other card is hidden.
    const lastAttempt = ++attempts > 30;

    const card = ensureCard(lastAttempt);
    if (!card) {
      if (lastAttempt) {
        rouletteStatsPolling = false;
        return;
      }
      requestAnimationFrame(poll);
      return;
    }

    // The card takes its slot in the grid immediately, with placeholders where
    // the worker values go, so nothing pops in once the request resolves.
    renderCard(card, null, null, showHistory, true);

    statsPromise.then(({ roulette, evalStats, outstanding }) => {
      rouletteStatsInitialized = true;
      rouletteStatsPolling = false;
      renderCard(card, roulette, evalStats, showHistory, false, outstanding ?? null);
    });
  };
  requestAnimationFrame(poll);
}
