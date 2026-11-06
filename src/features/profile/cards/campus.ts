/**
 * The Campus card, on your own dashboard only: your next exam, the standings
 * of your coalitions, and your correction points over time.
 *
 * - The exam comes from your Intra events (own-events.ts: intrapy lists every
 *   exam of your campus, with whether you are registered), so it needs no
 *   cloud account and spends nothing from the worker's 42 quota.
 * - Coalitions and points come from the worker's 42 application
 *   (evaluations-api.ts), signed in only, and only when /features announces
 *   them. They are kept in local storage for 30 minutes, so reloading the
 *   dashboard does not ask the worker again.
 *
 * A section with nothing to show is left out, and the card with it when all
 * three are empty. Every text is set with textContent; the coalition images
 * are Intra CDN URLs only (checked by the worker and again here).
 */
import { getConfig } from "../../../core/config.ts";
import { waitForElement } from "../../../core/dom/dom-wait.ts";
import { parseIntraDate } from "../../../core/intra/intrapy.ts";
import { intlLocale, t } from "../../../core/i18n/i18n.ts";
import { fetchOwnEvents, isOwnProfilePage } from "../../calendar/own-events.ts";
import type { CalendarEvent } from "../../logtime/types.ts";
import {
  fetchCorrectionPoints,
  fetchOwnCoalitions,
  type CoalitionBloc,
  type PointsEntry,
} from "./evaluations-api.ts";

export const CAMPUS_CARD_ID = "ft-campus-card";
const CACHE_KEY = "CAMPUS_CARD_CACHE";
export const CAMPUS_CACHE_MS = 30 * 60_000;
/** The graph's window: the last 90 days, plus the balance before them. */
const GRAPH_DAYS = 90;
const SVG_NS = "http://www.w3.org/2000/svg";

let running = false;
let drawn = false;

/** For the tests. */
export function resetCampusCard(): void {
  running = false;
  drawn = false;
}

window.addEventListener(
  "pagehide",
  () => {
    running = false;
    drawn = false;
  },
  { once: true },
);

interface CampusCache {
  login: string;
  at: number;
  coalitions: CoalitionBloc[] | null;
  points: PointsEntry[] | null;
}

async function readCache(login: string): Promise<CampusCache | null> {
  try {
    const raw = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as CampusCache | undefined;
    if (!raw || typeof raw !== "object" || raw.login !== login) return null;
    if (typeof raw.at !== "number" || Date.now() - raw.at >= CAMPUS_CACHE_MS) return null;
    return {
      login,
      at: raw.at,
      coalitions: Array.isArray(raw.coalitions) ? raw.coalitions : null,
      points: Array.isArray(raw.points) ? raw.points : null,
    };
  } catch {
    return null;
  }
}

/** The next exam of your campus, or null: the one you are registered for first. */
export function nextExam(events: CalendarEvent[], now = Date.now()): CalendarEvent | null {
  const upcoming = events
    .filter((e) => e.kind === "exam" && parseIntraDate(e.end_at).getTime() > now)
    .sort((a, b) => parseIntraDate(a.begin_at).getTime() - parseIntraDate(b.begin_at).getTime());
  return upcoming.find((e) => e.is_subscribed) ?? upcoming[0] ?? null;
}

/** "in 3 d 4 h", "in 2 h 5 min", "now". */
export function untilText(beginMs: number, now = Date.now()): string {
  const diff = beginMs - now;
  if (diff <= 0) return t("Now");
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return t("In {d} d {h} h", { d, h });
  if (h > 0) return t("In {h} h {m} min", { h, m });
  return t("In {m} min", { m: Math.max(1, m) });
}

/** The points of the last `days` days, starting from the balance before them. */
export function graphPoints(points: PointsEntry[], now = Date.now(), days = GRAPH_DAYS): PointsEntry[] {
  const from = now - days * 86_400_000;
  const inside = points.filter((p) => Date.parse(p.at) >= from);
  const before = points.filter((p) => Date.parse(p.at) < from).at(-1);
  return before ? [{ at: new Date(from).toISOString(), total: before.total }, ...inside] : inside;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return el(
    "div",
    "font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6;",
    text,
  );
}

