/**
 * What the Cuter Intra server keeps about the signed-in student, seen from
 * the hub's Advanced tab: the browsers signed in to the account (and signing
 * out the others), and the whole of it as a file (Download my cloud data).
 *
 * Until these routes, the only way to end a session left on a campus
 * computer was Wipe All Data, which takes the backup, the images and the
 * calendar with it; and the only way to see what the server holds was a
 * request on the public issue tracker, which names the student.
 */
import { workerFetch, type WorkerResult } from "../../core/worker.ts";
import { LAST_SESSIONS_KEY, cloudCredentials } from "./account.ts";

const SESSIONS = "/api/v1/private/sessions";
const EXPORT = "/api/v1/private/export";

/** One browser signed in to the account. */
export interface CloudSession {
  /** A short id that tells the rows apart (8 hex of the token's hash). */
  id: string;
  /** When it signed in (ms), null when the worker does not know. */
  createdAt: number | null;
  /** The browser asking. */
  current: boolean;
}

/**
 * Why a call failed: "auth" signed out, or the session is gone (a 401 sets
 * CLOUD_AUTH_FAILED in workerFetch); "network" no answer; "busy" the write
 * limiter (the export counts in it); "missing" a worker from before the
 * route (404); "rejected" anything else.
 */
export type AccountCallFailure = "auth" | "network" | "busy" | "missing" | "rejected";

export type AccountCall<T> = ({ ok: true } & T) | { ok: false; reason: AccountCallFailure };

function failureOf(res: WorkerResult): AccountCallFailure {
  if (res.status === 401) return "auth";
  if (res.status === 0) return "network";
  if (res.status === 429) return "busy";
  // Not privateFailure's "record gone": these routes check the session in
  // D1 and never look for the record first, so a 404 is a worker that does
  // not have them yet (the extension ships before the worker is deployed).
  if (res.status === 404) return "missing";
  return "rejected";
}

/**
 * The browsers signed in to the account, newest first (the worker's order).
 * The count is kept for the popup's next first paint, like the meta read.
 */
export async function listCloudSessions(): Promise<AccountCall<{ sessions: CloudSession[] }>> {
  const auth = await cloudCredentials();
  if (!auth) return { ok: false, reason: "auth" };
  const res = await workerFetch(SESSIONS, { auth });
  if (!res.ok) return { ok: false, reason: failureOf(res) };
  const list = (res.json as { sessions?: unknown } | null)?.sessions;
  const sessions = (Array.isArray(list) ? list : []).map(
    (s: Partial<CloudSession>): CloudSession => ({
      id: String(s.id),
      createdAt: typeof s.createdAt === "number" ? s.createdAt : null,
      current: s.current === true,
    }),
  );
  await chrome.storage.local.set({ [LAST_SESSIONS_KEY]: sessions.length });
  return { ok: true, sessions };
}

/** Signs out every browser of the account but this one. */
export async function signOutOtherBrowsers(): Promise<AccountCall<{ revoked: number }>> {
  const auth = await cloudCredentials();
  if (!auth) return { ok: false, reason: "auth" };
  const res = await workerFetch(`${SESSIONS}?others=true`, { method: "DELETE", auth });
  if (!res.ok) return { ok: false, reason: failureOf(res) };
  const revoked = Number((res.json as { revoked?: unknown } | null)?.revoked ?? 0);
  await chrome.storage.local.set({ [LAST_SESSIONS_KEY]: 1 });
  return { ok: true, revoked: Number.isFinite(revoked) ? revoked : 0 };
}

/**
 * Everything the server keeps about the student, as the worker exports it
 * (settings with tokens redacted, sessions by short id, first sign-in,
 * calendar state, uploaded image slots, what visitors see).
 */
export async function fetchCloudExport(): Promise<AccountCall<{ data: unknown }>> {
  const auth = await cloudCredentials();
  if (!auth) return { ok: false, reason: "auth" };
  // several reads on the worker's side (the record, three images, D1)
  const res = await workerFetch(EXPORT, { auth, timeoutMs: 20_000 });
  if (!res.ok || !res.json || typeof res.json !== "object") {
    return { ok: false, reason: res.ok ? "rejected" : failureOf(res) };
  }
  return { ok: true, data: res.json };
}
