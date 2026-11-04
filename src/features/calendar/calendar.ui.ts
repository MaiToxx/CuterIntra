import { html, render } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import {
  clearAuthFailed,
  forgetCloudCalendarLink,
  loginWith42,
} from "../account/account.ts";
import { generateQrDataUrl } from "./qr.ts";
import { maybeSyncCalendar } from "./calendar-sync.ts";
import CALENDAR_PLUS_SVG from "../../assets/svg/calendar-plus.svg?raw";
import COPY_SVG from "../../assets/svg/copy.svg?raw";

import {
  WORKER_URL,
  getWorkerFeatures,
  workerFetch,
  type WorkerResult,
} from "../../core/worker.ts";
import { msg, t } from "../../core/i18n/i18n.ts";
const TOKEN_KEY = "CALENDAR_SYNC_TOKEN";
const ALL_EVENTS_KEY = "CALENDAR_ALL_CAMPUS_EVENTS";
const EVALUATIONS_KEY = "CALENDAR_EVALUATIONS";

/**
 * The live link in the worker's answer to GET calendar/token: its token,
 * null when the login has no live link (never made, stopped, wiped), or
 * undefined when the answer says neither (no answer, an older worker's 405,
 * an error, a body without `token`). Only a URL-safe token is taken: it
 * goes into the feed URL and the QR code.
 */
export function liveLinkIn(res: WorkerResult): string | null | undefined {
  if (!res.ok || !res.json || typeof res.json !== "object") return undefined;
  const { token } = res.json as { token?: unknown };
  if (token === null) return null;
  return typeof token === "string" && /^[\w-]{8,200}$/.test(token) ? token : undefined;
}

/** msg(): shown with t(REGENERATE_CONFIRM) (module code runs before the language is known). */
export const REGENERATE_CONFIRM = msg(
  "Create a new calendar link? Calendars subscribed to the current link stop updating until you subscribe them to the new one.",
);

/** msg(): shown with t(STOP_SHARING_CONFIRM). */
export const STOP_SHARING_CONFIRM = msg(
  "Stop sharing your calendar? Calendars subscribed to this link stop updating, and the copy of your events on the Cuter Intra server is deleted.",
);

function calUrl(token: string): string {
  return `https://${WORKER_URL.replace("https://", "")}/calendar/${token}.ics`;
}

/** The same feed for the calendar app of the system (Apple Calendar, Outlook...). */
export function webcalUrl(token: string): string {
  return calUrl(token).replace(/^https:/, "webcal:");
}

