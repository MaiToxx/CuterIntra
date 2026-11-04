/**
 * The HTTPS server behind every host the harness redirects to 127.0.0.1.
 *
 *   profile-v3.intra.42.fr   the synthetic Intra v3 page (index.html + page/app.js)
 *   auth.42.fr               the Keycloak token endpoint: a fake JWT, new for
 *                            every login, after --auth-latency ms
 *   intrapy.intra.42.fr      JSON stubs for the endpoints a profile page
 *                            calls; anything else is a 404
 *   cdn.intra.42.fr          a 1x1 PNG for every picture
 *   api.github.com           an empty JSON object (no release, no counts)
 *   the worker               404, except the announcement (none), the campus
 *                            list (one campus), that campus's file (empty),
 *                            the event types (none) and the public stats
 *   any other host           404
 *
 * Chrome prints every 404 the page or a content script receives as a console
 * error, so each request the extension makes on a plain profile page must get
 * a 200 here, or d.no-console-errors fails on every Chrome load.
 *
 * Every response carries CORS headers for the Origin it was asked from, like
 * the real intrapy does, so that a stubbed 404 never turns into a
 * "Cross-Origin Request Blocked" console error. Every request is logged (host,
 * path, status, whether it carried an Authorization header) so the harness can
 * check what the page and the extension actually asked for.
 */
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(HERE, "page");

export const PROFILE_HOST = "profile-v3.intra.42.fr";
export const INTRAPY_HOST = "intrapy.intra.42.fr";
export const AUTH_HOST = "auth.42.fr";
const TOKEN_PATH = "/auth/realms/students-42/protocol/openid-connect/token";
export const LOGIN = "smoketest";
/** The campus the page reports (hook.js relays it as 42_CAMPUS_DETECTED). */
export const CAMPUS = { id: 4242, name: "Smoke Campus", slug: "smoke-campus" };

export const GITHUB_API_HOST = "api.github.com";

/** Intra hosts that are always redirected (a wildcard cannot be). */
export const INTRA_HOSTS = [
  PROFILE_HOST,
  INTRAPY_HOST,
  AUTH_HOST,
  "cdn.intra.42.fr",
  "meta.intra.42.fr",
  "profile.intra.42.fr",
  "projects.intra.42.fr",
  "intra.42.fr",
];

/**
 * The hosts the harness must answer for a build, from its manifest and the
 * worker origin of package.json. api.github.com is listed by name: the
 * extension reaches it as a plain CORS request, without a host permission,
 * and the worker is taken from both places in case a build predates one.
 * Returns { hosts, workerHosts }: every host, and the ones that answer like
 * the Cuter Intra worker.
 */
