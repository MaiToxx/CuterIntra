/**
 * Your own evaluations from the worker's 42 application
 * (GET /api/v1/private/evaluations, announced by /features as `evaluations`).
 *
 * - part=stats: the correction statistics the extension otherwise builds from
 *   up to 40 Intra v2 feedback pages (profile-stats-intra.ts), plus your
 *   Outstanding counts, which those pages do not give.
 * - part=upcoming: your booked evaluations of the next two weeks, for the
 *   calendar feed's reminders.
 *
 * Your own login only (the worker refuses another one), signed in only, and
 * only in "intra" builds: the dormant "oauth" mode talks to upstream's worker,
 * which has no such route. Every failure is null: the caller falls back to
 * what it did before.
 */
import { getConfigMany } from "../../../core/config.ts";
import { AUTH_MODE, getWorkerFeatures, workerFetch } from "../../../core/worker.ts";

export interface EvalStatsShape {
  byMonth: Record<string, { total: number; failed: number; successPercentage: number | null }>;
  global: { total: number; failed: number; successPercentage: number | null };
}

export interface OutstandingCounts {
  received: number;
  given: number;
}

export interface UpcomingEvaluation {
  id: number;
  beginAt: string;
  endAt: string;
  role: "corrector" | "corrected";
  project: string | null;
}

/** The session, when `user` is the signed-in login and the worker has the route. */
async function ownSession(user?: string): Promise<{ login: string; token: string } | null> {
  if (AUTH_MODE !== "intra") return null;
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"] as const);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) return null;
  if (user !== undefined && user.toLowerCase() !== CLOUD_LOGIN.toLowerCase()) return null;
  if ((await getWorkerFeatures()).evaluations !== true) return null;
  return { login: CLOUD_LOGIN, token: CLOUD_TOKEN };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isStats(v: unknown): v is EvalStatsShape {
  if (!v || typeof v !== "object") return false;
  const s = v as { byMonth?: unknown; global?: { total?: unknown; failed?: unknown } };
  return (
    !!s.byMonth &&
    typeof s.byMonth === "object" &&
    !!s.global &&
    isCount(s.global.total) &&
    isCount(s.global.failed)
  );
}

/** Your correction stats and Outstanding counts, or null (see the module comment). */
export async function fetchOwnEvaluationStats(
  user: string,
): Promise<{ stats: EvalStatsShape; outstanding: OutstandingCounts } | null> {
  const session = await ownSession(user);
  if (!session) return null;
  const res = await workerFetch(
    `/api/v1/private/evaluations?user=${encodeURIComponent(session.login.toLowerCase())}&part=stats`,
    { auth: session, timeoutMs: 15_000 },
  );
  if (!res.ok || !res.json || typeof res.json !== "object") return null;
  const body = res.json as { stats?: unknown; outstanding?: { received?: unknown; given?: unknown } };
  if (!isStats(body.stats)) return null;
  const o = body.outstanding;
  return {
    stats: body.stats,
    outstanding: {
      received: isCount(o?.received) ? o.received : 0,
      given: isCount(o?.given) ? o.given : 0,
    },
  };
}

/** Your booked evaluations of the next two weeks, or null when unknown. */
export async function fetchUpcomingEvaluations(): Promise<UpcomingEvaluation[] | null> {
  const session = await ownSession();
  if (!session) return null;
  const res = await workerFetch(
    `/api/v1/private/evaluations?user=${encodeURIComponent(session.login.toLowerCase())}&part=upcoming`,
    { auth: session, timeoutMs: 15_000 },
  );
  const list = (res.json as { upcoming?: unknown } | null)?.upcoming;
  if (!res.ok || !Array.isArray(list)) return null;
  return list.filter(
    (e): e is UpcomingEvaluation =>
      !!e &&
      typeof e === "object" &&
      typeof e.id === "number" &&
      typeof e.beginAt === "string" &&
      typeof e.endAt === "string" &&
      (e.role === "corrector" || e.role === "corrected"),
  );
}
