import { SeatPos } from "./crop";
import { normalizeSeatId } from "./seats";
import { seatCluster } from "./helpers";
import type { DialogState } from "./context";
import { getLang, t, tp } from "../../../core/i18n/i18n.ts";

const PROFILE_BASE = "https://profile.intra.42.fr/users";

/** A clock time ("14:05"): French in French, else the browser's own format. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(getLang() === "fr" ? "fr-FR" : [], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface OccupancyEntry {
  host: string;
  login: string;
  cdn_uri: string;
  begin_at: string;
  end_at: string | null;
}

export type ActiveSortMode = "name" | "since";

export const ACTIVE_SORT_DEFAULT = {
  mode: "name",
  nameDir: "asc",
  sinceDir: "desc",
} as const;

/**
 * The viewer's friends (FRIENDS_LIST, lower case), set when the map opens:
 * their seats get a ring and they come first in the Active list. The map
 * used to treat them like everyone else.
 */
let mapFriends: ReadonlySet<string> = new Set();

export function setMapFriends(logins: unknown): void {
  mapFriends = new Set(
    (Array.isArray(logins) ? logins : [])
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.toLowerCase().trim())
      .filter(Boolean),
  );
}

export function isMapFriend(login: string): boolean {
  return mapFriends.has(login.toLowerCase());
}

export function sortActiveUsers(
  list: OccupancyEntry[],
  mode: ActiveSortMode,
  nameDir: "asc" | "desc",
  sinceDir: "asc" | "desc",
): OccupancyEntry[] {
  return [...list].sort((a, b) => {
    const friendA = isMapFriend(a.login);
    if (friendA !== isMapFriend(b.login)) return friendA ? -1 : 1;
    if (mode === "since") {
      const at = new Date(a.begin_at).getTime();
      const bt = new Date(b.begin_at).getTime();
      const diff = at - bt;
      const result = sinceDir === "asc" ? diff : -diff;
      return result || a.login.localeCompare(b.login);
    }
    const cmp = a.login.localeCompare(b.login);
    return nameDir === "asc" ? cmp : -cmp;
  });
}

