/**
 * TIGs in the Agenda of your own dashboard: an "Add a TIG" link in the
 * Agenda's header, and one line per TIG to come above its events, so that
 * the reminder sits where the student looks for what is planned.
 *
 * The lines and the link are plain elements of the Intra's card (they take
 * its font and colours); the form is a dialog of our own.
 */
import { html, nothing, render } from "lit-html";
import { getConfig } from "../../core/config.ts";
import { intlLocale, t } from "../../core/i18n/i18n.ts";
import { sharedStylesLink } from "../../core/styles/shared-styles.ts";
import { getEffectiveTheme } from "../../core/theme/theme-manager.ts";
import { maybeSyncCalendar } from "./calendar-sync.ts";
import { isOwnProfilePage } from "./own-events.ts";
import {
  TIG_COLOR,
  TIG_NOTE_MAX,
  makeTig,
  readTigs,
  saveTigs,
  shownTigs,
  tigEnd,
  upcomingTigs,
  type Tig,
} from "./tig.ts";

const ADD_ID = "ft-tig-add";
const LIST_ID = "ft-tig-list";
const DIALOG_ID = "ft-tig-dialog";
const DAY_MS = 24 * 60 * 60_000;

const dayStart = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

/** "Today", "Tomorrow", or nothing for a TIG further away. */
export function tigSoon(tig: Tig, now = Date.now()): string {
  const days = Math.round((dayStart(Date.parse(tig.begin_at)) - dayStart(now)) / DAY_MS);
  return days <= 0 ? t("Today") : days === 1 ? t("Tomorrow") : "";
}