function section(): HTMLElement {
  return el("div", "flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem;");
}

function examSection(exam: CalendarEvent, color: string): HTMLElement {
  const box = section();
  box.dataset.section = "exam";
  box.appendChild(sectionTitle(t("Next exam")));
  const begin = parseIntraDate(exam.begin_at);
  const name = el("a", `font-weight: 700; color: ${color}; text-decoration: none;`, exam.name);
  name.href = `https://profile.intra.42.fr/exams/${exam.id}`;
  name.target = "_blank";
  name.rel = "noopener noreferrer";
  box.appendChild(name);
  const when = begin.toLocaleString(intlLocale("en-US"), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  box.appendChild(el("div", "font-size: 0.875rem;", exam.location ? `${when} · ${exam.location}` : when));
  const row = el("div", "display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; font-size: 0.8rem;");
  row.appendChild(el("span", "font-weight: 700;", untilText(begin.getTime())));
  const pill = el(
    "span",
    `padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; ${
      exam.is_subscribed ? "background: #2e7d3233; color: #4caf50;" : "background: #ff980033; color: #ff9800;"
    }`,
    exam.is_subscribed ? t("Registered") : t("Not registered"),
  );
  row.appendChild(pill);
  box.appendChild(row);
  return box;
}

function coalitionsSection(blocs: CoalitionBloc[]): HTMLElement {
  const box = section();
  box.dataset.section = "coalitions";
  box.appendChild(sectionTitle(t("Coalitions")));
  const formatter = new Intl.NumberFormat(intlLocale("en-US"));
  for (const bloc of blocs) {
    const top = Math.max(1, ...bloc.coalitions.map((c) => c.score));
    const list = el("ol", "list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem;");
    bloc.coalitions.forEach((c, i) => {
      const color = c.color ?? "#00babc";
      const item = el("li", `display: flex; flex-direction: column; gap: 0.15rem;${c.mine ? "" : " opacity: 0.75;"}`);
      const line = el("div", "display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem;");
      line.appendChild(el("span", "width: 1.1rem; opacity: 0.7;", `${i + 1}.`));
      if (c.imageUrl) {
        const img = document.createElement("img");
        img.src = c.imageUrl;
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        img.style.cssText = `width: 1.1rem; height: 1.1rem; background: ${color}; border-radius: 4px; padding: 1px;`;
        line.appendChild(img);
      }
      line.appendChild(
        el("span", `flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${c.mine ? " font-weight: 700;" : ""}`, c.name),
      );
      line.appendChild(el("span", "font-variant-numeric: tabular-nums;", formatter.format(c.score)));
      item.appendChild(line);
      const track = el("div", "height: 4px; border-radius: 2px; background: #8882;");
      track.appendChild(
        el("div", `height: 100%; border-radius: 2px; background: ${color}; width: ${Math.max(2, (c.score / top) * 100).toFixed(1)}%;`),
      );
      item.appendChild(track);
      if (c.mine) item.title = t("Your coalition");
      list.appendChild(item);
    });
    box.appendChild(list);
  }
  return box;
}

function pointsSection(points: PointsEntry[], color: string): HTMLElement {
  const box = section();
  box.dataset.section = "points";
  box.appendChild(sectionTitle(t("Correction points")));
  const series = graphPoints(points);
  const current = points.at(-1)!.total;
  const head = el("div", "display: flex; align-items: baseline; gap: 0.5rem;");
  head.appendChild(el("span", `font-size: 1.5rem; font-weight: 700; color: ${color};`, String(current)));
  const first = series[0]?.total ?? current;
  const delta = current - first;
  head.appendChild(
    el(
      "span",
      "font-size: 0.8rem; opacity: 0.7;",
      t("{delta} in {days} days", { delta: delta > 0 ? `+${delta}` : String(delta), days: GRAPH_DAYS }),
    ),
  );
  box.appendChild(head);

  if (series.length >= 2) {
    const W = 300;
    const H = 60;
    const start = Date.parse(series[0].at);
    const span = Math.max(1, Date.now() - start);
    const totals = series.map((p) => p.total);
    const lo = Math.min(...totals);
    const hi = Math.max(...totals);
    const y = (v: number) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
    const x = (at: string) => ((Date.parse(at) - start) / span) * W;
    // A step line: the balance holds until the next change.
    let d = `M0,${y(series[0].total).toFixed(1)}`;
    for (const p of series.slice(1)) {
      d += ` H${x(p.at).toFixed(1)} V${y(p.total).toFixed(1)}`;
    }
    d += ` H${W}`;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      t("Correction points over {days} days: from {from} to {to}, lowest {lo}, highest {hi}", {
        days: GRAPH_DAYS,
        from: first,
        to: current,
        lo,
        hi,
      }),
    );
    svg.style.cssText = "width: 100%; height: 60px; overflow: visible;";
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(path);
    box.appendChild(svg);
    const scale = el("div", "display: flex; justify-content: space-between; font-size: 0.7rem; opacity: 0.6;");
    scale.appendChild(el("span", "", t("Low {n}", { n: lo })));
    scale.appendChild(el("span", "", t("High {n}", { n: hi })));
    box.appendChild(scale);
  }
  return box;
}