export function renderSeatOverlays(
  shadow: ShadowRoot,
  occupancy: Map<string, OccupancyEntry>,
  seatPosCache: Map<string, SeatPos>,
  svgViewBox: { w: number; h: number },
) {
  const mapArea = shadow.getElementById("map-area");
  if (!mapArea) return;
  const svgEl = mapArea.querySelector("svg");
  if (!svgEl) return;

  const oldOverlay = shadow.getElementById("seat-overlay");
  // The poll redraws every minute: the link and the picture of someone still
  // at the same seat are kept, instead of every avatar of the cluster being
  // created and decoded again.
  const kept = new Map<string, HTMLAnchorElement>();
  for (const a of oldOverlay?.querySelectorAll<HTMLAnchorElement>("a.seat-link") ?? []) {
    kept.set(`${a.dataset.host}|${a.dataset.login}`, a);
  }
  if (oldOverlay) oldOverlay.remove();

  const svgRect = svgEl.getBoundingClientRect();
  if (svgRect.width === 0 || svgRect.height === 0) return;
  const mapRect = mapArea.getBoundingClientRect();
  const scrollLeft = mapArea.scrollLeft;
  const scrollTop = mapArea.scrollTop;

  const vb = (svgEl.getAttribute("viewBox") || "0 0 1200 800")
    .split(/\s+/)
    .map(Number);
  const vbW = vb[2] || svgRect.width;
  const vbH = vb[3] || svgRect.height;
  const offsetX = vb[0] || 0;
  const offsetY = vb[1] || 0;
  const scaleX = svgRect.width / vbW;
  const scaleY = svgRect.height / vbH;

  const svgById = new Map<string, Element>();
  for (const el of svgEl.querySelectorAll("[id]")) {
    const key = normalizeSeatId(el.getAttribute("id")!);
    if (!svgById.has(key)) svgById.set(key, el);
  }

  interface OverlayEntry {
    host: string;
    seat: OccupancyEntry;
    left: number;
    top: number;
    width: number;
    height: number;
    rotationDeg: number;
    round: boolean;
  }
  const entries: OverlayEntry[] = [];

  for (const [host, seat] of occupancy) {
    const hostKey = normalizeSeatId(host);
    const pos = seatPosCache.get(hostKey);
    if (!pos) continue;

    let left: number, top: number, width: number, height: number;
    let rotationDeg = 0;
    let round = false;
    const svgSeat = svgById.get(hostKey);
    if (svgSeat) {
      round =
        svgSeat.tagName.toLowerCase() === "circle" ||
        (svgSeat.getAttribute("clip-path") || "").includes("circle");
      const rect = svgSeat.getBoundingClientRect();
      const w = pos.w * scaleX;
      const h = pos.h * scaleY;
      left = rect.left + rect.width / 2 - mapRect.left - w / 2 + scrollLeft;
      top = rect.top + rect.height / 2 - mapRect.top - h / 2 + scrollTop;
      width = w;
      height = h;
      let netRotation = 0;
      let el: Element | null = svgSeat;
      while (el && el !== svgEl) {
        const tr = el.getAttribute("transform");
        if (tr) {
          const m = tr.match(/rotate\(\s*([\d.-]+)/);
          if (m) netRotation += parseFloat(m[1]) || 0;
        }
        el = el.parentElement;
      }
      rotationDeg = netRotation;
    } else {
      left = (pos.x - offsetX) * scaleX;
      top = (pos.y - offsetY) * scaleY;
      width = pos.w * scaleX;
      height = pos.h * scaleY;
    }
    entries.push({
      host: hostKey,
      seat,
      left,
      top,
      width,
      height,
      rotationDeg,
      round,
    });
  }

  const overlay = document.createElement("div");
  overlay.id = "seat-overlay";
  overlay.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";

  const frag = document.createDocumentFragment();
  for (const {
    host,
    seat,
    left,
    top,
    width,
    height,
    rotationDeg,
    round,
  } of entries) {
    const timeStr = clockTime(seat.begin_at);

    const reused = kept.get(`${host}|${seat.login}`);
    const a =
      reused ??
      Object.assign(document.createElement("a"), {
        href: `${PROFILE_BASE}/${seat.login}`,
        target: "_blank",
        rel: "noopener noreferrer",
      });
    a.className = "seat-link";
    a.style.cssText = [
      "pointer-events:auto;",
      `left:${left}px;top:${top}px;`,
      `width:${width}px;height:${height}px;`,
      rotationDeg !== 0 ? `transform:rotate(${rotationDeg}deg);` : "",
      round ? "border-radius:50%;" : "",
    ].join("");
    if (round) a.dataset.round = "true";
    else delete a.dataset.round;
    a.dataset.host = host;
    a.dataset.login = seat.login;
    const friend = isMapFriend(seat.login);
    if (friend) a.classList.add("is-friend");
    a.setAttribute(
      "data-tip",
      `${friend ? "★ " : ""}${t("{login} - since {time}", { login: seat.login, time: timeStr })}`,
    );
    a.setAttribute("data-tip-size", "15px");

    let avatar = a.querySelector("img");
    if (!avatar) {
      avatar = Object.assign(document.createElement("img"), { alt: seat.login });
      a.appendChild(avatar);
    }
    // only a new address loads again
    if (avatar.getAttribute("src") !== seat.cdn_uri) avatar.src = seat.cdn_uri;
    avatar.style.borderRadius = round ? "50%" : "";
    frag.appendChild(a);
  }
  overlay.appendChild(frag);
  mapArea.appendChild(overlay);
}

/**
 * The people the Active list shows for the search box's text: the logins
 * that contain it, whatever the case. Applied when the list is drawn, never
 * stored in state.activeUsers: the 60 s poll rebuilds that list, and the tab's
 * count and the "{n} active" badge read it to count everyone.
 */
export function filterActiveUsers(
  users: OccupancyEntry[],
  query: string | undefined,
): OccupancyEntry[] {
  const q = (query ?? "").trim().toLowerCase();
  return q ? users.filter((u) => u.login.toLowerCase().includes(q)) : users;
}

/**
 * Where a card says the person sits. A seat whose cluster has a map is a
 * button that opens it there (map-dialog.ts handles `data-jump-seat`); a
 * Wi-Fi host or a seat on no map is plain text, so it does not look like a
 * link. The card used to show no seat at all: finding someone meant opening
 * every cluster tab and scanning the avatars.
 */
function seatChip(state: DialogState, host: string): HTMLElement {
  if (host.startsWith("wifi-")) {
    const wifi = document.createElement("span");
    wifi.className = "seat-chip";
    wifi.textContent = "Wi-Fi";
    return wifi;
  }
  if (!seatCluster(state.clusters, host)) {
    const plain = document.createElement("span");
    plain.className = "seat-chip";
    plain.textContent = host;
    return plain;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "seat-chip";
  button.dataset.jumpSeat = host;
  button.textContent = host;
  const label = t("View {seat} on cluster map", { seat: host });
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  return button;
}

/**
 * The search's result count for screen readers (the list itself is not a
 * live region). Written only when it changes: the poll redraws the list every
 * minute, and the same count must not be read out again each time.
 */
function announceMatches(state: DialogState, query: string, count: number) {
  const status = state.shadow.getElementById("active-search-status");
  if (!status) return;
  const text = query ? tp(count, "{n} match", "{n} matches") : "";
  if (status.textContent !== text) status.textContent = text;
}

/**
 * The Active tab: everyone connected on the campus (or on Wi-Fi only, whose
 * empty state says so), filtered by the search box, each with their seat.
 */
export function renderActiveList(state: DialogState) {
  const mapArea = state.shadow.getElementById("map-area");
  if (!mapArea) return;
  mapArea.style.position = "";

  const query = (state.activeQuery ?? "").trim();
  const users = filterActiveUsers(state.activeUsers, query);
  announceMatches(state, query, users.length);

  if (users.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className =
      "flex items-center justify-center p-12 text-center text-base-content/50";
    emptyDiv.textContent =
      query && state.activeUsers.length > 0
        ? t("No login matches “{query}”", { query })
        : t(
            state.activeWifiOnly
              ? "No one on Wi-Fi right now"
              : "No one connected",
          );
    mapArea.replaceChildren(emptyDiv);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "active-grid";

  for (const user of users) {
    // A <div>, not a link: the seat button sits next to the profile link
    // rather than inside it (a button inside a link is not valid HTML, and a
    // click on it would open the profile too).
    const card = document.createElement("div");
    card.className = "active-card";

    const link = Object.assign(document.createElement("a"), {
      href: `${PROFILE_BASE}/${user.login}`,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "active-card-link",
    });

    const avatar = Object.assign(document.createElement("img"), {
      src: user.cdn_uri,
      alt: user.login,
    });
    const friend = isMapFriend(user.login);
    if (friend) card.dataset.friend = "true";

    const login = document.createElement("span");
    login.className = "active-card-login";
    login.textContent = friend ? `★ ${user.login}` : user.login;
    link.append(avatar, login);

    const since = document.createElement("span");
    since.className = "badge badge-sm";
    since.textContent = formatTimeAgo(new Date(user.begin_at).getTime());
    since.style.cssText = [
      "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      "background:#fff;color:#000;border-color:#fff;",
    ].join("");
    since.setAttribute(
      "data-tip",
      t("since {time}", { time: clockTime(user.begin_at) }),
    );

    const meta = document.createElement("div");
    meta.className = "active-card-meta";
    meta.append(seatChip(state, user.host), since);

    card.append(link, meta);
    grid.appendChild(card);
  }
  const refocus = focusedCardControl(state, mapArea);
  mapArea.replaceChildren(grid);
  if (refocus)
    grid.querySelector<HTMLElement>(refocus)?.focus({ preventScroll: true });
}

/**
 * The card link or seat button that has focus, as a selector for the same
 * control in the redrawn list. The 60 s poll redraws the whole list: a
 * keyboard user tabbing through the cards was sent back to the top of the
 * page every minute.
 */
function focusedCardControl(
  state: DialogState,
  mapArea: HTMLElement,
): string | null {
  const el = state.shadow.activeElement;
  if (!(el instanceof HTMLElement) || !mapArea.contains(el)) return null;
  const seat = el.dataset.jumpSeat;
  if (seat) return `[data-jump-seat="${CSS.escape(seat)}"]`;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
  return href ? `.active-card-link[href="${CSS.escape(href)}"]` : null;
}

export function formatTimeAgo(ts: number): string {
  const secs = (Date.now() - ts) / 1000;
  if (secs < 3) return t("now");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("{m}m", { m: mins });
  return t("{h}h", { h: Math.round(mins / 60) });
}