export function harnessHosts(manifest, workerOrigin) {
  const hosts = new Set([GITHUB_API_HOST]);
  const workerHosts = new Set();
  const hostOf = (s) => {
    const m = /^https?:\/\/([^/]+)(?:\/|$)/.exec(String(s));
    return m && !m[1].includes("*") ? m[1].toLowerCase() : null;
  };
  for (const p of manifest.host_permissions || []) {
    const h = hostOf(p);
    if (h) hosts.add(h);
    if (h && !h.endsWith("intra.42.fr") && !h.endsWith("github.com")) workerHosts.add(h);
  }
  const worker = workerOrigin ? hostOf(workerOrigin) : null;
  if (worker) {
    hosts.add(worker);
    workerHosts.add(worker);
  }
  return { hosts: [...hosts], workerHosts: [...workerHosts] };
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** Only what the page needs to be laid out like the Intra (sidebar, card). */
const PAGE_CSS = `
*,::before,::after{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#f3f4f6;color:#111}
.fixed{position:fixed}.relative{position:relative}.absolute{position:absolute}
.flex{display:flex}.grid{display:grid}.flex-col{flex-direction:column}
.w-full{width:100%}.w-16{width:4rem}.h-screen{height:100vh}.min-h-screen{min-height:100vh}
.ml-16{margin-left:4rem}.gap-4{gap:1rem}.p-4{padding:1rem}.p-6{padding:1.5rem}.py-5{padding:1.25rem 0}
.justify-center{justify-content:center}.justify-between{justify-content:space-between}
.rounded-full{border-radius:9999px}.w-52{width:13rem}.h-52{height:13rem}
.w-10{width:2.5rem}.h-10{height:2.5rem}.h-16{height:4rem}.top-2{top:.5rem}.right-4{right:1rem}
.bg-white{background:#fff}.bg-ft-gray{background:#e5e7eb}.opacity-40{opacity:.4}
.text-sm{font-size:.875rem}.text-2xl{font-size:1.5rem}
@media (min-width:768px){.md\\:h-96{height:24rem}.md\\:grid-cols-3{grid-template-columns:repeat(3,1fr)}}
@media (min-width:1024px){.lg\\:flex-row{flex-direction:row}}
`;

function readPageScript(name, replacements) {
  let src = fs.readFileSync(path.join(PAGE_DIR, name), "utf8");
  for (const [k, v] of Object.entries(replacements)) src = src.split(k).join(v);
  if (/<\/script/i.test(src)) throw new Error(`${name} must not contain a closing script tag`);
  return src;
}

/** The preload script (see page/instrument.js), as source text. */
export function instrumentSource() {
  return readPageScript("instrument.js", {});
}

/**
 * The one inline script of the page: it only records whether hook.js has
 * already wrapped window.fetch when an inline <script> in <head> runs. The
 * real Intra has no inline script, so this is information, not a check.
 * Left out when the page is served with a CSP (--csp): the policy would block
 * it and the report would be about the harness, not the extension.
 */
const INLINE_PROBE =
  "window.__smoke&&(window.__smoke.inlineHeadFetchWrapped=" +
  "!/\\[native code\\]/.test(Function.prototype.toString.call(window.fetch)));";

/**
 * The synthetic index.html, shaped like the real profile-v3 shell: an empty
 * #root, one module script and one stylesheet in <head> (plus the probe
 * above). The bundle gets a content hash in its name, like the real one, so
 * it is served from the cache on reloads.
 */
export function buildPage({ appDelay = 0, inlineProbe = true } = {}) {
  const bundle = readPageScript("app.js", {
    __LOGIN__: LOGIN,
    __APP_DELAY__: String(Number(appDelay) || 0),
  });
  const hash = crypto.createHash("sha256").update(bundle).digest("hex").slice(0, 8);
  const bundlePath = `/assets/index-${hash}.js`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${inlineProbe ? `<script>${INLINE_PROBE}</script>
` : ""}<link rel="icon" type="image/png" href="/favicon.ico" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>42 | Profile (Cuter Intra smoke test)</title>
<script type="module" crossorigin src="${bundlePath}"></script>
<link rel="stylesheet" href="/assets/index.css">
</head>
<body>
<div id="root"></div>
</body>
</html>
`;
  return { html, bundle, bundlePath };
}

/** A fake Keycloak access token, new for every login (unique jti). */
function mintJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload = {
    sub: LOGIN,
    preferred_username: LOGIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
  };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.smoke-signature`;
}

function isoDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/** The intrapy endpoints a profile page (the Intra and Cuter Intra) calls. */
function intrapyRoute(pathname) {
  const p = pathname.replace(/\/+$/, "");
  const user = { id: 4242, login: LOGIN, displayname: "Smoke Test", wallet: 42, correction_point: 3 };
  const routes = [
    [/^\/api\/v1\/users\/me$/, () => user],
    [/^\/api\/v1\/users\/me\/events$/, () => ({})],
    [/^\/api\/v1\/users\/[^/]+\/locations_stats$/, () => ({ [isoDay(-1)]: "04:12:00.000000", [isoDay(-2)]: "02:30:00.000000" })],
    [/^\/api\/v1\/users\/[^/]+\/projects$/, () => []],
    [/^\/api\/v1\/users\/[^/]+\/projects\/marked$/, () => []],
    [/^\/api\/v1\/users\/[^/]+\/achievements$/, () => []],
    [/^\/api\/v1\/users\/[^/]+\/cursus$/, () => []],
    [/^\/api\/v1\/users\/[^/]+\/campus$/, () => [{ id: CAMPUS.id, name: CAMPUS.name, is_primary: true }]],
    [/^\/api\/v1\/users\/[^/]+\/summary$/, () => ({})],
    [/^\/api\/v1\/users\/[^/]+$/, () => user],
  ];
  for (const [re, body] of routes) if (re.test(p)) return body();
  return undefined;
}

/**
 * @param {object} o
 * @param {{key: string, cert: string}} o.tls
 * @param {string[]} [o.extraHosts]   the builds' other host_permissions hosts
 * @param {string[]} [o.workerHosts]  hosts that answer like the Cuter Intra worker
 * @param {number} [o.port]           443 by default; 0 = any free port (proxy mode)
 * @param {string} [o.host]
 * @param {number} [o.appDelay]
 * @param {number} [o.authLatency]    ms before auth.42.fr answers the token request
 * @param {string|null} [o.csp]       Content-Security-Policy of the page. None by
 *                                    default: the real profile-v3 sends none.
 */
export async function startServer(o) {
  const {
    tls,
    extraHosts = [],
    workerHosts = [],
    port = 443,
    host = "127.0.0.1",
    appDelay = 0,
    authLatency = 30,
    csp = null,
  } = o;
  const log = [];
  const cspReports = [];
  const page = buildPage({ appDelay, inlineProbe: !csp });
  const workers = new Set(workerHosts);

  const handler = (req, res) => {
    const hostname = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const url = new URL(req.url, `https://${hostname || "localhost"}`);
    const origin = req.headers.origin;
    const entry = {
      at: Date.now(),
      host: hostname,
      method: req.method,
      path: url.pathname + url.search,
      auth: req.headers.authorization || null,
      origin: origin || null,
      status: 0,
    };
    log.push(entry);

    const send = (status, type, body, extra = {}) => {
      entry.status = status;
      const headers = { "Content-Type": type, "Cache-Control": "no-store", ...extra };
      if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Vary"] = "Origin";
      }
      res.writeHead(status, headers);
      res.end(body);
    };
    const json = (status, value) => send(status, "application/json", JSON.stringify(value));
    const cached = { "Cache-Control": "max-age=3600" };

    if (req.method === "OPTIONS") {
      return send(204, "text/plain", "", {
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          req.headers["access-control-request-headers"] || "authorization, content-type",
        "Access-Control-Max-Age": "600",
      });
    }

    if (url.pathname === "/__smoke/csp-report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        cspReports.push({ host: hostname, body });
        send(204, "text/plain", "");
      });
      return;
    }

    if (hostname === PROFILE_HOST) {
      if (url.pathname === "/" || url.pathname.startsWith("/users/")) {
        const headers = {};
        if (csp) headers["Content-Security-Policy"] = csp;
        return send(200, "text/html; charset=utf-8", page.html, headers);
      }
      if (url.pathname === page.bundlePath) {
        return send(200, "text/javascript; charset=utf-8", page.bundle, cached);
      }
      if (url.pathname === "/assets/index.css") return send(200, "text/css; charset=utf-8", PAGE_CSS, cached);
      if (url.pathname === "/favicon.ico") return send(200, "image/png", PNG_1PX, cached);
      return send(404, "text/plain", "not found");
    }

    if (hostname === AUTH_HOST && url.pathname === TOKEN_PATH && req.method === "POST") {
      req.resume();
      setTimeout(
        () => json(200, { access_token: mintJwt(), token_type: "Bearer", expires_in: 3600 }),
        authLatency,
      );
      return;
    }

    if (hostname === INTRAPY_HOST) {
      const body = intrapyRoute(url.pathname);
      if (body === undefined) return json(404, { detail: "Not found" });
      return json(200, body);
    }

    if (hostname === "cdn.intra.42.fr") return send(200, "image/png", PNG_1PX, cached);

    // No release (the background keeps its state), no star or follower count.
    if (hostname === GITHUB_API_HOST) return json(200, {});

    if (workers.has(hostname)) {
      // No announcement, and a one-campus list with an empty cluster file.
      // The real worker always answers these two: a 404 on either makes
      // fetchCampusList / loadCampusData throw, and some callers do not catch
      // it (an unhandled rejection the real site never shows).
      if (url.pathname === "/api/v1/public/announcement") return json(200, {});
      if (url.pathname === "/api/v1/public/stats") return json(200, {});
      if (url.pathname === "/gh/data/event_types.json") return json(200, { event_types: {} });
      if (url.pathname === "/gh/campuses/campuses.json") {
        return json(200, {
          campuses: [{ id: String(CAMPUS.id), name: CAMPUS.name, timezone: "Europe/Paris" }],
        });
      }
      if (url.pathname === `/gh/campuses/${CAMPUS.slug}.json`) {
        return json(200, { clusters: [], definitions: {}, exits: {} });
      }
    }

    return json(404, { error: "not stubbed by the smoke harness" });
  };

  const server = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  server.keepAliveTimeout = 5000;
  await listen(server, port, host);

  return {
    log,
    cspReports,
    hosts: [...new Set([...INTRA_HOSTS, ...extraHosts, ...workerHosts])],
    host,
    port: server.address().port,
    close: () => closeServer(server),
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * Fallback when 443 cannot be bound: an HTTP proxy that only knows CONNECT.
 * Firefox is pointed at it (network.proxy.*), asks it for
 * "CONNECT profile-v3.intra.42.fr:443", and the tunnel ends at the HTTPS
 * server on its random port. The browser still sees https://<host>/ on port
 * 443, so the origin is exact. Hosts the harness does not serve get a 403, so
 * nothing leaves the machine in this mode.
 */
export async function startConnectProxy({ targetHost, targetPort, allowedHosts }) {
  const allowed = new Set(allowedHosts);
  const sockets = new Set();
  const CRLF2 = "\r\n\r\n";
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(CRLF2);
      if (end === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      const [method, target] = head.subarray(0, end).toString("latin1").split(" ");
      const [host, port] = String(target).split(":");
      if (method !== "CONNECT" || port !== "443" || !allowed.has(String(host).toLowerCase())) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0" + CRLF2);
        return;
      }
      const upstream = net.connect(targetPort, targetHost, () => {
        client.write("HTTP/1.1 200 Connection Established" + CRLF2);
        const rest = head.subarray(end + CRLF2.length);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      const kill = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.on("error", kill);
      client.on("error", kill);
    };
    client.on("data", onData);
  });
  await listen(server, 0, "127.0.0.1");
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
