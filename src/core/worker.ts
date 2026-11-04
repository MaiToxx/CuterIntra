import { hashLogin } from "./crypto.ts";
import { getLang, intlLocale, t } from "./i18n/i18n.ts";

/**
 * Base URL of the Cuter Intra cloud worker.
 *
 * Injected at build time from package.json -> "config.workerUrl" (see
 * scripts/repo-info.js). Defaults to the upstream instance; point it at your
 * own deployment of better-intra-worker to self-host (docs/SELF-HOSTING.md).
 */
export const WORKER_URL: string = __WORKER_URL__.replace(/\/+$/, "");

/** Host of the worker, e.g. "api.betterintra.com" (for user-facing text). */
export const WORKER_HOST: string = new URL(WORKER_URL).host;

/** Match pattern covering every worker URL (host permissions). */
export const WORKER_ORIGIN_PATTERN: string = `${new URL(WORKER_URL).origin}/*`;

/**
 * How users sign in to the worker (package.json -> "config.authMode"):
 *  - "oauth": the worker's 42 OAuth application (upstream behaviour)
 *  - "intra": the Intra v3 session token, verified by the worker against
 *    Keycloak (self-hosted instances without a 42 application)
 */
export const AUTH_MODE: "oauth" | "intra" =
  __AUTH_MODE__ === "intra" ? "intra" : "oauth";

// ---------------------------------------------------------------------------
// The worker client: every request to the worker goes through workerFetch()
// ---------------------------------------------------------------------------
//
// One place for what every call site used to do on its own: the deadline (a
// stalled connection or a Worker hung on KV otherwise waits for the browser's
// own timeout, minutes, and the spinner with it), the hashed `login` query and
// the Bearer header, the body parsing (the worker answers a crash with a JSON
// {error, message} 500) and the 401 -> CLOUD_AUTH_FAILED mapping that makes
// the popup, the hub and the friends widget offer "Reconnect".

/** Above the worker's KV latency by an order of magnitude; below Firefox's popup patience. */
export const WORKER_TIMEOUT_MS = 10_000;

export interface WorkerCredentials {
  login: string;
  token: string;
}

export interface WorkerFetchOptions {
  method?: string;
  /** An object is sent as JSON; a string or a Blob (an upload) as is. */
  body?: unknown;
  /** Appends `login=<hash>` and the Bearer header; 401 flags CLOUD_AUTH_FAILED. */
  auth?: WorkerCredentials;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface WorkerResult {
  ok: boolean;
  /** 0 when no response came back (network error or timeout). */
  status: number;
  /** The parsed body when it was JSON, null otherwise. */
  json: unknown;
  /** The body when it was not JSON, "" otherwise. */
  text: string;
  /**
   * The worker's error code and message on a JSON error body ({error,
   * message}): a WorkerErrorCode, or a code this build does not know yet.
   */
  error?: WorkerErrorCode | (string & {});
  message?: string;
  timedOut: boolean;
}

const hashes = new Map<string, Promise<string>>();

/** hashLogin, once per login: it used to run SubtleCrypto on every request. */
export function hashedLogin(login: string): Promise<string> {
  const key = login.toLowerCase().trim();
  let hash = hashes.get(key);
  if (!hash) {
    hash = hashLogin(key);
    hashes.set(key, hash);
  }
  return hash;
}

/**
 * The error codes of the worker's JSON error bodies ({error, message}). The
 * code is the contract, the English `message` is for logs and bug reports:
 * a translated text is picked from the code, never built from the message.
 */
export type WorkerErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "daily_write_budget"
  | "too_large"
  | "conflict"
  | "calendar_stopped"
  | "bad_request"
  | "not_found"
  | "kv_busy"
  | "unsupported_image_type"
  | "image_too_large"
  | "server_error";

/** Next 00:00 UTC in the viewer's time, e.g. "02:00": when the daily budget comes back. */
function nextUtcMidnight(now = new Date()): string {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return midnight.toLocaleTimeString(getLang() === "fr" ? intlLocale() : [], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The sentence for a worker refusal that means the same wherever it happens
 * (a push, a sign-in, an upload), or null for any other result: the caller
 * keeps its own words for those. daily_write_budget: the server's KV writes
 * of the day are spent (per login or in all), nothing can be saved before
 * 00:00 UTC, so no caller retries it. kv_busy: the worker already retried a
 * write refused for KV's one-write-a-second limit; a few seconds is enough.
 */
export function workerErrorText(res: Pick<WorkerResult, "error">): string | null {
  if (res.error === "daily_write_budget") {
    return t("The server's saves for today are used up. Try again after {time}.", {
      time: nextUtcMidnight(),
    });
  }
  if (res.error === "kv_busy") return t("The server is busy: try again in a few seconds.");
  return null;
}

/** What a 401 from the worker means: the session is gone, offer "Reconnect". */
export async function markAuthFailed(): Promise<void> {
  await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
}

function noResponse(timedOut: boolean): WorkerResult {
  return { ok: false, status: 0, json: null, text: "", timedOut };
}

/**
 * Requests `path` (e.g. "/api/v1/private/settings?all=true") on the worker.
 * Never throws: a network error or the deadline is a result with status 0.
 */
export async function workerFetch(
  path: string,
  options: WorkerFetchOptions = {},
): Promise<WorkerResult> {
  const url = new URL(WORKER_URL + path);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.auth) {
    url.searchParams.set("login", await hashedLogin(options.auth.login));
    headers.Authorization = `Bearer ${options.auth.token}`;
  }
  let body: string | Blob | undefined;
  if (typeof options.body === "string" || options.body instanceof Blob) body = options.body;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }

  // Own controller rather than AbortSignal.timeout(): the timer is cleared as
  // soon as the response lands, and fake timers can drive it in tests.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? WORKER_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return noResponse(controller.signal.aborted);
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    // a body cut off mid-way: the status still tells the caller what happened
  } finally {
    clearTimeout(timer);
  }

  const result: WorkerResult = {
    ok: response.ok,
    status: response.status,
    json: null,
    text,
    timedOut: false,
  };
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      result.json = JSON.parse(text);
      result.text = "";
    } catch {
      // not JSON after all: left in `text`
    }
  }
  if (result.json && typeof result.json === "object") {
    const { error, message } = result.json as Record<string, unknown>;
    if (typeof error === "string") result.error = error;
    if (typeof message === "string") result.message = message;
  }
  if (response.status === 401 && options.auth) await markAuthFailed();
  return result;
}
