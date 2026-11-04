/**
 * The client side of the worker contract, one request at a time.
 *
 * Each flow this release added (the settings revision, the sessions, the
 * calendar's live link, the export, the error codes) runs through its real
 * client function with fetch mocked, and the request it sends is pinned:
 * path, method, query, headers and the exact body fields, the ones the
 * worker's own tests send to the same route (better-intra-worker
 * tests/settings-rev, sessions, calendar, export and budget). The answers
 * given back are the worker's, as those tests assert them.
 *
 * With the worker repository next to this one (the maintainer's machine, not
 * CI), the same flows then run against the worker itself: its router and
 * handlers, on the SQLite D1 and the in-memory KV of its tests. A field
 * renamed on one side only, or a status the client reads differently, fails
 * there even when each side's own tests were updated with it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render } from "lit-html";

const sync = vi.hoisted(() => ({ maybeSyncCalendar: vi.fn(async () => {}) }));
vi.mock("../src/features/calendar/calendar-sync.ts", () => sync);
// the QR code draws on a canvas, which jsdom has not
vi.mock("../src/features/calendar/qr.ts", () => ({ generateQrDataUrl: () => "data:," }));

import {
  describeCloudFailure,
  fetchPrivateSettings,
  getPushFailure,
  pullSettings,
  pushPartial,
  pushSettings,
} from "../src/features/account/account.ts";
import {
  fetchCloudExport,
  listCloudSessions,
  signOutOtherBrowsers,
} from "../src/features/account/cloud-account.ts";
import { renderCalendarPanel } from "../src/features/calendar/calendar.ui.ts";
import { hashedLogin, workerFetch } from "../src/core/worker.ts";
import { CLOUD_SYNC_KEYS, resetConfigCache } from "../src/core/config.ts";

const LOGIN = "alice";
const SETTINGS = "/api/v1/private/settings";
const SESSIONS = "/api/v1/private/sessions";
const EXPORT = "/api/v1/private/export";
const CALENDAR_TOKEN = "/api/v1/private/calendar/token";

/** One request as the worker receives it. */
interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** The JSON body, or null when there is none. */
  body: any;
}

let sent: Sent[] = [];

function record(url: string, init: RequestInit): Sent {
  const u = new URL(url);
  const req: Sent = {
    method: init.method ?? "GET",
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: { ...((init.headers as Record<string, string>) ?? {}) },
    body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? null),
  };
  sent.push(req);
  return req;
}

