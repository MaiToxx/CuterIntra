/**
 * "Who's going": who is registered to an event, shown inside the event.
 *
 * - On the dashboard, each event card of the Agenda gets a small "Who's
 *   going" link that opens the list for that event.
 * - On the page of an event (profile.intra.42.fr/events/<id>) the list is
 *   drawn directly under the event.
 *
 * The Intra shows a count only. The list comes from the worker's 42
 * application (GET /api/v1/private/events/attendees, announced by /features
 * as `eventAttendees`): signed in only, an event of your own campus only,
 * three fields per person, nothing stored (see the worker's handlers/event-attendees.ts and PRIVACY.md).
 *
 * The Agenda's cards are the Intra's markup and carry no event id unless
 * they link to the event: a card is otherwise matched by name with your own
 * Intra events (read in the browser as for the logtime calendar). Exams have
 * ids of their own and are left out.
 */
import { html, nothing, render } from "lit-html";
import { getConfig } from "../../../../core/config.ts";
import { intlLocale, t } from "../../../../core/i18n/i18n.ts";
import { sharedStylesLink } from "../../../../core/styles/shared-styles.ts";
import { getEffectiveTheme } from "../../../../core/theme/theme-manager.ts";
import { workerFetch } from "../../../../core/worker.ts";
import { fetchOwnEvents } from "../../../calendar/own-events.ts";
import { getFriendsList } from "../../../friends/friends.ts";
import type { CalendarEvent } from "../../../logtime/types.ts";
import { cdnImage, ownSession } from "../evaluations-api.ts";

const LINK_CLASS = "ft-attendees-link";
const DIALOG_ID = "ft-attendees-dialog";
const PAGE_PANEL_ID = "ft-attendees-panel";
/** The Agenda's event cards (the selector the type filter uses too). */
const CARD_SELECTOR = "div.relative.clear-both.m-1.border.rounded";
/** As on the worker: an event stays listed a day after its end. */
const AFTER_END_MS = 24 * 60 * 60_000;
/** How long your events serve the card matching before a new read. */
const EVENTS_FRESH_MS = 5 * 60_000;

export interface Attendee {
  login: string;
  name: string;
  imageUrl: string | null;
}

export type AttendeesResult =
  | { ok: true; attendees: Attendee[]; more: boolean }
  | { ok: false; reason: "signed-out" | "over" | "busy" | "failed" };

/** What the list needs to know about the event it is drawn for. */
export interface EventRef {
  id: number;
  name?: string;
  begin_at?: string;
}

/** Who is registered to `eventId`, from the worker. */
export async function fetchEventAttendees(eventId: number): Promise<AttendeesResult> {
  const session = await ownSession(undefined, "eventAttendees");
  if (!session) return { ok: false, reason: "signed-out" };
  // `user`: the worker only answers for an event of one of your own campuses.
  const user = encodeURIComponent(session.login.toLowerCase());
  const res = await workerFetch(`/api/v1/private/events/attendees?user=${user}&event=${eventId}`, {
    auth: session,
    timeoutMs: 15_000,
  });
  const body = res.json as { attendees?: unknown; more?: unknown } | null;
  if (!res.ok || !Array.isArray(body?.attendees)) {
    if (res.status === 404) return { ok: false, reason: "over" };
    return { ok: false, reason: res.status === 429 ? "busy" : "failed" };
  }
  const attendees: Attendee[] = [];
  for (const a of body.attendees as Record<string, unknown>[]) {
    if (!a || typeof a.login !== "string" || !/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(a.login)) continue;
    attendees.push({
      login: a.login,
      name: typeof a.name === "string" ? a.name.slice(0, 80) : a.login,
      imageUrl: cdnImage(a.imageUrl),
    });
  }
  return { ok: true, attendees, more: body.more === true };
}

const asDate = (iso: string): Date => new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);

