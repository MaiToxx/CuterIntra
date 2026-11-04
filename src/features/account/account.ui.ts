import { html, nothing, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import {
  describeCloudFailure,
  getCloudLogin,
  getLastKnownSessions,
  getPushFailure,
  refreshSessionCount,
} from "./account.ts";
import { getConfig } from "../../core/config.ts";
import { t } from "../../core/i18n/i18n.ts";
import { WORKER_HOST } from "../../core/worker.ts";
// The shapes alone: the editor's metadata (Illustrator comment, Inkscape and
// Sodipodi namespaces) was 700 of the file's 1,100 bytes, in content.js and
// in the popup (64 KB budget) alike.
import FORTY_TWO_SVG from "../../assets/svg/42_Logo.svg?raw";
import { AccountState, createInitialState } from "./state.ts";
import { createHandlers } from "./handlers.ts";
import {
  PRIVACY_POLICY_URL,
  hasAcceptedSignInDisclosure,
  signInDisclosureText,
} from "./signin-disclosure.ts";

type Handlers = ReturnType<typeof createHandlers>;

/**
 * The words used for the account, everywhere in the popup: "Sign in with 42",
 * "Sign in again", "Sign out", and "the cloud" for the Cuter Intra server,
 * named by its host so it is clear it is not 42's.
 */
const privacyLine = () => html`
  <p class="text-xs opacity-70 text-center">
    ${t("Your account lives on the Cuter Intra server ({host}), not at 42.", {
      host: WORKER_HOST,
    })}
    <a
      class="underline font-semibold"
      href="${PRIVACY_POLICY_URL}"
      target="_blank"
      rel="noopener noreferrer"
      >${t("Privacy policy")}</a
    >
  </p>
`;

/** Why the last sign-in failed: first line bold, diagnostics below it. */
const loginErrorLine = (state: AccountState) => {
  if (!state.loginError) return nothing;
  const [first, ...rest] = state.loginError.split("\n");
  return html`
    <div
      role="alert"
      data-login-error
      class="text-sm text-error w-full max-w-sm text-left"
    >
      <p class="font-semibold">${first}</p>
      ${rest.length
        ? html`<p class="text-xs opacity-70 mt-1 break-words">
            ${rest.join(" · ")}
          </p>`
        : nothing}
    </div>
  `;
};

function renderDisclosure(
  state: AccountState,
  handlers: Handlers,
): ReturnType<typeof html> {
  return html`
    <div class="w-full flex flex-col gap-3 p-2 text-sm" data-disclosure>
      <h2 class="text-lg font-bold">${t("Before you sign in")}</h2>
      <div class="flex flex-col gap-2 opacity-90">
        ${signInDisclosureText()}
      </div>
      <div class="flex justify-end gap-2 mt-1">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          @click="${handlers.cancelDisclosure}"
        >
          ${t("Cancel")}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary font-bold"
          data-accept
          ?disabled="${state.signingIn}"
          @click="${handlers.handleLogin42}"
        >
          ${t("Sign in")}
        </button>
      </div>
    </div>
  `;
}

function renderAccountTab(
  state: AccountState,
  handlers: Handlers,
): ReturnType<typeof html> {
  if (state.disclosureOpen) return renderDisclosure(state, handlers);

  const isConnected = state.cloud === "online";
  const statusClass =
    state.cloud === "checking"
      ? "badge-ghost"
      : isConnected
        ? "badge-success"
        : "badge-warning";
  const statusText =
    state.cloud === "checking"
      ? t("Checking...")
      : isConnected
        ? t("Online")
        : t("Unreachable");

  if (!state.token) {
    return html`
      <div
        class="w-full h-full flex flex-col items-center justify-center p-6 gap-3"
      >
        <div class="text-center">
          ${state.needsReconnect
            ? html`<h2 class="text-2xl font-bold">${t("Session expired")}</h2>
                <p class="opacity-70 mt-1">
                  ${t("Sign in again to get the cloud features back.")}
                </p>`
            : html`<h2 class="text-2xl font-bold">${t("Sign in with 42")}</h2>
                <p class="opacity-70 mt-1">
                  ${t(
                    "Optional: shows your profile look to other students, syncs your settings between browsers and enables the calendar feed. Everything else works without it.",
                  )}
                </p>`}
        </div>
        <button
          id="signin-btn"
          class="btn bg-[#00babc] text-white border-none hover:bg-[#1fd2d4] w-full max-w-sm h-16 text-lg flex items-center justify-center gap-3 transition-colors duration-200 mt-2"
          type="button"
          aria-busy="${state.signingIn ? "true" : "false"}"
          ?disabled="${state.signingIn}"
          @click="${handlers.startLogin}"
        >
          ${state.signingIn
            ? html`<span
                  class="loading loading-spinner"
                  aria-hidden="true"
                ></span>
                <span class="font-bold tracking-wide text-base"
                  >${t("Signing in...")}</span
                >`
            : html`<span class="font-bold tracking-wide text-base"
                  >${t("Sign in with")}</span
                >
                <span
                  class="size-10 flex items-center justify-center [&_polygon]:fill-current"
                >
                  ${unsafeHTML(FORTY_TWO_SVG)}
                </span>`}
        </button>
        ${loginErrorLine(state)} ${privacyLine()}
      </div>
    `;
  }

  return html`
    <div class="w-full h-full flex flex-col gap-4 overflow-y-auto">
      ${state.needsReconnect
        ? html`<div
            class="alert alert-warning shadow-lg rounded-xl flex flex-col items-stretch gap-2"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-semibold">${t("Session expired")}</span>
              <button
                class="btn btn-warning btn-sm font-bold"
                type="button"
                ?disabled="${state.signingIn}"
                @click="${handlers.startLogin}"
              >
                ${state.signingIn ? t("Signing in...") : t("Sign in again")}
              </button>
            </div>
            ${loginErrorLine(state)}
          </div>`
        : ""}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          class="bg-base-200 shadow-md p-5 rounded-xl border border-base-300"
        >
          <h2 class="text-lg font-bold text-base-content mb-4">
            ${t("Account Status")}
          </h2>
          <div class="flex flex-col gap-3">
            <div
              class="flex items-center justify-between bg-base-100 p-3 rounded-lg border border-base-300"
            >
              <span class="font-medium text-sm text-base-content">Login</span>
              <div
                class="badge badge-info font-mono font-bold text-info-content"
              >
                ${state.login}
              </div>
            </div>
            <div
              class="flex items-center justify-between bg-base-100 p-3 rounded-lg border border-base-300"
            >
              <span class="font-medium text-sm text-base-content"
                >${t("Server")}</span
              >
              <div class="badge ${statusClass} font-bold">
                ${statusText}
              </div>
            </div>
            <div
              class="flex items-center justify-between bg-base-100 p-3 rounded-lg border border-base-300"
              title="${t(
                "Each sign-in counts, on any browser. Past 10, the oldest one is signed out.",
              )}"
            >
              <span class="font-medium text-sm text-base-content"
                >${t("Sign-ins")}</span
              >
              <div class="badge badge-success font-bold text-success-content">
                ${state.activeSessions ?? "?"}/10
              </div>
            </div>
          </div>
        </div>

        <div
          class="bg-base-200 shadow-md p-5 rounded-xl border border-base-300"
        >
          <h2 class="text-lg font-bold text-base-content">
            ${t("Cloud Sync")}
          </h2>
          <p class="text-xs opacity-70 mb-4">
            ${t(
              "Push copies this browser's settings to {host}; Pull replaces them with that copy.",
              { host: WORKER_HOST },
            )}
          </p>
          <div class="grid grid-cols-2 gap-3">
            <button
              id="pull-cloud-btn"
              class="btn btn-info font-bold transition-all text-info-content text-base row-span-2 py-8 w-full ${state
                .buttons.pull.loading
                ? "loading"
                : state.buttons.pull.success
                  ? "btn-success text-success-content"
                  : state.buttons.pull.error
                    ? "btn-error text-error-content"
                    : ""}"
              type="button"
              ?disabled="${state.buttons.pull.loading}"
              @click="${handlers.handlePull}"
            >
              ${state.buttons.pull.loading
                ? t("Pulling...")
                : state.buttons.pull.text}
            </button>

            <button
              id="push-cloud-btn"
              class="btn btn-success text-success-content font-bold transition-all text-base row-span-2 py-8 w-full ${state
                .buttons.push.loading
                ? "loading"
                : state.buttons.push.success
                  ? "btn-success text-success-content"
                  : state.buttons.push.error
                    ? "btn-error text-error-content"
                    : ""}"
              type="button"
              ?disabled="${state.buttons.push.loading}"
              @click="${handlers.handlePush}"
            >
              ${state.buttons.push.loading
                ? t("Pushing...")
                : state.buttons.push.text}
            </button>
          </div>
          ${state.pushFailure
            ? html`<p
                id="push-failure"
                role="status"
                class="text-xs text-error mt-3"
              >
                <span class="font-semibold">${t("Last push failed:")}</span>
                ${describeCloudFailure(
                  state.pushFailure.reason,
                  state.pushFailure.detail,
                )}
              </p>`
            : nothing}
        </div>
      </div>

      <div class="flex justify-between gap-4 mt-auto pt-4">
        <button
          class="btn btn-outline font-bold transition-all text-base"
          type="button"
          @click="${handlers.handleDelete}"
        >
          ${t("Sign out")}
        </button>
        <button
          class="btn btn-error text-error-content font-bold transition-all text-base"
          type="button"
          @click="${handlers.handleWipe}"
        >
          ${t("Wipe All Data")}
        </button>
      </div>
      ${privacyLine()}
    </div>
  `;
}

export async function initAccountSettings(container: HTMLElement) {
  const state = createInitialState();
  const handlers = createHandlers(state, update);

  // Storage only, never the network: the card used to wait for the worker's
  // answer before its first paint, so a slow or blackholed worker left the
  // popup blank for as long as the browser's own connection timeout.
  async function update() {
    state.login = await getCloudLogin();
    state.token = (await getConfig("CLOUD_TOKEN")) || "";
    state.needsReconnect = !!(await getConfig("CLOUD_AUTH_FAILED"));
    state.disclosureAccepted = await hasAcceptedSignInDisclosure();
    state.pushFailure = state.token ? await getPushFailure() : null;
    render(renderAccountTab(state, handlers), container);
  }

  async function refreshCloud() {
    if (!state.token || !state.login) return;
    const count = await refreshSessionCount();
    if (count !== null) {
      state.activeSessions = count;
      state.cloud = "online";
    } else {
      state.cloud = "offline";
    }
    // Set by the request itself on a 401: read after it, or the first popup
    // after a session expiry says "Unreachable" and only offers to sign in
    // again on the next re-render.
    state.needsReconnect = !!(await getConfig("CLOUD_AUTH_FAILED"));
    render(renderAccountTab(state, handlers), container);
  }

  state.activeSessions = await getLastKnownSessions();
  await update();
  void refreshCloud();
}
