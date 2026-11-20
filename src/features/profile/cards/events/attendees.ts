/**
 * "Who's going": a button in the dashboard's Agenda card that lists the
 * coming events and, for the one you pick, who is registered.
 *
 * The Intra shows a count only. The list comes from the worker's 42
 * application (GET /api/v1/private/events/attendees, announced by /features
 * as `eventAttendees`): signed in only, three fields per person, nothing
 * stored (see the worker's handlers/event-attendees.ts and PRIVACY.md). The
 * events themselves are your own Intra events, read in the browser as for
 * the logtime calendar; exams have ids of their own and are left out.
 *
 * Everything is drawn in our own dialog rather than inside the Agenda's
 * cards: their markup is the Intra's and carries no event id.
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

const BUTTON_ID = "ft-attendees-button";
const DIALOG_ID = "ft-attendees-dialog";
/** As on the worker: an event stays listed a day after its end. */
const AFTER_END_MS = 24 * 60 * 60_000;

export interface Attendee {
  login: string;
  name: string;
  imageUrl: string | null;
}

export type AttendeesResult =
  | { ok: true; attendees: Attendee[]; more: boolean }
  | { ok: false; reason: "signed-out" | "over" | "busy" | "failed" };

/** Who is registered to `eventId`, from the worker. */
export async function fetchEventAttendees(eventId: number): Promise<AttendeesResult> {
  const session = await ownSession(undefined, "eventAttendees");
  if (!session) return { ok: false, reason: "signed-out" };
  const res = await workerFetch(`/api/v1/private/events/attendees?event=${eventId}`, {
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

function when(event: CalendarEvent): string {
  return asDate(event.begin_at).toLocaleString(intlLocale("en-GB"), {
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

interface DialogState {
  events: CalendarEvent[] | null;
  selected: CalendarEvent | null;
  result: AttendeesResult | null;
  friends: ReadonlySet<string>;
}

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
          <span class="block truncate font-semibold">${friend ? "★ " : ""}${a.login}</span>
          <span class="block truncate text-xs opacity-70">${a.name}</span>
        </span>
      </a>
    </li>
  `;
}

function attendeesView(state: DialogState, back: () => void) {
  const event = state.selected!;
  const result = state.result;
  const list = result?.ok ? orderAttendees(result.attendees, state.friends) : [];
  const friendCount = list.filter((a) => state.friends.has(a.login)).length;
  return html`
    <button class="btn btn-ghost btn-sm self-start" @click="${back}">← ${t("All events")}</button>
    <div>
      <h3 class="font-bold text-base">${event.name}</h3>
      <p class="text-xs opacity-70">${when(event)}</p>
    </div>
    ${!result
      ? html`<div class="skeleton h-24 w-full" role="status" aria-label="${t("Loading")}"></div>`
      : !result.ok
        ? html`<p class="text-sm text-error" role="alert">${failureText(result.reason)}</p>`
        : list.length === 0
          ? html`<p class="text-sm opacity-70">${t("Nobody is registered yet.")}</p>`
          : html`
              <p class="text-sm font-semibold" data-count>
                ${t("{n} registered", { n: list.length })}${friendCount > 0
                  ? ` · ${t("{n} of your friends", { n: friendCount })}`
                  : ""}
              </p>
              <ul class="flex max-h-96 flex-col overflow-y-auto">
                ${list.map((a) => attendeeRow(a, state.friends.has(a.login)))}
              </ul>
              ${result.more
                ? html`<p class="text-xs opacity-70">${t("Only the first 300 are listed.")}</p>`
                : nothing}
            `}
  `;
}

function eventsView(state: DialogState, pick: (event: CalendarEvent) => void) {
  if (!state.events) {
    return html`<div class="skeleton h-24 w-full" role="status" aria-label="${t("Loading")}"></div>`;
  }
  if (state.events.length === 0) {
    return html`<p class="text-sm opacity-70">${t("No coming event.")}</p>`;
  }
  return html`
    <p class="text-sm opacity-70">${t("Pick an event to see who is registered.")}</p>
    <ul class="flex max-h-96 flex-col gap-1 overflow-y-auto">
      ${state.events.map(
        (event) => html`
          <li>
            <button
              class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-200"
              data-event="${event.id}"
              @click="${() => pick(event)}"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold">${event.name}</span>
                <span class="block truncate text-xs opacity-70">${when(event)}</span>
              </span>
              ${event.is_subscribed
                ? html`<span class="badge badge-success badge-sm shrink-0">${t("Registered")}</span>`
                : nothing}
            </button>
          </li>
        `,
      )}
    </ul>
  `;
}

/** Opens the dialog; resolves once it is on screen (its lists load after). */
export async function openAttendeesDialog(): Promise<void> {
  document.getElementById(DIALOG_ID)?.remove();
  const theme = await getEffectiveTheme();

  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.className = "bg-transparent backdrop:bg-black/50";
  dialog.style.cssText =
    "padding:0;border:none;border-radius:1rem;max-width:28rem;width:calc(100dvw - 2rem);";
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  dialog.appendChild(host);

  const state: DialogState = { events: null, selected: null, result: null, friends: new Set() };
  /** Counts the picks, so that a slow answer never lands under another event. */
  let request = 0;

  const draw = () =>
    render(
      html`
        ${sharedStylesLink()}
        <div data-theme="${theme}" class="flex flex-col gap-3 rounded-2xl bg-base-100 p-4 text-base-content">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-lg font-bold">${t("Who's going")}</h2>
            <button
              class="btn btn-circle btn-ghost btn-sm"
              aria-label="${t("Close")}"
              @click="${() => dialog.close()}"
            >
              ✕
            </button>
          </div>
          ${state.selected ? attendeesView(state, back) : eventsView(state, pick)}
        </div>
      `,
      shadow,
    );

  const back = () => {
    request++;
    state.selected = null;
    state.result = null;
    draw();
  };
  const pick = (event: CalendarEvent) => {
    const mine = ++request;
    state.selected = event;
    state.result = null;
    draw();
    void fetchEventAttendees(event.id)
      .catch((): AttendeesResult => ({ ok: false, reason: "failed" }))
      .then((result) => {
        if (mine !== request || !dialog.isConnected) return;
        state.result = result;
        draw();
      });
  };

  draw();
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());

  void getFriendsList()
    .then((list) => {
      state.friends = new Set(list.map((l) => String(l).toLowerCase()));
    })
    .catch(() => {});
  void fetchOwnEvents()
    .catch(() => null)
    .then((events) => {
      if (!dialog.isConnected) return;
      state.events = listableEvents(events ?? []);
      draw();
    });
}

let checked = false;

/**
 * Adds the button to the Agenda card of your own dashboard. Called on every
 * pass of profile.ts: the worker is asked once per page whether it has the
 * route, and the button is put back when React redraws the card.
 */
export async function initEventAttendees(): Promise<void> {
  if (location.hostname !== "profile-v3.intra.42.fr" || location.pathname !== "/") return;
  const container = document.querySelector('a[href*="/events"]')?.parentElement;
  if (!container || document.getElementById(BUTTON_ID)) return;
  if (checked) return;
  checked = true;
  if (!(await getConfig("PROFILE_SHOW_EVENT_ATTENDEES"))) return;
  if (!(await ownSession(undefined, "eventAttendees"))) return;
  checked = false;
  if (!container.isConnected || document.getElementById(BUTTON_ID)) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = `👥 ${t("Who's going")}`;
  button.style.cssText =
    "font:inherit;font-size:12px;font-weight:600;padding:4px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;";
  button.addEventListener("click", () => void openAttendeesDialog());
  container.style.setProperty("display", "flex", "important");
  container.style.setProperty("align-items", "center", "important");
  container.style.setProperty("gap", "12px", "important");
  container.appendChild(button);
}