/** Google Calendar's "add by URL" page with the feed already filled in. */
export function googleCalendarUrl(token: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(token))}`;
}

/** What a failed link request tells the student, by status (0: no answer). */
export function generateError(status: number): string {
  if (status === 401) return t("Your Cuter Intra session has expired. Sign in again to create the link.");
  if (status === 429) return t("Too many requests in a row. Wait a minute and try again.");
  if (status === 0) return t("Could not reach the server. Try again.");
  return t("The server could not create the link (error {status}). Try again later.", { status });
}

/**
 * What a failed Stop sharing tells the student: the words of generateError()
 * for a rate limit or no answer, its own for the rest (an expired session
 * there says "to create the link").
 */
export function stopError(status: number): string {
  if (status === 401) return t("Your Cuter Intra session has expired. Sign in again to stop sharing.");
  if (status === 429 || status === 0) return generateError(status);
  return t("The server could not stop sharing (error {status}). Try again later.", { status });
}

export function renderCalendarPanel() {
  return html`<div ${ref(renderPanel)} class="col-span-full"></div>`;
}

/**
 * The panel is always the whole card: an outcome (a failed request, the
 * sign-in it needs) is a line inside it. Rendering the message alone used to
 * replace the card, its button included, with no way back but a page reload.
 */
function renderPanel(el: Element | undefined) {
  if (!el) return;
  const container = el as HTMLElement;
  let error: string | null = null;
  /** The last request answered 401: the sign-in button comes back. */
  let sessionExpired = false;
  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A Stop sharing request is on its way: a second click would send another,
   * and a Regenerate answered after it would store a link the stop revoked.
   */
  let stopping = false;
  /**
   * What the worker said about the live link on the last check: "pending"
   * while one is on its way (Generate waits for it), "known" once it
   * answered, "unknown" before any check or when it could not say.
   */
  let serverLink: "unknown" | "pending" | "known" = "unknown";
  /** Bumped by each Generate and Stop: a check that crosses one answers about a link that is gone. */
  let linkChanges = 0;
  /**
   * Link requests (Generate, Regenerate) on their way. No check starts
   * meanwhile: its answer could land before theirs, about the link they are
   * replacing, and a Generate button offered then would race them.
   */
  let generating = 0;
  /**
   * What the last check changed here (a link replaced or stopped in another
   * browser). Its status line is always drawn, sr-only while empty: a live
   * region inserted with its text is not always read out.
   */
  let notice: string | null = null;

  const connect = () =>
    loginWith42(async () => {
      await clearAuthFailed();
      window.location.reload();
    });

  const update = async () => {
    const store = await chrome.storage.local.get([
      TOKEN_KEY,
      "CLOUD_TOKEN",
      "CLOUD_LOGIN",
      ALL_EVENTS_KEY,
      EVALUATIONS_KEY,
    ]);
    const token = store[TOKEN_KEY] as string | undefined;
    const allEvents = store[ALL_EVENTS_KEY] === true;
    const withEvaluations = store[EVALUATIONS_KEY] !== false;
    // Only with a link: the switch is drawn there, and a student without one
    // costs the worker no request.
    const evaluationsOffered = token ? (await getWorkerFeatures()).evaluations === true : false;
    const signedIn = !!store.CLOUD_TOKEN && !!store.CLOUD_LOGIN;

    const qrUrl = token
      ? `https://${WORKER_URL.replace("https://", "")}/calendar/${token}.ics`
      : "";
    const qrDataUrl = token ? generateQrDataUrl(qrUrl, 200) : "";

    render(
      html`
        <div
          class="card bg-base-200 shadow-sm w-full"
          style="border: 2px solid var(--color-info)"
        >
          <div class="card-body p-4 sm:p-6 gap-4">
            <h3 class="card-title text-lg">${t("Calendar Sync")}</h3>
            <p class="text-sm opacity-70">
              ${t(
                "Subscribe to the 42 events you are registered for in any calendar app. The feed updates every time you visit your profile.",
              )}
            </p>

            ${error
              ? html`<p class="text-sm text-error" role="alert">${error}</p>`
              : ""}
            <p class="${notice ? "text-sm font-medium" : "sr-only"}" role="status">
              ${notice ?? ""}
            </p>
            ${sessionExpired
              ? html`<button
                  type="button"
                  class="btn btn-primary btn-sm self-start"
                  @click="${connect}"
                >
                  ${t("Sign in again")}
                </button>`
              : ""}
            ${!signedIn && !token
              ? html`
                  <p class="text-sm opacity-70">
                    ${t("Sign in with your 42 account to generate a calendar link.")}
                  </p>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm self-start"
                    @click="${connect}"
                  >
                    ${t("Sign in with 42")}
                  </button>
                `
              : token
              ? html`
                  <div
                    class="bg-base-100 rounded-lg p-3 flex items-center gap-2"
                    style="border: 2px solid var(--color-info)"
                  >
                    <code class="text-xs flex-1 break-all select-all"
                      >${calUrl(token)}</code
                    >
                    <button
                      type="button"
                      class="btn btn-sm btn-square"
                      @click="${() => copyLink(calUrl(token))}"
                      data-tip="${t(copied ? "Copied!" : "Copy link")}"
                      aria-label="${t(copied ? "Link copied" : "Copy link")}"
                    >
                      <span class="size-4 flex items-center justify-center"
                        >${unsafeHTML(COPY_SVG)}</span
                      >
                    </button>
                  </div>
                  <span class="sr-only" role="status"
                    >${copied ? t("Link copied") : ""}</span
                  >

                  <div class="flex flex-wrap gap-2">
                    <a class="btn btn-sm btn-primary" href="${webcalUrl(token)}"
                      >${t("Open in my calendar app")}</a
                    >
                    <a
                      class="btn btn-sm"
                      style="border: 2px solid var(--color-info)"
                      href="${googleCalendarUrl(token)}"
                      target="_blank"
                      rel="noopener noreferrer"
                      >${t("Add to Google Calendar")}</a
                    >
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div
                      class="bg-base-100 rounded-lg p-2.5"
                      style="border: 2px solid var(--color-info)"
                    >
                      <span class="font-semibold">${t("Apple Calendar")}</span>
                      <p class="opacity-60 mt-0.5">
                        ${t("Scan the QR code or File → New")}
                      </p>
                    </div>
                    <div
                      class="bg-base-100 rounded-lg p-2.5"
                      style="border: 2px solid var(--color-info)"
                    >
                      <span class="font-semibold">${t("Google Calendar")}</span>
                      <p class="opacity-60 mt-0.5">${t("Settings → Add → From URL")}</p>
                    </div>
                    <div
                      class="bg-base-100 rounded-lg p-2.5"
                      style="border: 2px solid var(--color-info)"
                    >
                      <span class="font-semibold">Outlook</span>
                      <p class="opacity-60 mt-0.5">${t("Add calendar → Subscribe")}</p>
                    </div>
                  </div>

                  <label class="label cursor-pointer justify-start gap-3 text-sm whitespace-normal">
                    <input
                      type="checkbox"
                      class="toggle toggle-sm toggle-info"
                      .checked=${allEvents}
                      @change="${(e: Event) =>
                        void setFlag(ALL_EVENTS_KEY, (e.target as HTMLInputElement).checked)}"
                    />
                    <span>
                      ${t("Also add the campus events and exams I am not registered for")}
                      <span class="block text-xs opacity-60"
                        >${t("Shown as free time, without a reminder. Applied on your next visit to your profile.")}</span
                      >
                    </span>
                  </label>

                  ${evaluationsOffered
                    ? html`<label class="label cursor-pointer justify-start gap-3 text-sm whitespace-normal">
                        <input
                          type="checkbox"
                          class="toggle toggle-sm toggle-info"
                          .checked=${withEvaluations}
                          @change="${(e: Event) =>
                            void setFlag(EVALUATIONS_KEY, (e.target as HTMLInputElement).checked)}"
                        />
                        <span>
                          ${t("Add my booked evaluations, with a reminder 15 minutes before")}
                          <span class="block text-xs opacity-60"
                            >${t("Read from 42 by the Cuter Intra server when you visit your profile. Your calendar app may take a few hours to show a new one.")}</span
                          >
                        </span>
                      </label>`
                    : ""}

                  <div class="flex justify-center pt-1">
                    <img
                      src="${qrDataUrl}"
                      alt="${t("QR Code")}"
                      class="rounded-lg"
                      width="200"
                      height="200"
                    />
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="btn btn-sm"
                      style="border: 2px solid var(--color-info)"
                      ?disabled=${stopping}
                      @click="${handleRegenerate}"
                    >
                      <span class="size-4 flex items-center justify-center"
                        >${unsafeHTML(CALENDAR_PLUS_SVG)}</span
                      >
                      ${t("Regenerate")}
                    </button>
                    <span class="text-xs opacity-50 ml-1"
                      >${t("New link invalidates the old one")}</span
                    >
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost text-error sm:ml-auto"
                      ?disabled=${stopping}
                      @click="${handleStop}"
                    >
                      ${t("Stop sharing")}
                    </button>
                  </div>
                `
              : html`
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    ?disabled=${serverLink === "pending"}
                    aria-busy="${serverLink === "pending" ? "true" : "false"}"
                    @click="${handleGenerate}"
                  >
                    ${serverLink === "pending"
                      ? html`<span
                          class="loading loading-spinner loading-xs"
                          aria-hidden="true"
                        ></span>`
                      : html`<span class="size-4 flex items-center justify-center"
                          >${unsafeHTML(CALENDAR_PLUS_SVG)}</span
                        >`}
                    ${t("Generate calendar link")}
                  </button>
                  ${serverLink === "unknown"
                    ? html`<p class="text-xs opacity-60">
                        ${t("If you already made a link in another browser, this replaces it.")}
                      </p>`
                    : ""}
                `}
          </div>
        </div>
      `,
      container,
    );
  };

  // On the profile itself the feed is rebuilt at once; elsewhere
  // maybeSyncCalendar() returns and the next profile visit uploads it (the
  // event list, hence its hash, changed).
  const setFlag = async (key: string, on: boolean) => {
    await chrome.storage.local.set({ [key]: on });
    await update();
    void maybeSyncCalendar();
  };

  // The copy used to give no sign of success and did nothing when the
  // clipboard was refused (no focus, a strict browser): the link is then
  // offered in a prompt, like the theme code.
  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt(t("Copy your calendar link:"), url);
      return;
    }
    copied = true;
    await update();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
      void update();
    }, 2000);
  };

  // One click used to revoke the link: every phone or Google calendar
  // subscribed to it stopped updating, without a word.
  const handleRegenerate = () => {
    if (!window.confirm(t(REGENERATE_CONFIRM))) return;
    void handleGenerate();
  };

  const handleGenerate = async () => {
    linkChanges++;
    const store = await chrome.storage.local.get([
      "CLOUD_TOKEN",
      "CLOUD_LOGIN",
    ]);
    const sessionToken = String(store.CLOUD_TOKEN || "");
    const cloudLogin = String(store.CLOUD_LOGIN || "");
    if (!sessionToken || !cloudLogin) {
      error = t("Sign in to Cuter Intra first (Sign in with 42 in the footer).");
      await update();
      return;
    }

    const uuid = crypto.randomUUID();
    // workerFetch, not a bare fetch: a 401 flags CLOUD_AUTH_FAILED (the
    // hub's "Reconnect"), and every failure used to read "Could not reach
    // the server", an expired session and a rate limit included.
    generating++;
    const res = await workerFetch("/api/v1/private/calendar/token", {
      method: "POST",
      body: { token: uuid },
      auth: { login: cloudLogin, token: sessionToken },
    });
    generating--;
    if (!res.ok) {
      // the existing link, QR and button stay: the message sits above them
      sessionExpired = res.status === 401;
      error = generateError(res.status);
      await update();
      return;
    }
    await chrome.storage.local.set({ [TOKEN_KEY]: uuid });
    error = null;
    notice = null;
    sessionExpired = false;
    await update();
    // fill the new feed now rather than at the next profile visit
    void maybeSyncCalendar();
  };

  // Regenerate kept a feed on the server and Wipe All Data took the settings
  // backup, the images and the sessions with it: nothing turned the feed off
  // alone. The worker revokes the link and deletes the stored .ics.
  const handleStop = async () => {
    if (stopping || !window.confirm(t(STOP_SHARING_CONFIRM))) return;
    // set before the first await: the storage read leaves room for a click
    stopping = true;
    linkChanges++;
    const store = await chrome.storage.local.get(["CLOUD_TOKEN", "CLOUD_LOGIN"]);
    const sessionToken = String(store.CLOUD_TOKEN || "");
    const cloudLogin = String(store.CLOUD_LOGIN || "");
    if (!sessionToken || !cloudLogin) {
      stopping = false;
      error = t("Sign in to Cuter Intra first (Sign in with 42 in the footer).");
      await update();
      return;
    }

    await update();
    const res = await workerFetch("/api/v1/private/calendar/token", {
      method: "DELETE",
      auth: { login: cloudLogin, token: sessionToken },
    });
    stopping = false;
    if (!res.ok) {
      // the link stays: it still works until the stop goes through
      sessionExpired = res.status === 401;
      error = stopError(res.status);
      await update();
      return;
    }
    await chrome.storage.local.remove([TOKEN_KEY, "CALENDAR_EVENTS_HASH"]);
    error = null;
    notice = null;
    sessionExpired = false;
    await update();
    // The link is a synced setting: the cloud copy must lose it too, or
    // another browser could restore the dead one from it. Those two keys
    // only, not a whole push (see forgetCloudCalendarLink).
    void forgetCloudCalendarLink();
  };

  // Only the browser that made a link knew it. Another one offered Generate,
  // which revoked the link a phone was subscribed to, and a link regenerated
  // or stopped elsewhere kept showing here, its uploads still answered 200.
  // The worker says which link is live: this browser takes it, or forgets a
  // stopped one, and Generate waits for the answer.
  const checkLiveLink = async () => {
    if (serverLink === "pending" || stopping || generating) return;
    serverLink = "pending";
    const started = linkChanges;
    try {
      const store = await chrome.storage.local.get([TOKEN_KEY, "CLOUD_TOKEN", "CLOUD_LOGIN"]);
      if (!store.CLOUD_TOKEN || !store.CLOUD_LOGIN) return;
      const local = store[TOKEN_KEY] as string | undefined;
      await update();
      const live = liveLinkIn(
        await workerFetch("/api/v1/private/calendar/token", {
          auth: { login: String(store.CLOUD_LOGIN), token: String(store.CLOUD_TOKEN) },
        }),
      );
      serverLink = live === undefined ? "unknown" : "known";
      // A Generate or a Stop sent meanwhile, or a link another tab stored:
      // the answer is about a link that is no longer the one here.
      const { [TOKEN_KEY]: current } = await chrome.storage.local.get(TOKEN_KEY);
      if (live === undefined || started !== linkChanges || current !== local) return;
      if (live === null && current) {
        await chrome.storage.local.remove([TOKEN_KEY, "CALENDAR_EVENTS_HASH"]);
        notice = t("Sharing was stopped from another browser.");
      } else if (live && live !== current) {
        // The feed is per login, not per link. Forgetting the hash uploads it
        // at the next profile visit, in case the browser that made the link
        // (maybe from the hub on another page) has not yet.
        await chrome.storage.local.set({ [TOKEN_KEY]: live });
        await chrome.storage.local.remove("CALENDAR_EVENTS_HASH");
        // a "stopped" left by an earlier check would sit above a live link
        notice = current ? t("The link was replaced in another browser: this is the new one.") : null;
        void maybeSyncCalendar();
      } else {
        return;
      }
      // what a failed Generate or Stop said was about the link just replaced
      error = null;
      sessionExpired = false;
    } catch {
      // the panel keeps what this browser knows
    } finally {
      if (serverLink === "pending") serverLink = "unknown";
      await update();
    }
  };

  update();

  // The hub draws every tab at once: ask each time the Calendar tab is shown
  // (selected, or the hub opened again on it), not on every opening of the
  // hub. Looked up once the hub's render has put the panel in its tab; drawn
  // anywhere else, the panel asks at once.
  setTimeout(() => {
    const panel = container.closest<HTMLElement>('[role="tabpanel"]');
    // the tab is a sibling of its panel (daisyUI's radio tabs), whose parent
    // can be the shadow root itself
    const siblings = panel?.parentNode as ParentNode | null | undefined;
    const tab = panel?.id
      ? siblings?.querySelector<HTMLInputElement>(`input[aria-controls="${panel.id}"]`)
      : null;
    if (!tab) {
      void checkLiveLink();
      return;
    }
    // The hub is one <dialog> per page, closed and shown again as it is: its
    // Calendar tab stays checked, and no "change" says it is back on screen.
    const dialog = (tab.getRootNode() as Partial<ShadowRoot>).host?.closest("dialog");
    let reopened: MutationObserver | undefined;
    const onTab = () => {
      // a hub drawn again can leave this panel behind, listening to the same tab
      if (!container.isConnected) {
        tab.removeEventListener("change", onTab);
        reopened?.disconnect();
        return;
      }
      if (tab.checked) void checkLiveLink();
    };
    tab.addEventListener("change", onTab);
    if (dialog) {
      reopened = new MutationObserver(() => {
        if (dialog.hasAttribute("open")) onTab();
      });
      reopened.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    }
    if (tab.checked) void checkLiveLink();
  });
}
