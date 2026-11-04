/**
 * Login without a 42 OAuth application ("intra" auth mode).
 *
 * The Intra v3 front-end authenticates its API calls with a Keycloak token
 * that hook.js captures on every page (sessionStorage "ft_intrapy_token").
 * The self-hosted worker verifies that token's signature against Keycloak's
 * public keys and opens a Cuter Intra session for its login. No popup, no
 * redirect, no application to register on the Intra.
 *
 * Only usable from a content script on an Intra page (the token lives there);
 * the toolbar popup asks the active Intra tab to do it (FT_INTRA_LOGIN).
 */
import {
  getStoredIntrapyToken,
  isJwtExpired,
  waitForIntrapyToken,
} from "../../core/intra/intrapy.ts";
import { WORKER_HOST, workerErrorText, workerFetch } from "../../core/worker.ts";
import { t } from "../../core/i18n/i18n.ts";

export const INTRA_LOGIN_MESSAGE = "FT_INTRA_LOGIN";
/**
 * How long to wait for the page to authenticate a request. When the cached
 * token is an expired JWT, a fresh one only shows up once the Intra front-end
 * refreshes its Keycloak session and calls its API again, which can take a
 * few seconds after a reload.
 */
const TOKEN_WAIT_MS = 8000;

export interface IntraLoginResult {
  ok: boolean;
  login?: string;
  error?: string;
}

/**
 * The sign-in running in this page, if any. Every successful POST opens a new
 * worker session (ten per login, the oldest dropped) and spends a KV write and
 * a sign-in slot of the rate limiter: a double click, or the popup's
 * FT_INTRA_LOGIN landing while an in-page button is already signing in, must
 * share the one request instead of sending a second.
 */
let inFlight: Promise<IntraLoginResult> | null = null;

export function loginWithIntraSession(): Promise<IntraLoginResult> {
  if (!inFlight) {
    inFlight = signIn().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function signIn(): Promise<IntraLoginResult> {
  const token = await waitForIntrapyToken(TOKEN_WAIT_MS);
  if (!token) {
    // The token is only issued to the Intra v3 front-end: on the old v2 pages
    // (profile.intra.42.fr, projects.intra.42.fr...) there is nothing to read.
    const onV3 = location.hostname === "profile-v3.intra.42.fr";
    if (onV3 && isJwtExpired(getStoredIntrapyToken())) {
      return {
        ok: false,
        error: t(
          "The Intra session token on this page has expired and the page did not issue a new one. Reload the page, wait a few seconds and try again.",
        ),
      };
    }
    return {
      ok: false,
      error: onV3
        ? t(
            "No Intra session token found on this page yet. Reload the page, wait a few seconds and try again.",
          )
        : t(
            "Sign in from the Intra v3 profile page: open {url} and sign in from there.",
            { url: "https://profile-v3.intra.42.fr/" },
          ),
    };
  }

  // Keycloak's JWKS fetch on a cold worker can take a moment: longer than the
  // default deadline, shorter than the user's patience for a login button.
  const res = await workerFetch("/auth/intra", {
    method: "POST",
    body: { token },
    timeoutMs: 20_000,
  });
  if (res.status === 0) {
    return {
      ok: false,
      error: `${t(
        "Could not reach the Cuter Intra server ({host}). If the extension asked for access to that site, click Allow, then retry.",
        { host: WORKER_HOST },
      )}\nCuter Intra ${__APP_VERSION__}`,
    };
  }
  if (res.status === 429) {
    // the worker limits sign-ins per login and per address
    return {
      ok: false,
      error: t("Too many sign-in attempts. Wait a minute, then try again."),
    };
  }
  // The daily write budget and a busy KV answer 503 too: they are not 42's
  // key server, and each says when to try again.
  const known = workerErrorText(res);
  if (known) return { ok: false, error: known };
  if (!res.ok) {
    const text = res.message ?? res.text;
    const details = `${t("Server refused the login ({status}): {text}", {
      status: res.status,
      text: text.slice(0, 200),
    })}\nCuter Intra ${__APP_VERSION__} · ${location.hostname}`;
    // The client already skips an expired JWT, so a 401 means the signature,
    // a claim or the clock did not check out, and a fresh token usually does.
    // Say what to do first; the raw answer stays below it for bug reports.
    if (res.status === 401) {
      return {
        ok: false,
        error: `${t(
          "Intra did not accept this page's session token. Reload the page, then try again.",
        )}\n${details}`,
      };
    }
    if (res.status === 503) {
      return {
        ok: false,
        error: `${t(
          "42's key server did not answer the Cuter Intra server. Try again in a minute.",
        )}\n${details}`,
      };
    }
    return { ok: false, error: details };
  }

  const data = (res.json ?? {}) as { token?: string; login?: string };
  if (!data.token || !data.login) {
    return { ok: false, error: t("Unexpected server response.") };
  }

  // The settings revision is settled by the restore question this flag
  // brings (account.ts maybePromptRestore).
  await chrome.storage.local.set({
    CLOUD_TOKEN: data.token,
    CLOUD_LOGIN: data.login,
    PENDING_SETTINGS_RESTORE: true,
  });
  await chrome.storage.local.remove("CLOUD_AUTH_FAILED");
  return { ok: true, login: data.login };
}

/**
 * From the toolbar popup: ask the active tab (which must be an Intra page) to
 * perform the login, since only the page has the Intra token.
 */
export async function requestIntraLoginFromActiveTab(): Promise<IntraLoginResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/profile-v3\.intra\.42\.fr\//.test(tab.url || "")) {
    // open the v3 profile (the only place the Intra token exists) and let the
    // user sign in from there
    try {
      await chrome.tabs.create({ url: "https://profile-v3.intra.42.fr/" });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: t(
        "Sign in from the Intra v3 profile page (just opened in a new tab): click the Cuter Intra toolbar icon again there.",
      ),
    };
  }
  // The content script stores the session before answering, and the
  // background reloads Intra tabs as soon as CLOUD_TOKEN changes. When the
  // reload wins the race the answer is lost and sendMessage rejects, even
  // though the login succeeded: the token that appeared in storage is the
  // proof (worker sessions are fresh UUIDs, so a changed token is a new login).
  const before = await readStoredSession();
  try {
    const result = (await chrome.tabs.sendMessage(tab.id, {
      type: INTRA_LOGIN_MESSAGE,
    })) as IntraLoginResult | undefined;
    return result ?? { ok: false, error: t("No answer from the Intra page.") };
  } catch {
    const after = await readStoredSession();
    if (after.token && after.login && after.token !== before.token) {
      return { ok: true, login: after.login };
    }
    return {
      ok: false,
      error: t(
        "Cuter Intra is not running on this tab yet (it was installed or updated after the tab was opened). Reload the tab, then try again.",
      ),
    };
  }
}

async function readStoredSession(): Promise<{
  token: string | null;
  login: string | null;
}> {
  try {
    const store = await chrome.storage.local.get(["CLOUD_TOKEN", "CLOUD_LOGIN"]);
    const token = typeof store.CLOUD_TOKEN === "string" ? store.CLOUD_TOKEN : null;
    const login = typeof store.CLOUD_LOGIN === "string" ? store.CLOUD_LOGIN : null;
    return { token, login };
  } catch {
    return { token: null, login: null };
  }
}
