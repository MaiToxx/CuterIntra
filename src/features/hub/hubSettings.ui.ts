/**
 * The settings hub: a <dialog> around a shadow root that holds the header
 * (title, settings search), the tabs (controls/tab-panel.ts) and the footer
 * (light/dark switch, cloud account, push mode, Reload). hubSettings.ts
 * imports this module on demand when the gear is clicked; openHubModal is its
 * main export.
 */
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import RELOAD_SVG from "../../assets/svg/reload.svg?raw";
import SUN_SVG from "../../assets/svg/sun.svg?raw";
import MOON_SVG from "../../assets/svg/moon.svg?raw";
import CLOUD_SVG from "../../assets/svg/cloud.svg?raw";
import ICON_SVG from "../../assets/svg/icon.svg?raw";
import { CLOUD_SYNC_KEYS, CONFIG_DEFAULT, getConfig } from "../../core/config.ts";
import { getLang, t } from "../../core/i18n/i18n.ts";
import { LOCAL_ONLY_KEYS } from "../../core/config/keys.ts";
import { bindTooltips } from "../../core/dom/tooltip.ts";
import { sharedStylesLink } from "../../core/styles/shared-styles.ts";
import {
  THEMES,
  getEffectiveTheme,
  getIsLight,
} from "../../core/theme/theme-manager.ts";
import { WORKER_URL } from "../../core/worker.ts";
import {
  PUSH_FAILURE_KEY,
  clearAuthFailed,
  describeCloudFailure,
  getPushFailure,
  loginWith42,
  logoutCloud,
  pullSettings,
  pushSettings,
} from "../account/account.ts";
import { flushLookPublish } from "../customize/publish.ts";
import {
  FEATURE_DEFS,
  HUB_INFO,
  HUB_SETTING_DEFS,
  INTRA_FONT,
  isLiveKey,
  normalizeSearchText,
  type FeatureId,
} from "./hubSettings.data.ts";
import { bindDependents, initialGates } from "./dependents.ts";
import { loadLiveOptions } from "./controls/context.ts";
import {
  bindTabPanels,
  rememberedTab,
  renderTabsContent,
} from "./controls/tab-panel.ts";

/** How long the hub waits after the last change before an automatic push. */
export const AUTO_PUSH_DELAY_MS = 1000;

/**
 * When a failed automatic push is tried again. The first wait matches the
 * worker's write limit (10 a minute per login, shared with sign-in, calendar
 * and uploads; its 429 says Retry-After 60), and the waits grow so that a
 * worker that stays down is not asked every minute.
 */
export const AUTO_PUSH_RETRY_MS: readonly number[] = [60_000, 120_000, 300_000];

/** The worker the cloud features talk to, named next to the sign-in button. */
const WORKER_HOST = (() => {
  try {
    return new URL(WORKER_URL).host;
  } catch {
    return WORKER_URL;
  }
})();

const PRIVACY_URL = HUB_INFO.privacy;

export async function openHubModal(active: FeatureId[]) {
  let dialog = document.getElementById("hub-dialog") as HTMLDialogElement;
  if (!dialog) {
    // not awaited: the empty dialog opens at once and fills as the lists load
    void createModal(active);
    dialog = document.getElementById("hub-dialog") as HTMLDialogElement;
  }

  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";

  dialog.showModal();

  dialog.addEventListener(
    "close",
    () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    },
    { once: true },
  );
}

function renderDialogShell(): ReturnType<typeof html> {
  return html`
    <div
      class="w-full h-full p-0 overflow-hidden bg-base-100 rounded-3xl shadow-2xl flex flex-col relative"
    >
      <div id="hub-shadow-wrapper" class="w-full h-full"></div>
    </div>
  `;
}

