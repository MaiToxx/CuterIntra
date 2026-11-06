/**
 * Your own evaluations from the worker's 42 application
 * (GET /api/v1/private/evaluations, announced by /features as `evaluations`).
 *
 * - part=stats: the correction statistics the extension otherwise builds from
 *   up to 40 Intra v2 feedback pages (profile-stats-intra.ts), plus your
 *   Outstanding counts, which those pages do not give.
 * - part=upcoming: your booked evaluations of the next two weeks, for the
 *   calendar feed's reminders.
 * - part=points (announced as `correctionPoints`): your correction point
 *   balance after each change, for the Campus card's graph.
 * - /coalitions (announced as `coalitions`): the standings of your
 *   coalitions, for the Campus card.
 *
 * Your own login only (the worker refuses another one), signed in only, and
 * only in "intra" builds: the dormant "oauth" mode talks to upstream's worker,
 * which has no such route. Every failure is null: the caller falls back to
 * what it did before.
 */
import { getConfigMany } from "../../../core/config.ts";
import { sanitizeHexColor } from "../../../core/security/css-sanitize.ts";
import {
  AUTH_MODE,
  getWorkerFeatures,
  workerFetch,
  type WorkerFeatures,
} from "../../../core/worker.ts";

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

export interface PointsEntry {
  at: string;
  total: number;
}

export interface Coalition {
  id: number;
  name: string;
  score: number;
  color: string | null;
  imageUrl: string | null;
  mine: boolean;
}

export interface CoalitionBloc {
  id: number;
  cursusId: number | null;
  coalitions: Coalition[];
}

/** The session, when `user` is the signed-in login and the worker has the route. */
async function ownSession(
  user?: string,
  feature: keyof WorkerFeatures = "evaluations",
): Promise<{ login: string; token: string } | null> {
  if (AUTH_MODE !== "intra") return null;
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"] as const);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) return null;
  if (user !== undefined && user.toLowerCase() !== CLOUD_LOGIN.toLowerCase()) return null;
  if ((await getWorkerFeatures())[feature] !== true) return null;
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

/** Your correction point balance after each change, oldest first, or null. */
export async function fetchCorrectionPoints(): Promise<PointsEntry[] | null> {
  const session = await ownSession(undefined, "correctionPoints");
  if (!session) return null;
  const res = await workerFetch(
    `/api/v1/private/evaluations?user=${encodeURIComponent(session.login.toLowerCase())}&part=points`,
    { auth: session, timeoutMs: 15_000 },
  );
  const list = (res.json as { points?: unknown } | null)?.points;
  if (!res.ok || !Array.isArray(list)) return null;
  return list.filter(
    (e): e is PointsEntry =>
      !!e &&
      typeof e === "object" &&
      typeof e.at === "string" &&
      Number.isFinite(Date.parse(e.at)) &&
      typeof e.total === "number" &&
      Number.isFinite(e.total),
  );
}

/**
 * Only Intra's CDN over https: the card draws it as an image on an Intra
 * page. The worker checks it too; this does not trust it to.
 */
function cdnImage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "cdn.intra.42.fr" ? u.href : null;
  } catch {
    return null;
  }
}

/** The blocs your coalitions compete in, or null when unknown. */
export async function fetchOwnCoalitions(): Promise<CoalitionBloc[] | null> {
  const session = await ownSession(undefined, "coalitions");
  if (!session) return null;
  const res = await workerFetch(
    `/api/v1/private/coalitions?user=${encodeURIComponent(session.login.toLowerCase())}`,
    { auth: session, timeoutMs: 15_000 },
  );
  const blocs = (res.json as { blocs?: unknown } | null)?.blocs;
  if (!res.ok || !Array.isArray(blocs)) return null;
  const out: CoalitionBloc[] = [];
  for (const b of blocs) {
    if (!b || typeof b !== "object" || typeof b.id !== "number" || !Array.isArray(b.coalitions)) continue;
    const coalitions: Coalition[] = [];
    for (const c of b.coalitions as Record<string, unknown>[]) {
      if (!c || typeof c.id !== "number" || typeof c.name !== "string") continue;
      coalitions.push({
        id: c.id,
        name: c.name.slice(0, 60),
        score: typeof c.score === "number" && Number.isFinite(c.score) ? c.score : 0,
        color: sanitizeHexColor(c.color) || null,
        imageUrl: cdnImage(c.imageUrl),
        mine: c.mine === true,
      });
    }
    if (coalitions.length > 0) {
      out.push({ id: b.id, cursusId: typeof b.cursusId === "number" ? b.cursusId : null, coalitions });
    }
  }
  return out;
}