/** fetch as the client sees it: every request recorded, answered by `answer`. */
function serve(answer: (req: Sent, url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => answer(record(url, init), url, init));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain" } });

/** Signed in as LOGIN with `token`; `rev` is the revision this browser knows (null: none). */
async function asBrowser(token: string, rev: number | null = null): Promise<void> {
  await chrome.storage.local.set({ CLOUD_TOKEN: token, CLOUD_LOGIN: LOGIN });
  if (rev === null) await chrome.storage.local.remove("CLOUD_SETTINGS_REV");
  else await chrome.storage.local.set({ CLOUD_SETTINGS_REV: rev });
  await chrome.storage.local.remove(["CLOUD_PUSH_FAILURE", "CLOUD_AUTH_FAILED"]);
}

const knownRev = async () => (await chrome.storage.local.get("CLOUD_SETTINGS_REV")).CLOUD_SETTINGS_REV;

/** Every private request: the hashed login in the query and the Bearer header. */
async function expectPrivate(req: Sent, token: string, query: Record<string, string> = {}) {
  expect(req.query).toEqual({ login: await hashedLogin(LOGIN), ...query });
  expect(req.query.login).toMatch(/^[0-9a-f]{64}$/);
  expect(req.headers.Authorization).toBe(`Bearer ${token}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function mountCalendar(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(renderCalendarPanel(), host);
  return host;
}

beforeAll(() => {
  // the hub's cards panel listens for storage changes
  const storage = chrome.storage as unknown as { onChanged?: unknown };
  storage.onChanged ??= { addListener: vi.fn(), removeListener: vi.fn() };
});

beforeEach(async () => {
  sent = [];
  await chrome.storage.local.clear();
  resetConfigCache();
  document.body.replaceChildren();
  sync.maybeSyncCalendar.mockClear();
  (globalThis as any).chrome.tabs = { query: vi.fn(async () => []) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the requests of each new flow (worker contract C1-C5)", () => {
  it("C1: a full push sends {settings, baseRev} and takes the rev of {ok, rev}", async () => {
    await asBrowser("sess", 5);
    serve(() => json({ ok: true, rev: 7 }));
    expect(await pushSettings()).toBe("ok");

    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(SETTINGS);
    await expectPrivate(req, "sess");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(req.body).sort()).toEqual(["baseRev", "settings"]);
    expect(req.body.baseRev).toBe(5);
    // the synced keys only: never the session, the revision or what is left to publish
    expect(Object.keys(req.body.settings).sort()).toEqual([...CLOUD_SYNC_KEYS].sort());
    for (const local of ["CLOUD_TOKEN", "CLOUD_SETTINGS_REV", "LOOK_PUBLISH_PENDING"]) {
      expect(req.body.settings).not.toHaveProperty(local);
    }
    expect(await knownRev()).toBe(7);
  });

  it("C1: a browser that never knew a revision sends no baseRev, and adopts the one answered", async () => {
    await asBrowser("sess");
    serve(() => json({ ok: true, rev: 3 }));
    await pushSettings();
    expect(sent[0].body).not.toHaveProperty("baseRev");
    expect(await knownRev()).toBe(3);
  });

  it("C1: a 409 conflict is recorded and nothing is adopted", async () => {
    await asBrowser("sess", 5);
    serve(() => json({ error: "conflict", message: "Settings changed in another browser", rev: 9 }, 409));
    expect(await pushSettings()).toBe("conflict");
    expect((await getPushFailure())?.reason).toBe("conflict");
    expect(await knownRev()).toBe(5);
  });

  it("C1: Push anyway sends {settings} alone, then reads the rev with fields=meta", async () => {
    await asBrowser("sess", 5);
    serve((req) =>
      req.method === "POST" ? text("Saved") : json({ activeSessions: 2, discordId: null, rev: 11 }),
    );
    expect(await pushSettings({ force: true })).toBe("ok");

    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${SETTINGS}`, `GET ${SETTINGS}`]);
    expect(Object.keys(sent[0].body)).toEqual(["settings"]);
    await expectPrivate(sent[1], "sess", { fields: "meta" });
    expect(sent[1].body).toBeNull();
    expect(await knownRev()).toBe(11);
  });

  it("C1: a few-key push sends baseRev, and after a 409 the same keys without it", async () => {
    await asBrowser("sess", 5);
    let n = 0;
    serve(() =>
      n++ === 0 ? json({ error: "conflict", message: "Settings changed", rev: 12 }, 409) : text("Saved"),
    );
    const keys = { CALENDAR_SYNC_TOKEN: "", CALENDAR_EVENTS_HASH: "" };
    expect(await pushPartial(keys)).toBe("ok");

    expect(sent).toHaveLength(2);
    for (const req of sent) {
      expect(`${req.method} ${req.path}`).toBe(`POST ${SETTINGS}`);
      await expectPrivate(req, "sess");
    }
    expect(sent[0].body).toEqual({ settings: keys, baseRev: 5 });
    expect(sent[1].body).toEqual({ settings: keys });
    // the other browser's revision is not taken: the next full push must see its change
    expect(await knownRev()).toBe(5);
  });

  it("C1: a pull is a GET without fields and takes its rev exactly", async () => {
    await asBrowser("sess", 50);
    serve(() => json({ settings: {}, activeSessions: 1, discordId: null, rev: 15 }));
    const result = await pullSettings();
    expect(result.ok && result.rev).toBe(15);

    expect(sent).toHaveLength(1);
    expect(`${sent[0].method} ${sent[0].path}`).toBe(`GET ${SETTINGS}`);
    await expectPrivate(sent[0], "sess");
    expect(await knownRev()).toBe(15);
  });

  it("C2: the sessions list is a GET, the sign-out of the others a DELETE with others=true", async () => {
    await asBrowser("sess");
    serve((req) =>
      req.method === "GET"
        ? json({
            sessions: [
              { id: "0a1b2c3d", createdAt: 1_758_000_000_000, current: true },
              { id: "4e5f6a7b", createdAt: 1_757_000_000_000, current: false },
            ],
          })
        : json({ revoked: 1 }),
    );
    const list = await listCloudSessions();
    expect(list.ok && list.sessions).toEqual([
      { id: "0a1b2c3d", createdAt: 1_758_000_000_000, current: true },
      { id: "4e5f6a7b", createdAt: 1_757_000_000_000, current: false },
    ]);
    const out = await signOutOtherBrowsers();
    expect(out.ok && out.revoked).toBe(1);

    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${SESSIONS}`, `DELETE ${SESSIONS}`]);
    await expectPrivate(sent[0], "sess");
    await expectPrivate(sent[1], "sess", { others: "true" });
    expect(sent.every((r) => r.body === null)).toBe(true);
  });

  it("C3: the calendar card asks GET calendar/token and takes {token}", async () => {
    const LIVE = "22222222-2222-4222-8222-222222222222";
    await asBrowser("sess");
    serve(() => json({ token: LIVE }, 200, { "Cache-Control": "no-store" }));
    mountCalendar();
    await vi.waitFor(async () =>
      expect((await chrome.storage.local.get("CALENDAR_SYNC_TOKEN")).CALENDAR_SYNC_TOKEN).toBe(LIVE),
    );
    await settle();

    const gets = sent.filter((r) => r.path === CALENDAR_TOKEN);
    expect(gets).toHaveLength(1);
    expect(gets[0].method).toBe("GET");
    await expectPrivate(gets[0], "sess");
    expect(gets[0].body).toBeNull();
  });

  it("C4: the export is a GET with no body", async () => {
    await asBrowser("sess");
    const data = {
      exportedAt: 1,
      loginHash: await hashedLogin(LOGIN),
      settings: {},
      rev: 0,
      sessions: [{ id: "0a1b2c3d", createdAt: 1 }],
      firstSignIn: null,
      calendar: { live: false, feedStored: false },
      images: [],
      publicVisuals: {},
    };
    serve(() => json(data, 200, { "Content-Disposition": 'attachment; filename="cuter-intra-cloud-data.json"' }));
    const result = await fetchCloudExport();
    expect(result.ok && result.data).toEqual(data);

    expect(sent).toHaveLength(1);
    expect(`${sent[0].method} ${sent[0].path}`).toBe(`GET ${EXPORT}`);
    await expectPrivate(sent[0], "sess");
    expect(sent[0].body).toBeNull();
  });

  it("C5: the codes of the new 503s are told apart from their status", async () => {
    await asBrowser("sess", 1);
    serve(() =>
      json({ error: "daily_write_budget", message: "Daily write budget spent" }, 503, { "Retry-After": "3600" }),
    );
    expect(await pushSettings()).toBe("daily-limit");
    expect(describeCloudFailure("daily-limit")).toMatch(/saves for today are used up/);

    serve(() => json({ error: "kv_busy", message: "Storage busy" }, 503, { "Retry-After": "2" }));
    expect(await pushSettings()).toBe("kv-busy");
    expect(describeCloudFailure("kv-busy")).toMatch(/busy: try again in a few seconds/);
  });
});

// ---------------------------------------------------------------------------
// The same flows against the worker itself
// ---------------------------------------------------------------------------

const WORKER_DIR = path.resolve(__dirname, "../../better-intra-worker");
const hasWorker = ["src/index.ts", "tests/helpers/fake-env.ts", "migrations"].every((f) =>
  fs.existsSync(path.join(WORKER_DIR, f)),
);
// Outside this project's root: vitest.config.ts allows the directory.
const workerModule = (file: string) =>
  import(/* @vite-ignore */ path.join(WORKER_DIR, file).split(path.sep).join("/"));

// The worker is a sibling repository: present on the maintainer's machine, not in CI.
describe.skipIf(!hasWorker)("the same flows against the worker's own code", () => {
  let worker: { fetch(request: Request, env: unknown): Promise<Response> };
  let fake: any;
  let rateLimit: any;
  let utils: any;
  let env: any;
  let kv: any;
  let d1: any;
  let hash: string;

  /** The login's KV record, as the worker stored it. */
  const stored = async () => (await env.BETTER_INTRA_KV.get(hash, { type: "json" })) as any;

  beforeAll(async () => {
    worker = (await workerModule("src/index.ts")).default;
    fake = await workerModule("tests/helpers/fake-env.ts");
    rateLimit = await workerModule("src/rate-limit.ts");
    utils = await workerModule("src/utils.ts");
  });

  beforeEach(async () => {
    ({ env, kv, d1 } = fake.makeEnv());
    rateLimit.resetRateLimits();
    hash = await hashedLogin(LOGIN);
    // two browsers of one student, signed in
    fake.addSession(d1, hash, "token-browser-a", Date.now() - 2000);
    fake.addSession(d1, hash, "token-browser-b", Date.now() - 1000);
    serve((_req, url, init) =>
      worker.fetch(
        new Request(url, { method: init.method ?? "GET", headers: init.headers, body: init.body as BodyInit }),
        env,
      ),
    );
  });

  it("C1: the stale browser is refused, pulls, and then pushes over the newer copy", async () => {
    await asBrowser("token-browser-a");
    expect(await pushSettings()).toBe("ok");
    const first = (await stored()).settingsRev;
    expect(first).toBeGreaterThan(0);
    expect(await knownRev()).toBe(first);

    // browser B knows an older revision: it never saw that push
    await asBrowser("token-browser-b", 1);
    expect(await pushSettings()).toBe("conflict");
    expect((await stored()).settingsRev).toBe(first);

    const pulled = await pullSettings();
    expect(pulled.ok && pulled.rev).toBe(first);
    expect(await knownRev()).toBe(first);
    expect(await getPushFailure()).toBeNull();

    await chrome.storage.local.set({ CUSTOM_ACCENT_COLOR: "#123456" });
    resetConfigCache();
    expect(await pushSettings()).toBe("ok");
    const second = (await stored()).settingsRev;
    expect(second).toBeGreaterThan(first);
    expect(await knownRev()).toBe(second);
    expect((await stored()).settings.CUSTOM_ACCENT_COLOR).toBe("#123456");
  });

  it("C1: Push anyway writes without baseRev and learns the new revision from the meta read", async () => {
    await asBrowser("token-browser-a");
    await pushSettings();
    await asBrowser("token-browser-b", 1);
    expect(await pushSettings()).toBe("conflict");

    await chrome.storage.local.set({ CUSTOM_ACCENT_COLOR: "#654321" });
    resetConfigCache();
    expect(await pushSettings({ force: true })).toBe("ok");
    expect(await knownRev()).toBe((await stored()).settingsRev);
    expect((await stored()).settings.CUSTOM_ACCENT_COLOR).toBe("#654321");
  });

  it("C1: a few-key push from a stale browser still lands, without adopting the revision", async () => {
    await asBrowser("token-browser-a");
    await pushSettings();
    const first = (await stored()).settingsRev;

    await asBrowser("token-browser-b", 1);
    sent = [];
    expect(await pushPartial({ CALENDAR_SYNC_TOKEN: "", CALENDAR_EVENTS_HASH: "gone" })).toBe("ok");
    expect(sent.filter((r) => r.method === "POST").map((r) => "baseRev" in r.body)).toEqual([true, false]);
    expect((await stored()).settings.CALENDAR_EVENTS_HASH).toBe("gone");
    expect((await stored()).settingsRev).toBeGreaterThan(first);
    expect(await knownRev()).toBe(1);
  });

  it("C2: lists both browsers, signs the other one out, and that one is refused afterwards", async () => {
    await asBrowser("token-browser-a");
    const list = await listCloudSessions();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    for (const s of list.sessions) {
      expect(s.id).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof s.createdAt).toBe("number");
    }

    const out = await signOutOtherBrowsers();
    expect(out.ok && out.revoked).toBe(1);
    const after = await listCloudSessions();
    expect(after.ok && after.sessions.map((s) => s.current)).toEqual([true]);

    await asBrowser("token-browser-b");
    const refused = await fetchPrivateSettings();
    expect(refused.ok || refused.reason).toBe("auth");
    expect((await chrome.storage.local.get("CLOUD_AUTH_FAILED")).CLOUD_AUTH_FAILED).toBe(true);
  });

  it("C3: a link made in one browser is taken by the other's calendar card", async () => {
    const LINK = "33333333-3333-4333-8333-333333333333";
    await asBrowser("token-browser-a");
    const made = await workerFetch(CALENDAR_TOKEN, {
      method: "POST",
      body: { token: LINK },
      auth: { login: LOGIN, token: "token-browser-a" },
    });
    expect(made.ok).toBe(true);

    await asBrowser("token-browser-b");
    mountCalendar();
    await vi.waitFor(async () =>
      expect((await chrome.storage.local.get("CALENDAR_SYNC_TOKEN")).CALENDAR_SYNC_TOKEN).toBe(LINK),
    );
    await settle();
  });

  it("C4: the export parses into every contract field, with no token in it", async () => {
    await asBrowser("token-browser-a");
    await chrome.storage.local.set({ CALENDAR_SYNC_TOKEN: "44444444-4444-4444-8444-444444444444" });
    resetConfigCache();
    await pushSettings();

    const result = await fetchCloudExport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, any>;
    expect(Object.keys(data).sort()).toEqual(
      ["calendar", "exportedAt", "firstSignIn", "images", "loginHash", "publicVisuals", "rev", "sessions", "settings"],
    );
    expect(data.loginHash).toBe(hash);
    expect(data.rev).toBe((await stored()).settingsRev);
    expect(Object.keys(data.calendar).sort()).toEqual(["feedStored", "live"]);
    for (const s of data.sessions) expect(Object.keys(s).sort()).toEqual(["createdAt", "id"]);
    expect(data.settings.CALENDAR_SYNC_TOKEN).toBe("[redacted]");
    const all = JSON.stringify(data);
    for (const secret of ["token-browser-a", "token-browser-b", fake.tokenHash("token-browser-a"), "44444444-4444"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("C5/C6: a spent daily budget is 'daily-limit', and nothing is written", async () => {
    d1.raw
      .prepare("INSERT INTO kv_write_budget (day, login_hash, n) VALUES (?, ?, ?)")
      .run(Math.floor(Date.now() / 86_400_000), hash, 200);
    await asBrowser("token-browser-a");
    expect(await pushSettings()).toBe("daily-limit");
    expect(await stored()).toBeNull();
    expect((await getPushFailure())?.reason).toBe("daily-limit");
  });

  it("C5/C7: a key KV refuses twice is 'kv-busy'", async () => {
    const delay = utils.KV_RETRY.delayMs;
    utils.KV_RETRY.delayMs = 0;
    try {
      kv.putErrors.push(fake.kvRateLimitError(), fake.kvRateLimitError());
      await asBrowser("token-browser-a");
      expect(await pushSettings()).toBe("kv-busy");
      expect(await stored()).toBeNull();
    } finally {
      utils.KV_RETRY.delayMs = delay;
    }
  });
});