const PROFILE_CARD_SELECTOR =
  ".flex.flex-col.lg\\:flex-row.gap-6.md\\:gap-8 > :first-child";

function place(card: HTMLElement, profileCard: HTMLElement): void {
  const after =
    document.getElementById("ft-freeze-card") ??
    document.getElementById("profile-badges-shadow") ??
    profileCard;
  after.insertAdjacentElement("afterend", card);
}

export function buildCampusCard(
  parts: { exam: CalendarEvent | null; coalitions: CoalitionBloc[] | null; points: PointsEntry[] | null },
  color: string,
): HTMLElement | null {
  const sections: HTMLElement[] = [];
  if (parts.exam) sections.push(examSection(parts.exam, color));
  if (parts.coalitions && parts.coalitions.length > 0) sections.push(coalitionsSection(parts.coalitions));
  if (parts.points && parts.points.length > 0) sections.push(pointsSection(parts.points, color));
  if (sections.length === 0) return null;

  const card = document.createElement("div");
  card.id = CAMPUS_CARD_ID;
  card.className = "border border-ft-gray-border bg-ft-gray/50 rounded-xl w-full";
  card.style.cssText = "padding: 1rem 1.25rem; display: flex; flex-wrap: wrap; gap: 1.25rem;";
  for (const s of sections) card.appendChild(s);
  return card;
}

/** Your login on your own dashboard, from the session first. */
async function ownLogin(): Promise<string | null> {
  const login = (await getConfig("CLOUD_LOGIN")) as string | null;
  return login ? login.toLowerCase() : null;
}

export async function initCampusCard(): Promise<void> {
  if (running || drawn) return;
  if (!isOwnProfilePage()) return;
  running = true;
  try {
    if (!(await getConfig("PROFILE_SHOW_CAMPUS"))) return;
    const login = await ownLogin();
    const cached = login ? await readCache(login) : null;

    const [events, coalitions, points] = await Promise.all([
      fetchOwnEvents(),
      cached ? cached.coalitions : fetchOwnCoalitions().catch(() => null),
      cached ? cached.points : fetchCorrectionPoints().catch(() => null),
    ]);
    if (login && !cached && (coalitions || points)) {
      try {
        await chrome.storage.local.set({
          [CACHE_KEY]: { login, at: Date.now(), coalitions, points } satisfies CampusCache,
        });
      } catch {
        /* the card works without the cache */
      }
    }

    if (document.getElementById(CAMPUS_CARD_ID)) return;
    const profileCard = await waitForElement<HTMLElement>(PROFILE_CARD_SELECTOR, { timeoutMs: 2000 });
    if (!profileCard || document.getElementById(CAMPUS_CARD_ID)) return;
    const color =
      getComputedStyle(profileCard).getPropertyValue("--user-color").trim() || "#00babc";
    const card = buildCampusCard(
      { exam: events ? nextExam(events) : null, coalitions, points },
      color,
    );
    if (!card) return;
    place(card, profileCard);
    drawn = true;
  } finally {
    running = false;
  }
}