/** The <dialog> itself: closes on a click outside it, sized to the window. */
function createDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.id = "hub-dialog";
  // Its visible title is inside the shadow root, where aria-labelledby on
  // this light-DOM element cannot reach: name it directly.
  dialog.setAttribute("aria-label", t("Cuter Intra settings"));
  dialog.className =
    "modal-box hub-modal-box p-0 overflow-hidden bg-base-100 rounded-3xl shadow-2xl border-none outline-none";

  const tempContainer = document.createElement("div");
  render(renderDialogShell(), tempContainer);
  dialog.appendChild(tempContainer.firstElementChild!);

  document.body.appendChild(dialog);
  dialog.addEventListener("click", (e) => {
    // Only a click on the backdrop, which targets the <dialog> itself. A key
    // that activates a control inside (Space on a switch, Enter on a button,
    // an arrow key moving between the tabs) fires a click at (0, 0), outside
    // the box: the bounds test alone closed the hub on every such key.
    if (e.target !== dialog) return;
    const dialogDimensions = dialog.getBoundingClientRect();
    if (
      e.clientX < dialogDimensions.left ||
      e.clientX > dialogDimensions.right ||
      e.clientY < dialogDimensions.top ||
      e.clientY > dialogDimensions.bottom
    ) {
      dialog.close();
    }
  });

  const applyDesktopLock = () => {
    dialog.style.width = "100%";
    dialog.style.height = "100%";

    if (window.matchMedia("(min-width: 1024px)").matches) {
      dialog.style.maxWidth = "1200px";
      dialog.style.maxHeight = "800px";
    } else {
      dialog.style.maxWidth = "calc(100dvw - 1rem)";
      dialog.style.maxHeight = "calc(100dvh - 1rem)";
    }
  };

  applyDesktopLock();
  window.addEventListener("resize", applyDesktopLock);
  dialog.addEventListener(
    "close",
    () => window.removeEventListener("resize", applyDesktopLock),
    { once: true },
  );
  return dialog;
}

async function getInitialTheme() {
  return getEffectiveTheme();
}

/**
 * "Never synced", or "Synced 12 Sep 14:03": a time alone read like today
 * whatever the day of the last push. In English the date is in the viewer's
 * locale; in French it is French, like the sentence around it.
 */
