/**
 * The Cloud account block of the Advanced tab: the browsers signed in to the
 * account, with a way to sign out the others, and Download my cloud data.
 * Nothing is asked of the server before a click: the hub opens often, and
 * these are looked at rarely. Texts are few and short, most of them already
 * in the catalog: content.js carries every one twice (English and French).
 */
import { html, nothing, render } from "lit-html";
import { getLang, intlLocale, t } from "../../../core/i18n/i18n.ts";
import {
  fetchCloudExport,
  listCloudSessions,
  signOutOtherBrowsers,
  type AccountCallFailure,
  type CloudSession,
} from "../../account/cloud-account.ts";
import type { HubSettingDef } from "../hubSettings.data.ts";
import { settingIds } from "./context.ts";

/** What went wrong, in the reader's language. */
export function accountCallFailureText(reason: AccountCallFailure): string {
  if (reason === "auth") return t("Sign in with 42");
  if (reason === "network") return t("Connection Failed");
  if (reason === "busy") return t("Too many requests");
  if (reason === "missing") return t("Not available on this server yet.");
  return t("Unknown error.");
}

const failed = (reason: AccountCallFailure) =>
  html`<p class="text-error">${accountCallFailureText(reason)}</p>`;

function day(at: number): string {
  return new Date(at).toLocaleDateString(getLang() === "fr" ? intlLocale() : [], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function sessionList(sessions: CloudSession[], out: HTMLElement) {
  return html`<p class="font-semibold">${t("Sign-ins")} ${sessions.length}/10</p>
    <ul class="list-disc ps-5">
      ${sessions.map(
        (s) =>
          html`<li class="${s.current ? "font-semibold" : ""}">
            ${s.current ? t("This browser") : t("Another browser")}
            ${s.createdAt === null ? nothing : `(${day(s.createdAt)})`}
          </li>`,
      )}
    </ul>
    ${sessions.some((s) => !s.current)
      ? html`<button
          type="button"
          class="btn btn-sm btn-warning font-bold"
          @click="${() => void signOutOthers(out)}"
        >
          ${t("Sign out my other browsers")}
        </button>`
      : nothing}`;
}

/** Lists the signed-in browsers in `out`, the card's status area. */
export async function showCloudSessions(out: HTMLElement): Promise<void> {
  const result = await listCloudSessions();
  render(result.ok ? sessionList(result.sessions, out) : failed(result.reason), out);
}

/**
 * Asks first: a browser signed out this way needs a new sign-in. The list
 * drawn again afterwards is the outcome (only this browser left). The button
 * that had the focus is gone with it: the focus goes back to Show, not to
 * the top of the page.
 */
export async function signOutOthers(
  out: HTMLElement,
  ask: (message: string) => boolean = (m) => window.confirm(m),
): Promise<void> {
  if (!ask(t("Sign out your other browsers? This one stays signed in."))) return;
  const result = await signOutOtherBrowsers();
  if (result.ok) await showCloudSessions(out);
  else render(failed(result.reason), out);
  (out.previousElementSibling as HTMLElement | null)?.focus();
}

/**
 * Downloads the export as a file, like Backup's Export: a Blob and an
 * <a download>, no downloads permission.
 */
export async function downloadCloudData(out: HTMLElement): Promise<void> {
  const result = await fetchCloudExport();
  render(result.ok ? nothing : failed(result.reason), out);
  if (!result.ok) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  // the reader's date, like Backup's file (toISOString is UTC: yesterday's
  // date before 02:00 in Paris)
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  a.download = `cuter-intra-cloud-data-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The control of each card. Download is named by its card's label, which
 * holds the visible word; Show, and the list and button it brings, sit in a
 * group named by the card's label ("Show" alone says too little).
 */
export function renderCloudAccountAction(def: HubSettingDef) {
  const ids = settingIds(def);
  const sessions = def.actionType === "cloud-sessions";
  const run = async (e: Event) => {
    const button = e.currentTarget as HTMLButtonElement;
    const out = button.nextElementSibling as HTMLElement;
    button.disabled = true;
    await (sessions ? showCloudSessions(out) : downloadCloudData(out));
    button.disabled = false;
  };
  return html`<div
    class="flex flex-col gap-2 text-sm ${sessions ? "items-start" : "items-end"}"
    role="${sessions ? "group" : nothing}"
    aria-labelledby="${sessions ? ids.label : nothing}"
    aria-describedby="${sessions ? (ids.desc ?? nothing) : nothing}"
  >
    <button
      type="button"
      class="btn btn-sm btn-primary font-bold"
      aria-labelledby="${sessions ? nothing : ids.label}"
      aria-describedby="${sessions ? nothing : (ids.desc ?? nothing)}"
      @click="${run}"
    >
      ${sessions ? t("Show") : t("Download")}
    </button>
    <div role="status" class="flex flex-col items-start gap-1"></div>
  </div>`;
}