/** The events one can still ask about, soonest first; exams left out. */
export function listableEvents(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  return events
    .filter((e) => {
      if (e.kind === "exam" || !Number.isInteger(e.id) || e.id <= 0) return false;
      const end = asDate(e.end_at || e.begin_at).getTime();
      return Number.isFinite(end) && now - end <= AFTER_END_MS;
    })
    .sort((a, b) => asDate(a.begin_at).getTime() - asDate(b.begin_at).getTime());
}

/** Friends first, then by login. */
export function orderAttendees(attendees: Attendee[], friends: ReadonlySet<string>): Attendee[] {
  return [...attendees].sort(
    (a, b) =>
      Number(friends.has(b.login)) - Number(friends.has(a.login)) || a.login.localeCompare(b.login),
  );
}

/** The event id a card or one of its links points to, if any. */
export function linkedEventId(el: Element): number | null {
  const link = el.closest('a[href*="/events/"]') ?? el.querySelector('a[href*="/events/"]');
  const id = Number(/\/events\/(\d+)/.exec(link?.getAttribute("href") ?? "")?.[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const normal = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The events a card's text can stand for: those bearing the longest event
 * name the text contains, in the order of `events` (soonest first). Several
 * when an event repeats under one name (a weekly talk): the caller tells
 * them apart by the order of the cards.
 */
export function matchEvents(text: string, events: CalendarEvent[]): CalendarEvent[] {
  const hay = normal(text);
  let best = "";
  for (const e of events) {
    const name = normal(e.name);
    if (name.length >= 3 && name.length > best.length && hay.includes(name)) best = name;
  }
  return best ? events.filter((e) => normal(e.name) === best) : [];
}

function when(iso: string): string {
  return asDate(iso).toLocaleString(intlLocale("en-GB"), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const failureText = (reason: Extract<AttendeesResult, { ok: false }>["reason"]): string =>
  reason === "over"
    ? t("This event is over.")
    : reason === "busy"
      ? t("Too many requests for now. Try again in a few minutes.")
      : reason === "signed-out"
        ? t("Sign in to see who is going.")
        : t("Couldn't load the list. Try again later.");

function attendeeRow(a: Attendee, friend: boolean) {
  return html`
    <li>
      <a
        class="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-base-200"
        href="https://profile-v3.intra.42.fr/users/${a.login}"
        target="_blank"
        rel="noopener noreferrer"
      >
        ${a.imageUrl
          ? html`<img
              class="h-9 w-9 shrink-0 rounded-full object-cover"
              src="${a.imageUrl}"
              alt=""
              loading="lazy"
            />`
          : html`<span class="h-9 w-9 shrink-0 rounded-full bg-base-300"></span>`}
        <span class="min-w-0 flex-1">
          <span class="block truncate font-semibold">${a.login}</span>
          <span class="block truncate text-xs opacity-70">${a.name}</span>
        </span>
        ${friend
          ? html`<span class="badge badge-primary badge-sm shrink-0" data-friend>${t("Friend")}</span>`
          : nothing}
      </a>
    </li>
  `;
}

/** The list itself: loading, failure, nobody, or the people. */
function listView(result: AttendeesResult | null, friends: ReadonlySet<string>) {
  if (!result) {
    return html`<div class="skeleton h-24 w-full" role="status" aria-label="${t("Loading")}"></div>`;
  }
  if (!result.ok) {
    return html`<p class="text-sm text-error" role="alert">${failureText(result.reason)}</p>`;
  }
  const list = orderAttendees(result.attendees, friends);
  if (list.length === 0) {
    return html`<p class="text-sm opacity-70">${t("Nobody is registered yet.")}</p>`;
  }
  const friendCount = list.filter((a) => friends.has(a.login)).length;
  return html`
    <p class="text-sm font-semibold" data-count>
      ${t("{n} registered", { n: list.length })}${friendCount > 0
        ? ` · ${t("{n} of your friends", { n: friendCount })}`
        : ""}
    </p>
    <ul class="flex max-h-96 flex-col overflow-y-auto">
      ${list.map((a) => attendeeRow(a, friends.has(a.login)))}
    </ul>
    ${result.more
      ? html`<p class="text-xs opacity-70">${t("Only the first 300 are listed.")}</p>`
      : nothing}
  `;
}

/**
 * Loads the list of `eventId` and calls `draw` each time something arrived
 * (the friends, then the people), until `alive` says the view is gone.
 */
function loadList(
  eventId: number,
  alive: () => boolean,
  draw: (result: AttendeesResult | null, friends: ReadonlySet<string>) => void,
): void {
  let result: AttendeesResult | null = null;
  let friends: ReadonlySet<string> = new Set();
  draw(result, friends);
  void getFriendsList()
    .then((list) => {
      friends = new Set(list.map((l) => String(l).toLowerCase()));
      if (result && alive()) draw(result, friends);
    })
    .catch(() => {});
  void fetchEventAttendees(eventId)
    .catch((): AttendeesResult => ({ ok: false, reason: "failed" }))
    .then((answer) => {
      result = answer;
      if (alive()) draw(result, friends);
    });
}

/** Opens the list of one event; resolves once the dialog is on screen. */
export async function openAttendeesDialog(event: EventRef): Promise<void> {
  const theme = await getEffectiveTheme();
  // After the await, so that two quick clicks never leave two dialogs.
  document.getElementById(DIALOG_ID)?.remove();

  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.setAttribute("aria-label", event.name || t("Who's going"));
  dialog.className = "bg-transparent backdrop:bg-black/50";
  dialog.style.cssText =
    "padding:0;border:none;border-radius:1rem;max-width:28rem;width:calc(100dvw - 2rem);";
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  dialog.appendChild(host);

  const draw = (result: AttendeesResult | null, friends: ReadonlySet<string>) =>
    render(
      html`
        ${sharedStylesLink()}
        <div data-theme="${theme}" class="flex flex-col gap-3 rounded-2xl bg-base-100 p-4 text-base-content">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 class="text-lg font-bold">${event.name || t("Who's going")}</h2>
              ${event.begin_at
                ? html`<p class="text-xs opacity-70">${when(event.begin_at)}</p>`
                : nothing}
            </div>
            <button
              class="btn btn-circle btn-ghost btn-sm"
              aria-label="${t("Close")}"
              @click="${() => dialog.close()}"
            >
              ✕
            </button>
          </div>
          ${listView(result, friends)}
        </div>
      `,
      shadow,
    );

  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  loadList(event.id, () => dialog.isConnected, draw);
}

/**
 * The switch, the session and the worker's route. A yes is kept for the
 * page; a no is asked again after RETRY_MS: it may come from a /features
 * read that timed out, or from a student who has signed in since, and kept
 * for good it hid the feature until the page was reloaded.
 */
const RETRY_MS = 60_000;
let allowed: { at: number; answer: Promise<boolean> } | null = null;
function isAllowed(): Promise<boolean> {
  if (!allowed) {
    const entry = {
      at: Date.now(),
      answer: (async () =>
        !!(await getConfig("PROFILE_SHOW_EVENT_ATTENDEES")) &&
        !!(await ownSession(undefined, "eventAttendees")))().catch(() => false),
    };
    allowed = entry;
    void entry.answer.then((yes) => {
      if (yes) entry.at = Infinity;
    });
  } else if (Date.now() - allowed.at >= RETRY_MS) {
    allowed = null;
    return isAllowed();
  }
  return allowed.answer;
}

let ownEvents: { at: number; list: Promise<CalendarEvent[]> } | null = null;
function listableOwnEvents(): Promise<CalendarEvent[]> {
  if (!ownEvents || Date.now() - ownEvents.at > EVENTS_FRESH_MS) {
    const list = fetchOwnEvents()
      .catch(() => null)
      .then((events) => {
        // A failed read is kept a minute only, not asked again on every
        // pass: with intrapy down that was one request per redraw.
        if (!events && ownEvents?.list === list) ownEvents.at = Date.now() - EVENTS_FRESH_MS + RETRY_MS;
        return listableEvents(events ?? []);
      });
    ownEvents = { at: Date.now(), list };
  }
  return ownEvents.list;
}

function cardLink(event: EventRef): HTMLButtonElement {
  const link = document.createElement("button");
  link.type = "button";
  link.id = `ft-attendees-link-${event.id}`;
  link.className = LINK_CLASS;
  link.textContent = t("Who's going");
  link.style.cssText =
    "position:absolute;right:8px;bottom:4px;z-index:1;font:inherit;font-size:11px;font-weight:600;line-height:1.2;padding:2px 4px;border:0;background:transparent;color:inherit;opacity:.75;text-decoration:underline;cursor:pointer;";
  link.addEventListener("click", (e) => {
    // the card itself opens the event
    e.preventDefault();
    e.stopPropagation();
    void openAttendeesDialog(event);
  });
  return link;
}

/**
 * Adds the "Who's going" link to the Agenda's event cards on your own
 * dashboard. Called on every pass of profile.ts, so a card React redraws
 * gets its link back.
 */
export async function initEventAttendees(): Promise<void> {
  if (location.hostname !== "profile-v3.intra.42.fr" || location.pathname !== "/") return;
  const cards = () => [...document.querySelectorAll<HTMLElement>(CARD_SELECTOR)];
  const bare = (card: HTMLElement) => !card.querySelector(`.${LINK_CLASS}`);
  if (!cards().some(bare)) return;
  if (!(await isAllowed())) return;
  // The Agenda lists what is coming: an event that ended is not one of its cards.
  const now = Date.now();
  const events = (await listableOwnEvents()).filter(
    (e) => !(asDate(e.end_at || e.begin_at).getTime() < now),
  );
  // Cards of one name are taken in page order, events in date order: the
  // second card of a weekly talk is its second date, not the first again.
  const seen = new Map<string, number>();
  for (const card of cards()) {
    const id = linkedEventId(card);
    let event: EventRef | null = null;
    if (id !== null) {
      event = events.find((e) => e.id === id) ?? { id };
    } else {
      const text = [...card.childNodes]
        .filter((n) => !(n instanceof Element && n.classList.contains(LINK_CLASS)))
        .map((n) => n.textContent ?? "")
        .join(" ");
      const same = matchEvents(text, events);
      if (same.length > 0) {
        const name = normal(same[0].name);
        const rank = seen.get(name) ?? 0;
        seen.set(name, rank + 1);
        event = same[rank] ?? null;
      }
    }
    if (event && bare(card)) card.appendChild(cardLink(event));
  }
}

/**
 * On the page of an event (profile.intra.42.fr/events/<id>): the list, drawn
 * under the event. Nothing for an event that is over or when signed out.
 */
export async function initEventPageAttendees(): Promise<void> {
  if (location.hostname !== "profile.intra.42.fr") return;
  const id = Number(/^\/events\/(\d{1,10})\/?$/.exec(location.pathname)?.[1]);
  if (!Number.isInteger(id) || id <= 0 || document.getElementById(PAGE_PANEL_ID)) return;
  if (!(await isAllowed())) return;
  const theme = await getEffectiveTheme();
  const parent = document.querySelector(".page-content, main") ?? document.body;
  if (!parent || document.getElementById(PAGE_PANEL_ID)) return;

  const host = document.createElement("div");
  host.id = PAGE_PANEL_ID;
  host.style.cssText = "display:block;max-width:32rem;margin:16px auto;padding:0 12px;";
  const shadow = host.attachShadow({ mode: "open" });
  parent.appendChild(host);

  loadList(
    id,
    () => host.isConnected,
    (result, friends) => {
      if (result && !result.ok && (result.reason === "over" || result.reason === "signed-out")) {
        host.remove();
        return;
      }
      render(
        html`
          ${sharedStylesLink()}
          <div data-theme="${theme}" class="flex flex-col gap-3 rounded-2xl bg-base-100 p-4 text-base-content">
            <h2 class="text-lg font-bold">${t("Who's going")}</h2>
            ${listView(result, friends)}
          </div>
        `,
        shadow,
      );
    },
  );
}