export function formatSyncStatus(lastSync: unknown, now = new Date()): string {
  if (typeof lastSync !== "number" && typeof lastSync !== "string") {
    return t("Never synced");
  }
  const date = new Date(lastSync);
  if (Number.isNaN(date.getTime())) return t("Never synced");
  const locales = getLang() === "fr" ? ["fr-FR"] : [];
  const time = date.toLocaleTimeString(locales, { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return t("Synced at {time}", { time });
  const day = date.toLocaleDateString(locales, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return t("Synced {day} {time}", { day, time });
}

/**
 * Builds the modal once per page: reads what it shows at open (theme, gates,
 * live lists, cloud state), renders it, then wires the search, the footer,
 * the tab headers and the dependencies.
 */
async function createModal(active: FeatureId[]): Promise<void> {
  const dialog =
    (document.getElementById("hub-dialog") as HTMLDialogElement | null) ??
    createDialog();

  const wrapper = dialog.querySelector("#hub-shadow-wrapper")!;
  const shadow = wrapper.shadowRoot || wrapper.attachShadow({ mode: "open" });

  const currentTheme = await getInitialTheme();
  const gates = await initialGates();
  const live = await loadLiveOptions();
  const tabsContent = renderTabsContent(active, gates, live, rememberedTab());
  const lastSync = (await chrome.storage.local.get("LAST_CLOUD_SYNC"))
    .LAST_CLOUD_SYNC;
  const isConnected = !!(await getConfig("CLOUD_TOKEN"));
  const authFailed = !!(await getConfig("CLOUD_AUTH_FAILED"));
  const login = (await getConfig("CLOUD_LOGIN")) || "";

  // The banner's Reconnect and the footer's Connect must not start two logins
  // at once: the footer button steps aside while the banner is up.
  const connect = () => {
    dialog.close();
    loginWith42(async () => {
      await clearAuthFailed();
      window.location.reload();
    });
  };
  const signOut = async () => {
    if (!window.confirm(t("Sign out of Cuter Intra on this browser?"))) return;
    await logoutCloud();
    window.location.reload();
  };

  // Header: on a phone the search takes a row of its own (squeezed between
  // the title and the close button it was 26 px wide). Footer, signed out:
  // signing in sends the Intra session token to a server that is not 42's,
  // so the line under the button says whose, what for, and that it is
  // optional, before the click. Signed in: "Push now" for Manual mode, which
  // had no way to push from the hub (only the toolbar popup could).
  // The light/dark switch: both faces of the swap are in the DOM (one is only
  // faded out), so the label's text reads "Light Dark": the switch is named
  // by what "checked" means instead. (Comments stay out of the template: an
  // HTML comment there ships in content.js.)
  const modalTemplate = html`${sharedStylesLink()}<style>
      :host {
        display: block;
        height: 100%;
        width: 100%;
        font-family: ${INTRA_FONT};
      }
      input,
      button,
      select,
      textarea,
      .tab,
      h2,
      h3 {
        font-family: ${INTRA_FONT} !important;
      }
      /*
       * daisyUI sizes the open panel as the tab list minus ONE row of tabs.
       * In a window under about 1090 px the tabs wrap, and each extra row
       * pushed the end of every tab out of reach: the panel gets the height
       * of the rows the tabs really take instead (bindTabRowsHeight), and the
       * rows are packed at the top so that measure does not include the
       * spare height a stretched line would add.
       */
      [role="tablist"] {
        align-content: flex-start;
      }
      .tab-content {
        height: calc(100% - var(--hub-tabs-h, var(--tab-height)));
        overflow-y: auto;
      }
      /* Phones: icon-only tabs (the name stays for screen readers), small
         enough for the nine to share one row. */
      @media (max-width: 639.98px) {
        [role="tablist"] {
          --tab-height: 2.5rem;
        }
        [role="tablist"] > .tab {
          --tab-p: 0.625rem;
        }
      }
      /* the search filter, apart from the "hidden" the dependencies own */
      .search-hidden {
        display: none !important;
      }
    </style>
    <div
      class="flex flex-col h-full text-base-content bg-base-100"
      data-theme="${currentTheme}"
    >
      <div
        class="flex-none flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 sm:py-4 border-b border-base-200 bg-base-100 z-10"
      >
        <div class="flex items-center gap-3 min-w-0">
          <div
            class="size-8 flex items-center justify-center"
            style="color: #00babc;"
            aria-hidden="true"
          >
            ${unsafeHTML(ICON_SVG)}
          </div>
          <div class="flex items-baseline gap-2">
            <h3 class="font-bold text-xl tracking-tight">${HUB_INFO.name}</h3>
            <p
              class="text-[14px] opacity-60 font-bold tracking-widest max-sm:hidden"
            >
              v${HUB_INFO.version}
            </p>
          </div>
        </div>
        <div
          class="order-last basis-full sm:order-none sm:basis-auto flex-1 flex flex-col items-stretch sm:max-w-md min-w-0"
        >
          <input
            type="search"
            id="hub-search"
            class="input input-sm w-full"
            placeholder="${t("Search settings")}"
            aria-label="${t("Search settings")}"
            aria-describedby="hub-search-results"
            autocomplete="off"
          />
          <span
            id="hub-search-results"
            class="text-xs opacity-70 mt-1 min-h-4"
            role="status"
          ></span>
        </div>
        <button
          type="button"
          class="btn btn-circle btn-ghost"
          aria-label="${t("Close settings")}"
          @click="${() => dialog.close()}"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      ${authFailed
        ? html`<div
            class="flex-none alert alert-warning mx-4 mt-3 rounded-xl flex flex-wrap items-center justify-between gap-2"
            data-hub-auth-banner
          >
            <span class="text-sm font-semibold"
              >${t(
                "Your Cuter Intra sign-in expired: cloud sync is paused until you sign in again.",
              )}</span
            >
            <button
              type="button"
              class="btn btn-warning btn-sm font-bold"
              @click="${connect}"
            >
              ${t("Sign in again")}
            </button>
          </div>`
        : ""}

      <div
        role="tablist"
        aria-label="${t("Settings sections")}"
        class="tabs tabs-lg tabs-border flex-1 overflow-hidden"
      >
        ${tabsContent}
      </div>

      <div
        id="hub-footer"
        class="flex-none p-2 sm:p-4 border-t border-base-200 bg-base-200/50 flex flex-wrap justify-between items-center gap-2 sm:gap-4"
      >
        <div class="flex items-center gap-3 flex-wrap min-w-0">
          <label
            class="swap btn btn-accent border border-base-content/20 text-center items-center"
          >
            <input
              type="checkbox"
              id="hub-theme-toggle"
              aria-label="${t("Dark theme")}"
              ?checked="${currentTheme === "dark"}"
            />
            <span
              class="swap-on flex items-center justify-center gap-1"
              aria-hidden="true"
            >
              ${unsafeHTML(SUN_SVG)}
              <span class="text-sm font-bold">${t("Light")}</span>
            </span>
            <span
              class="swap-off flex items-center justify-center gap-1"
              aria-hidden="true"
            >
              ${unsafeHTML(MOON_SVG)}
              <span class="text-sm font-bold">${t("Dark")}</span>
            </span>
          </label>
          <div class="flex items-center gap-2 text-xs flex-wrap min-w-0">
            ${isConnected
              ? html`<span
                    class="badge badge-success badge-lg gap-1 border border-base-content/20"
                    ><span class="size-4 inline-flex items-center" aria-hidden="true"
                      >${unsafeHTML(CLOUD_SVG)}</span
                    >
                    ${login ? t("Signed in as {login}", { login }) : t("Signed in")}</span
                  >
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    @click="${signOut}"
                  >
                    ${t("Sign out")}
                  </button>
                  <span
                    id="hub-sync-status"
                    class="badge badge-info badge-lg border border-base-content/20"
                    >${formatSyncStatus(lastSync)}</span
                  >`
              : authFailed
                ? ""
                : html`<button
                      type="button"
                      class="btn btn-primary btn-sm border border-base-content/20 font-bold"
                      aria-describedby="hub-cloud-about"
                      @click="${connect}"
                    >
                      ${t("Sign in with 42")}
                    </button>
                    <span id="hub-cloud-about" class="opacity-70 max-w-sm">
                      ${t(
                        "Optional: syncs your settings, friends and published look through the Cuter Intra server ({host}).",
                        { host: WORKER_HOST },
                      )}
                      <a
                        class="underline"
                        href="${PRIVACY_URL}"
                        target="_blank"
                        rel="noopener noreferrer"
                        >${t("Privacy")}</a
                      >
                    </span>`}
            ${isConnected
              ? html`<div
                  class="join"
                  role="radiogroup"
                  aria-label="${t("Cloud push")}"
                >
                  <input
                    type="radio"
                    name="hub-auto-push"
                    class="join-item btn btn-sm btn-outline border-base-content/20"
                    aria-label="${t("Manual push")}"
                    value="manual"
                    @change="${() =>
                      chrome.storage.local.set({
                        CLOUD_SYNC_ENABLED: false,
                      })}"
                  />
                  <input
                    type="radio"
                    name="hub-auto-push"
                    class="join-item btn btn-sm btn-outline border-base-content/20"
                    aria-label="${t("Auto push")}"
                    value="auto"
                    @change="${() =>
                      chrome.storage.local.set({
                        CLOUD_SYNC_ENABLED: true,
                      })}"
                  />
                </div>
                <button
                  type="button"
                  id="hub-push-now"
                  class="btn btn-sm btn-outline border-base-content/20 hidden"
                >
                  ${t("Push now")}
                </button>`
              : ""}
            <span id="hub-push-status" class="hidden" role="status"></span>
            ${isConnected
              ? html`<span id="hub-conflict" class="flex gap-2 hidden">
                  <button
                    type="button"
                    id="hub-conflict-pull"
                    class="btn btn-info btn-xs font-bold"
                    aria-describedby="hub-push-status"
                  >
                    ${t("Pull")}
                  </button>
                  <button
                    type="button"
                    id="hub-conflict-push"
                    class="btn btn-warning btn-xs font-bold"
                    aria-describedby="hub-push-status"
                  >
                    ${t("Push anyway")}
                  </button>
                </span>`
              : ""}
            <button
              type="button"
              id="hub-push-reconnect"
              class="btn btn-warning btn-xs font-bold hidden"
              @click="${connect}"
            >
              ${t("Sign in again")}
            </button>
          </div>
        </div>
        <div class="flex items-center gap-3 ms-auto">
          <span
            id="hub-reload-hint"
            class="text-sm font-semibold text-warning hidden"
            role="status"
            aria-live="polite"
          ></span>
          <button
            id="hub-reload"
            class="btn btn-success px-4 sm:px-8 font-bold flex items-center gap-2"
          >
            <span class="size-5 flex items-center justify-center" aria-hidden="true">
              ${unsafeHTML(RELOAD_SVG)}
            </span>
            ${t("Reload")}
          </button>
        </div>
      </div>
    </div>`;

  render(modalTemplate, shadow);

  bindTooltips(shadow, getIsLight);

  bindTabRowsHeight(shadow);
  await bindThemeToggle(shadow);
  await bindCloudSync(shadow, dialog);
  bindTabPanels(shadow);
  bindDependents(shadow);
  bindSearch(shadow);
}

/**
 * Keeps --hub-tabs-h, the height of the rows the tabs take, on the tab list:
 * the open panel is the list minus that (see the style above). The rows
 * change with the width of the window and with the search counts that widen
 * the tabs, so every tab is watched too. A closed hub measures 0 and keeps
 * the last value.
 */
export function bindTabRowsHeight(shadow: ShadowRoot): void {
  const list = shadow.querySelector<HTMLElement>('[role="tablist"]');
  if (!list || typeof ResizeObserver === "undefined") return;
  const tabs = [...list.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches("label.tab"),
  );
  const measure = () => {
    const top = list.getBoundingClientRect().top;
    let bottom = top;
    for (const tab of tabs) bottom = Math.max(bottom, tab.getBoundingClientRect().bottom);
    if (bottom > top) list.style.setProperty("--hub-tabs-h", `${Math.ceil(bottom - top)}px`);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(list);
  for (const tab of tabs) observer.observe(tab);
  measure();
}

/**
 * Light/dark switch of the footer. It starts on the side of the saved theme
 * preset, and flips the hub to the matching theme of the other side.
 */
async function bindThemeToggle(shadow: ShadowRoot): Promise<void> {
  const themeToggle = shadow.querySelector(
    "#hub-theme-toggle",
  ) as HTMLInputElement;
  const hubContainer = shadow.querySelector("[data-theme]");
  const ghIcon = shadow.querySelector('img[alt="GitHub"]') as HTMLElement;

  const presetKey = (await getConfig("PROFILE_THEME_PRESET")) || "dark";
  const validPreset = HUB_SETTING_DEFS.profile
    .find((s) => s.key === "PROFILE_THEME_PRESET")
    ?.options?.some((o) => o.value === presetKey)
    ? presetKey
    : "dark";
  hubContainer?.setAttribute("data-theme", validPreset);
  const isLightPreset =
    validPreset === "light" ||
    (validPreset !== "dark" && !!THEMES[validPreset]?.light);
  if (themeToggle) themeToggle.checked = !isLightPreset;

  themeToggle?.addEventListener("change", async () => {
    const isDark = themeToggle.checked;
    const preset = (await getConfig("PROFILE_THEME_PRESET")) || "dark";
    const isLightPreset =
      preset === "light" || (preset !== "dark" && !!THEMES[preset]?.light);
    const theme = isDark
      ? isLightPreset
        ? "dark"
        : preset
      : isLightPreset
        ? preset
        : "light";

    hubContainer?.setAttribute("data-theme", theme);
    // A named preset carries its own mode (theme-manager.ts presetMode): going
    // to the other side means leaving it for that side's default.
    const leavesPreset = preset !== "dark" && preset !== "light" && (isDark ? isLightPreset : !isLightPreset);
    await chrome.storage.local.set({
      BETTER_INTRA_THEME: isDark ? "dark" : "light",
      ...(leavesPreset ? { PROFILE_THEME_PRESET: isDark ? "dark" : "light" } : {}),
    });

    if (ghIcon) {
      ghIcon.style.filter = isDark ? "none" : "invert(1) brightness(0)";
    }
  });
}

/** A key a user changes in the hub, as opposed to the session and the caches. */
function isUserSetting(key: string): boolean {
  return key in CONFIG_DEFAULT && !LOCAL_ONLY_KEYS.includes(key as never);
}

/**
 * What the footer says about a failed push, from the reason pushSettings()
 * gives. Every failure used to read "check the cloud connection", a 429
 * included, which sent people looking for a network problem.
 */
export function pushFailureText(reason: string): string {
  switch (reason) {
    case "auth":
      return t("Push failed: your sign-in expired");
    case "network":
      return t("Push failed: the Cuter Intra server did not answer");
    case "too-large":
      return t("Push failed: too large for the cloud (custom CSS, presets)");
    case "conflict":
      return t("Not pushed: changed from another browser");
    case "daily-limit":
      return t("Push failed: the server's daily limit is reached");
    // KV refused a write made within a second of another: "too many pushes"
    // says it well enough in a footer, and saves a text
    case "busy":
    case "kv-busy":
      return t("Push failed: too many pushes in a minute");
    default:
      return t("Push failed: the server refused it");
  }
}

/**
 * Failures the same push can get past later: an unreachable worker, its rate
 * limit, a server error. A lapsed sign-in, an oversized payload, a conflict
 * (Pull or Push anyway: the user's call) and the server's daily limit (until
 * 00:00 UTC) fail the same way until the user acts or the day ends.
 */
const RETRY_WONT_HELP: ReadonlySet<string> = new Set([
  "auth",
  "too-large",
  "conflict",
  "daily-limit",
]);

/**
 * After these, Auto stops pushing on every change (each one would fail the
 * same way): until the user signs in again, settles the conflict, or the
 * day's budget is back.
 */
const STOPS_AUTO: ReadonlySet<string> = new Set(["auth", "conflict", "daily-limit"]);

/**
 * The footer's cloud and reload logic, fed by storage.onChanged while the
 * dialog is open: every control writes to storage in the end, whichever
 * module draws it, so this is the one place that sees every change.
 *
 * - A change to a setting the page does not apply live lights up "Reload to
 *   apply" next to the Reload button (the card carries a "reload" tag).
 * - With Auto push, a change to a synced setting schedules one push shortly
 *   after the last change; the outcome is written in the footer, and a
 *   failure keeps the settings local instead of vanishing into a reload.
 *   A failure a later try can get past is tried again after
 *   AUTO_PUSH_RETRY_MS; a new change replaces that wait with its own push.
 * - With Manual push, "Push now" pushes; it stands out while this hub holds
 *   changes it has not pushed.
 * - Closing the hub sends what Auto has not pushed yet, a failed push
 *   included. Reload pushes first when Auto is on and something is not
 *   pushed yet, and stays on the hub when that push fails. With Manual,
 *   closing publishes the look changes still waiting (publish.ts).
 * - A conflict (another browser pushed since this one last synced: nothing
 *   was written) shows Pull and Push anyway, whichever push got it: this
 *   hub's, or one made elsewhere on the page (a friend added). Push now
 *   asks before it pushes over it.
 */
async function bindCloudSync(
  shadow: ShadowRoot,
  dialog: HTMLDialogElement,
): Promise<void> {
  const reloadBtn = shadow.querySelector<HTMLButtonElement>("#hub-reload");
  const reloadHint = shadow.querySelector<HTMLElement>("#hub-reload-hint");
  const pushStatus = shadow.querySelector<HTMLElement>("#hub-push-status");
  const syncStatus = shadow.querySelector<HTMLElement>("#hub-sync-status");
  const pushNow = shadow.querySelector<HTMLButtonElement>("#hub-push-now");
  const reconnect = shadow.querySelector<HTMLElement>("#hub-push-reconnect");
  const conflict = shadow.querySelector<HTMLElement>("#hub-conflict");
  // The banner already offers the sign-in; a second button for it would be
  // a second login started next to the first.
  const bannerUp = !!shadow.querySelector("[data-hub-auth-banner]");
  const autoPushRadios = shadow.querySelectorAll(
    'input[name="hub-auto-push"]',
  ) as NodeListOf<HTMLInputElement>;
  const isAutoPush = (await getConfig("CLOUD_SYNC_ENABLED")) === true;
  autoPushRadios.forEach(
    (r) => (r.checked = r.value === (isAutoPush ? "auto" : "manual")),
  );
  const autoSelected = () =>
    (
      shadow.querySelector(
        'input[name="hub-auto-push"]:checked',
      ) as HTMLInputElement | null
    )?.value === "auto";

  let dirty = false;
  /** Counts the changes, so a push only clears the ones made before it read the settings. */
  let changes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let lastFailure: string | null = null;

  const showPushStatus = (text: string, ok: boolean) => {
    if (!pushStatus) return;
    pushStatus.textContent = text;
    pushStatus.className = ok
      ? "text-xs font-semibold text-success"
      : "text-xs font-semibold text-error";
  };

  const showPushNow = () => {
    if (!pushNow) return;
    pushNow.classList.toggle("hidden", autoSelected());
    pushNow.classList.toggle("btn-primary", dirty);
    pushNow.classList.toggle("btn-outline", !dirty);
  };

  const inConflict = () => !!conflict && !conflict.classList.contains("hidden");
  const showConflict = (on: boolean) => {
    conflict?.classList.toggle("hidden", !on);
    if (on) {
      lastFailure = "conflict";
      const reason = pushFailureText("conflict");
      showPushStatus(t("{reason} - settings kept locally", { reason }), false);
    } else if (lastFailure === "conflict") {
      lastFailure = null;
    }
  };

  const push = async (force = false): Promise<boolean> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const pushed = changes;
    // a string, not PushResult: account.ts may name more reasons than this
    // file knows, and each one still gets a message
    let result: string;
    try {
      result = await pushSettings({ force });
    } catch {
      result = "network";
    }
    reconnect?.classList.add("hidden");
    // Push anyway can fail too (no answer): the conflict is still there
    if (result === "ok") conflict?.classList.add("hidden");
    else if (result === "conflict") conflict?.classList.remove("hidden");
    if (result === "ok") {
      if (changes === pushed) dirty = false;
      retries = 0;
      lastFailure = null;
      showPushStatus(t("Pushed to the cloud"), true);
      if (syncStatus) {
        const last = (await chrome.storage.local.get("LAST_CLOUD_SYNC"))
          .LAST_CLOUD_SYNC;
        syncStatus.textContent = formatSyncStatus(last);
      }
      showPushNow();
      return true;
    }
    lastFailure = result;
    const reason = pushFailureText(result);
    let text = t("{reason} - settings kept locally", { reason });
    if (result === "auth") {
      // no retry: only a new sign-in can make this push go through
      if (!bannerUp) reconnect?.classList.remove("hidden");
    } else if (
      !RETRY_WONT_HELP.has(result) &&
      !timer &&
      autoSelected() &&
      retries < AUTO_PUSH_RETRY_MS.length
    ) {
      // (a change made while this push was out already has a push of its own)
      const wait = AUTO_PUSH_RETRY_MS[retries++];
      timer = setTimeout(() => {
        timer = null;
        if (autoSelected()) void push();
      }, wait);
      text = t("{reason} - settings kept locally, trying again in {n} min", {
        reason,
        n: Math.round(wait / 60_000),
      });
    }
    showPushStatus(text, false);
    return false;
  };

  const schedulePush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void push();
    }, AUTO_PUSH_DELAY_MS);
  };

  const markReloadNeeded = () => {
    if (!reloadHint || !reloadBtn) return;
    reloadHint.textContent = t("Reload to apply");
    reloadHint.classList.remove("hidden");
    reloadBtn.classList.remove("btn-success");
    reloadBtn.classList.add("btn-warning");
  };

  showPushNow();
  autoPushRadios.forEach((r) => r.addEventListener("change", showPushNow));
  pushNow?.addEventListener("click", async () => {
    // over another browser's push only once the user said so
    const force = inConflict();
    if (force && !window.confirm(t("Replace your cloud settings with this browser's?"))) return;
    pushNow.disabled = true;
    await push(force);
    pushNow.disabled = false;
  });

  // A conflict one of the page's own pushes got (a friend added, a look
  // published) before the hub opened.
  if (conflict && (await getPushFailure())?.reason === "conflict") showConflict(true);

  shadow.querySelector("#hub-conflict-push")?.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    await push(true);
    button.disabled = false;
  });
  shadow.querySelector("#hub-conflict-pull")?.addEventListener("click", async (e) => {
    if (!window.confirm(t("Overwrite current local settings with cloud backup?"))) return;
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const result = await pullSettings();
    button.disabled = false;
    if (result.ok) {
      location.reload();
      return;
    }
    showPushStatus(describeCloudFailure(result.reason), false);
  });

  chrome.storage.onChanged?.addListener((changed, area) => {
    if (area !== "local" || !dialog.open) return;
    if (PUSH_FAILURE_KEY in changed) {
      const failure = changed[PUSH_FAILURE_KEY].newValue as
        | { reason?: string }
        | undefined;
      if (failure?.reason === "conflict") showConflict(true);
      else if (!failure) showConflict(false);
    }
    for (const key of Object.keys(changed)) {
      if (!isUserSetting(key)) continue;
      if (!isLiveKey(key)) markReloadNeeded();
      if (CLOUD_SYNC_KEYS.includes(key as never)) {
        dirty = true;
        changes++;
        // after a lapsed sign-in every push fails the same way until the
        // user signs in again (which reloads the page); a conflict and the
        // daily limit until the user settles it or the day ends
        if (autoSelected() && !STOPS_AUTO.has(lastFailure ?? "")) schedulePush();
        showPushNow();
      }
    }
  });

  // What Auto has not pushed when the hub closes goes out now, whether its
  // push is still waiting or already failed once: the user is done editing,
  // and "Auto" must not depend on how the hub was closed.
  // Manual: the look's changes wait a few seconds before they are published;
  // the user is done, they go now (Auto's push above carries them).
  dialog.addEventListener("close", () => {
    if (!autoSelected()) void flushLookPublish();
    else if ((dirty || timer) && !STOPS_AUTO.has(lastFailure ?? "")) void push();
  });

  reloadBtn?.addEventListener("click", async () => {
    // A push after a lapsed sign-in fails again: it would keep the user on
    // the hub for good, and the settings are already kept on this browser.
    // The same for a conflict and the daily limit.
    if (autoSelected() && (dirty || timer) && !STOPS_AUTO.has(lastFailure ?? "")) {
      reloadBtn.disabled = true;
      const ok = await push();
      reloadBtn.disabled = false;
      if (!ok) return;
    }
    location.reload();
  });
}