/** "Sat 29 Nov, 14:00 – 16:00" in the reader's language. */
export function tigWhen(tig: Tig): string {
  const locale = intlLocale("en-GB");
  const clock: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  const start = new Date(tig.begin_at);
  const day = start.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${start.toLocaleTimeString(locale, clock)} – ${new Date(tigEnd(tig)).toLocaleTimeString(locale, clock)}`;
}

async function afterChange(list: Tig[]): Promise<void> {
  drawAgendaList(list);
  // With a calendar link, the feed follows at once (no request without one).
  await maybeSyncCalendar();
}

/** Opens the list of your TIGs and the form that adds one. */
export async function openTigDialog(): Promise<void> {
  const theme = await getEffectiveTheme();
  let list = await readTigs();
  document.getElementById(DIALOG_ID)?.remove();

  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.setAttribute("aria-label", t("Your TIGs"));
  dialog.className = "bg-transparent backdrop:bg-black/50";
  dialog.style.cssText =
    "padding:0;border:none;border-radius:1rem;max-width:26rem;width:calc(100dvw - 2rem);";
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  dialog.appendChild(host);
  let error = "";

  const update = async (next: Tig[]) => {
    list = await saveTigs(next);
    draw();
    void afterChange(list).catch(() => {});
  };
  const add = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const tig = makeTig(
      String(data.get("date") ?? ""),
      String(data.get("time") ?? ""),
      Number(data.get("hours")),
      String(data.get("note") ?? ""),
    );
    error = tig ? "" : t("Pick a date, a start time and a number of hours.");
    if (!tig) return draw();
    form.reset();
    void update([...list, tig]);
  };

  function draw(): void {
    const coming = upcomingTigs(list);
    render(
      html`
        ${sharedStylesLink()}
        <div data-theme="${theme}" class="flex flex-col gap-3 rounded-2xl bg-base-100 p-4 text-base-content">
          <div class="flex items-start justify-between gap-2">
            <h2 class="text-lg font-bold">${t("Your TIGs")}</h2>
            <button
              class="btn btn-circle btn-ghost btn-sm"
              aria-label="${t("Close")}"
              @click="${() => dialog.close()}"
            >
              ✕
            </button>
          </div>
          ${coming.length === 0
            ? html`<p class="text-sm opacity-70">${t("No TIG planned.")}</p>`
            : html`<ul class="flex flex-col gap-1">
                ${coming.map(
                  (tig) => html`<li class="flex items-center justify-between gap-2 text-sm">
                    <span class="min-w-0">
                      <span class="font-semibold">${tigWhen(tig)}</span>
                      ${tig.note ? html`<span class="opacity-70"> · ${tig.note}</span>` : nothing}
                    </span>
                    <button
                      class="btn btn-ghost btn-xs"
                      @click="${() => void update(list.filter((other) => other.id !== tig.id))}"
                    >
                      ${t("Delete")}
                    </button>
                  </li>`,
                )}
              </ul>`}
          <form class="flex flex-col gap-2" @submit="${add}">
            <div class="flex flex-wrap gap-2">
              <label class="flex flex-1 flex-col gap-1 text-xs">
                ${t("Date")}
                <input class="input input-sm" type="date" name="date" required />
              </label>
              <label class="flex flex-col gap-1 text-xs">
                ${t("Start")}
                <input class="input input-sm" type="time" name="time" required />
              </label>
              <label class="flex w-20 flex-col gap-1 text-xs">
                ${t("Hours")}
                <input class="input input-sm" type="number" name="hours" min="0.5" max="24" step="0.5" value="2" required />
              </label>
            </div>
            <label class="flex flex-col gap-1 text-xs">
              ${t("Note (optional)")}
              <input class="input input-sm" type="text" name="note" maxlength="${TIG_NOTE_MAX}" />
            </label>
            ${error ? html`<p class="text-sm text-error" role="alert">${error}</p>` : nothing}
            <button class="btn btn-primary btn-sm self-end" type="submit">${t("Add")}</button>
          </form>
          <p class="text-xs opacity-70">
            ${t(
              "Kept in this browser. It shows in your Agenda and on your logtime calendar; with a calendar link, it is added to your calendar app with a reminder the day before.",
            )}
          </p>
        </div>
      `,
      shadow,
    );
  }

  draw();
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
}

/** The Agenda's header: the parent of its link to the events page. */
const agendaHeader = (): HTMLElement | null =>
  document.querySelector('a[href*="/events"]')?.parentElement ?? null;

function linkButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.style.cssText =
    "font:inherit;font-size:12px;font-weight:600;padding:2px 4px;border:0;background:transparent;color:inherit;opacity:.75;text-decoration:underline;cursor:pointer;white-space:nowrap;";
  button.addEventListener("click", () => void openTigDialog());
  return button;
}

/** One line per TIG to come, between the Agenda's header and its events. */
function drawAgendaList(list: Tig[]): void {
  const header = agendaHeader();
  if (!header) return;
  const coming = upcomingTigs(list);
  // What the lines say depends on the day too ("Tomorrow" becomes "Today").
  const signature = JSON.stringify([coming, dayStart(Date.now())]);
  let box = document.getElementById(LIST_ID);
  if (coming.length === 0) return box?.remove();
  if (box?.isConnected && box.dataset.sig === signature && box.previousElementSibling === header) return;
  box?.remove();
  box = document.createElement("div");
  box.id = LIST_ID;
  box.dataset.sig = signature;
  box.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:4px;";
  for (const tig of coming) {
    const row = linkButton();
    row.style.cssText += `display:block;text-align:left;text-decoration:none;opacity:1;white-space:normal;padding:6px 8px;border-left:3px solid ${TIG_COLOR};border-radius:4px;`;
    const soon = tigSoon(tig);
    const label = document.createElement("b");
    label.style.color = TIG_COLOR;
    label.textContent = soon ? `TIG · ${soon}` : "TIG";
    row.append(label, ` · ${tigWhen(tig)}${tig.note ? ` · ${tig.note}` : ""}`);
    box.appendChild(row);
  }
  header.after(box);
}

/**
 * Adds the link and the lines to the Agenda of your own dashboard. Called on
 * every pass of profile.ts: what React redraws comes back.
 */
export async function initTigAgenda(): Promise<void> {
  if (!isOwnProfilePage()) return;
  const header = agendaHeader();
  if (!header) return;
  if (!(await getConfig("CALENDAR_SHOW_TIG"))) {
    document.getElementById(ADD_ID)?.remove();
    document.getElementById(LIST_ID)?.remove();
    return;
  }
  if (!document.getElementById(ADD_ID)) {
    const add = linkButton();
    add.id = ADD_ID;
    add.textContent = t("Add a TIG");
    header.appendChild(add);
  }
  drawAgendaList(await shownTigs());
}