/**
 * The settings search of the header. It filters the cards of every tab by
 * label and description (case and accents ignored), counts the matches on
 * each tab, names the tabs that match under the field, and moves to the first
 * matching tab when the current one has none. Escape clears it; "/" focuses
 * it from anywhere in the hub that is not a text field.
 *
 * The filter has its own class: the "hidden" class belongs to the dependency
 * gating (dependents.ts) and the feature switch, and both must survive a
 * search and its clearing.
 */
function bindSearch(shadow: ShadowRoot): void {
  const input = shadow.querySelector<HTMLInputElement>("#hub-search");
  const results = shadow.querySelector<HTMLElement>("#hub-search-results");
  if (!input) return;

  const apply = () => {
    const query = normalizeSearchText(input.value);
    const words = query.split(" ").filter(Boolean);
    const counts = new Map<FeatureId, number>();
    for (const f of FEATURE_DEFS) counts.set(f.id, 0);

    shadow.querySelectorAll<HTMLElement>("[data-search]").forEach((card) => {
      const text = card.dataset.search ?? "";
      const match = words.every((w) => text.includes(w));
      card.classList.toggle("search-hidden", words.length > 0 && !match);
      if (words.length > 0 && match) {
        const panel = card.closest<HTMLElement>("[data-feature-panel]");
        const id = panel?.dataset.featurePanel as FeatureId | undefined;
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    });
    // section titles say nothing about the cards left under them
    shadow
      .querySelectorAll<HTMLElement>("[data-search-divider]")
      .forEach((d) => d.classList.toggle("search-hidden", words.length > 0));

    const tabs = [...shadow.querySelectorAll<HTMLInputElement>('input[name="hub_tabs"]')];
    for (const tab of tabs) {
      const badge = tab.parentElement?.querySelector<HTMLElement>("[data-tab-count]");
      const n = counts.get(tab.value as FeatureId) ?? 0;
      if (!badge) continue;
      badge.textContent = words.length > 0 && n > 0 ? String(n) : "";
      badge.classList.toggle("hidden", !(words.length > 0 && n > 0));
    }

    if (results) {
      if (words.length === 0) {
        results.textContent = "";
      } else {
        const names = FEATURE_DEFS.filter((f) => (counts.get(f.id) ?? 0) > 0).map(
          (f) => `${t(f.name)} (${counts.get(f.id)})`,
        );
        results.textContent = names.length
          ? t("Matches in {tabs}", { tabs: names.join(", ") })
          : t("No setting matches");
      }
    }

    if (words.length === 0) return;
    const current = tabs.find((t) => t.checked);
    if (current && (counts.get(current.value as FeatureId) ?? 0) > 0) return;
    const first = tabs.find((t) => (counts.get(t.value as FeatureId) ?? 0) > 0);
    if (first) {
      first.checked = true;
      // bindTabPanels keeps aria-selected and the tab memory on "change"
      first.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  input.addEventListener("input", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !input.value) return;
    // an Escape with a query clears it; the next one closes the hub
    e.preventDefault();
    e.stopPropagation();
    input.value = "";
    apply();
  });
  shadow.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    // a "/" typed in a field is text; on a switch, a tab or a button it is
    // the shortcut
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        (target instanceof HTMLInputElement &&
          !["checkbox", "radio", "button", "range", "color"].includes(target.type)));
    if (typing) return;
    e.preventDefault();
    input.focus();
  });
}
