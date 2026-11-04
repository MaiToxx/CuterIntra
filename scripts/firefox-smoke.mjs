#!/usr/bin/env node
/**
 * Smoke test and timing harness for a Cuter Intra build.
 *
 *   node scripts/firefox-smoke.mjs <build-folder> [options]
 *   node scripts/firefox-smoke.mjs --compare <folderA> <folderB> [options]
 *   node scripts/firefox-smoke.mjs dist-chrome --browser chrome [options]
 *
 * Loads the build as a temporary add-on in a real Firefox (puppeteer-core over
 * WebDriver BiDi) or, with --browser chrome, as an unpacked extension in a
 * real Chrome (CDP), opens a synthetic Intra v3 page served locally but under
 * its real origin (https://profile-v3.intra.42.fr/), checks that the
 * extension works there, and times it. Exit code 0 when every check passed,
 * 1 when one failed, 2 for a usage error or a crash of the harness, 3 when
 * there is nothing to run on (no browser, no puppeteer-core): CI soft-skips
 * only 3 (firefox-smoke/browsers.mjs). docs/FIREFOX-TESTING.md explains what
 * is covered and how the DNS and certificate trick works. Timings are only
 * comparable within one browser.
 *
 * Options:
 *   --runs N        warm loads (reloads) in total, default 10
 *   --cold N        cold loads, each in a fresh Firefox profile, default 3
 *   --json          print one JSON document on stdout (progress goes to stderr)
 *   --headful       show the browser (timings differ from headless)
 *   --settle MS     wait after the gear shows before clicking it, default 1000
 *   --app-delay MS  the synthetic React app mounts after MS (default 0: when
 *                   its module script runs, before DOMContentLoaded)
 *   --auth-latency MS  the fake auth.42.fr answers the page's token request
 *                   after MS, default 30; the page's first intrapy request
 *                   waits for it, as on the real site
 *   --csp POLICY    serve the page with this Content-Security-Policy (the real
 *                   profile-v3 sends none)
 *   --proxy         use the CONNECT-proxy fallback instead of port 443
 *   --firefox PATH  Firefox binary (default: FIREFOX_BIN, then .browsers/)
 *   --browser B     firefox (default) or chrome
 *   --chrome PATH   Chrome binary (default: CHROME_BIN, then the platform's
 *                   usual install path)
 *   --no-sandbox    pass --no-sandbox to Chrome (needed as root, e.g. in CI)
 *   --verbose       also list every request and console message
 *
 * Needs puppeteer-core (a devDependency). Never writes into the build folder:
 * the add-on is installed from a temporary copy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessStop, exitCodeFor, loadPuppeteer, resolveChrome, resolveFirefox } from "./firefox-smoke/browsers.mjs";
import { makeSelfSignedCert } from "./firefox-smoke/cert.mjs";
import {
  CAMPUS,
  INTRA_HOSTS,
  PROFILE_HOST,
  harnessHosts,
  instrumentSource,
  startConnectProxy,
  startServer,
} from "./firefox-smoke/server.mjs";
import { readWorkerUrl } from "./repo-info.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_URL = `https://${PROFILE_HOST}/`;
const WAIT_MS = 10000;
const INSTALL_SETTLE_MS = 1000;

/* ------------------------------------------------------------------ CLI -- */

function usage(message) {
  if (message) process.stderr.write(`firefox-smoke: ${message}\n\n`);
  process.stderr.write(
    "usage: node scripts/firefox-smoke.mjs <build-folder> [--runs N] [--cold N] [--json]\n" +
      "       node scripts/firefox-smoke.mjs --compare <folderA> <folderB> [options]\n" +
      "options: --runs N --cold N --json --headful --settle MS --app-delay MS\n" +
      "         --auth-latency MS --csp POLICY --proxy --firefox PATH --verbose\n" +
      "         --browser firefox|chrome --chrome PATH --no-sandbox\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const o = {
    builds: [],
    compare: false,
    warm: 10,
    cold: 3,
    json: false,
    headful: false,
    settleMs: 1000,
    appDelay: 0,
    authLatency: 30,
    csp: null,
    proxy: false,
    firefox: process.env.FIREFOX_BIN || null,
    browser: "firefox",
    chrome: process.env.CHROME_BIN || null,
    noSandbox: false,
    verbose: false,
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) usage(`${name} needs a whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--compare") o.compare = true;
    else if (a === "--runs") o.warm = num(next(), a);
    else if (a === "--cold") o.cold = num(next(), a);
    else if (a === "--json") o.json = true;
    else if (a === "--headful") o.headful = true;
    else if (a === "--settle") o.settleMs = num(next(), a);
    else if (a === "--app-delay") o.appDelay = num(next(), a);
    else if (a === "--auth-latency") o.authLatency = num(next(), a);
    else if (a === "--csp") o.csp = next();
    else if (a === "--proxy") o.proxy = true;
    else if (a === "--firefox") o.firefox = next();
    else if (a === "--browser") o.browser = next();
    else if (a === "--chrome") o.chrome = next();
    else if (a === "--no-sandbox") o.noSandbox = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "-h" || a === "--help") usage();
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else o.builds.push(a);
  }
  if (o.compare && o.builds.length !== 2) usage("--compare needs exactly two build folders");
  if (!o.compare && o.builds.length !== 1) usage("give one build folder (or --compare A B)");
  if (o.cold < 1) usage("--cold must be at least 1");
  if (o.browser !== "firefox" && o.browser !== "chrome") usage("--browser must be firefox or chrome");
  return o;
}

/* --------------------------------------------------------------- set-up -- */

function readBuild(dir) {
  const abs = path.resolve(dir);
  const manifestPath = path.join(abs, "manifest.json");
  if (!fs.existsSync(manifestPath)) usage(`${dir}: no manifest.json (not a build folder)`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const intraScripts = (manifest.content_scripts || []).filter((c) =>
    (c.matches || []).some((m) => m.includes("intra.42.fr")),
  );
  const { hosts, workerHosts } = harnessHosts(manifest, readWorkerUrl());
  return {
    dir: abs,
    label: path.basename(abs),
    name: manifest.name,
    version: manifest.version,
    contentScripts: intraScripts.flatMap((c) => c.js || []),
    hosts,
    workerHosts,
  };
}

async function startNetwork(opts, builds, log) {
  const extraHosts = [...new Set(builds.flatMap((b) => b.hosts))];
  const workerHosts = [...new Set(builds.flatMap((b) => b.workerHosts))];
  const names = [...new Set([...INTRA_HOSTS, "*.intra.42.fr", ...extraHosts, ...workerHosts])];
  const tls = makeSelfSignedCert(names);
  const common = {
    tls,
    extraHosts,
    workerHosts,
    appDelay: opts.appDelay,
    authLatency: opts.authLatency,
    csp: opts.csp,
  };

  let server = null;
  if (opts.browser === "chrome") {
    // Chrome resolves the hosts itself (--host-resolver-rules, port included),
    // so no port 443, no proxy and no prefs.
    server = await startServer({ ...common, port: 0 });
    return {
      server,
      mode: `--host-resolver-rules -> 127.0.0.1:${server.port}`,
      prefs: {},
      close: () => server.close(),
    };
  }
  if (!opts.proxy) {
    try {
      server = await startServer({ ...common, port: 443 });
    } catch (e) {
      if (!["EADDRINUSE", "EACCES", "EPERM"].includes(e && e.code)) throw e;
      log(`port 443 unavailable (${e.code}): falling back to the CONNECT proxy`);
    }
  }
  if (server) {
    return {
      server,
      mode: "port 443 + network.dns.localDomains",
      prefs: { "network.dns.localDomains": server.hosts.join(",") },
      close: () => server.close(),
    };
  }
  server = await startServer({ ...common, port: 0 });
  const proxy = await startConnectProxy({
    targetHost: server.host,
    targetPort: server.port,
    allowedHosts: server.hosts,
  });
  return {
    server,
    mode: `CONNECT proxy 127.0.0.1:${proxy.port} -> HTTPS 127.0.0.1:${server.port}`,
    prefs: {
      "network.proxy.type": 1,
      "network.proxy.share_proxy_settings": false,
      "network.proxy.ssl": "127.0.0.1",
      "network.proxy.ssl_port": proxy.port,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": proxy.port,
      "network.proxy.no_proxies_on": "",
      "network.proxy.allow_hijacking_localhost": true,
    },
    close: async () => {
      await proxy.close();
      await server.close();
    },
  };
}

/* ---------------------------------------------------------- page probes -- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: everything the checks need, as plain JSON. */
function collectState() {
  const s = window.__smoke || null;
  const count = (sel) => document.querySelectorAll(sel).length;
  const ids = {};
  for (const el of document.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1;
  const perf = document.getElementById("better-intra-perf");
  const dialog = document.getElementById("hub-dialog");
  const nav = performance.getEntriesByType("navigation")[0];
  let token = null;
  try {
    token = sessionStorage.getItem("ft_intrapy_token");
  } catch {}
  return {
    smoke: s ? JSON.parse(JSON.stringify(s)) : null,
    html: {
      cls: document.documentElement.className,
      theme: document.documentElement.getAttribute("data-theme"),
    },
    links: [...document.querySelectorAll("link[data-better-intra-theme]")].map((l) => ({
      name: l.dataset.betterIntraTheme,
      media: l.media,
      id: l.id,
      loaded: !!l.sheet,
      file: l.href.replace(/^[a-z-]+:\/\/[^/]+\//, ""),
    })),
    perfCssLength: perf ? (perf.textContent || "").length : -1,
    counts: {
      gear: count("#hub-gear-btn"),
      dialog: count("#hub-dialog"),
      clusters: count("#ft-clusters-btn"),
      perf: count("#better-intra-perf"),
      preset: count("#better-intra-theme-preset"),
      logtime: count("#logtime-shadow-wrapper"),
      modulepreload: count('link[rel="modulepreload"]'),
    },
    dialogOpen: dialog ? dialog.open : null,
    duplicateIds: Object.entries(ids).filter(([, n]) => n > 1),
    nav: nav
      ? { type: nav.type, dcl: nav.domContentLoadedEventStart, load: nav.loadEventStart }
      : null,
    storedToken: token,
  };
}

async function waitInPage(page, predicate, timeout, ...args) {
  try {
    await page.waitForFunction(predicate, { timeout, polling: 50 }, ...args);
    return true;
  } catch {
    return false;
  }
}

/** Click the gear and wait for the hub (open, then rendered unless `openOnly`). */
async function clickGear(page, index, openOnly) {
  const ok = await page
    .click("#hub-gear-btn")
    .then(() => true)
    .catch(() => false);
  if (!ok) return { clicked: false };
  const done = await waitInPage(
    page,
    (i, onlyOpen) => {
      const c = window.__smoke && window.__smoke.clicks[i];
      return !!c && c.openAt !== null && (onlyOpen || c.renderedAt !== null);
    },
    WAIT_MS,
    index,
    openOnly,
  );
  const record = await page.evaluate((i) => {
    const c = window.__smoke && window.__smoke.clicks[i];
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }, index);
  return { clicked: true, done, record };
}

async function closeHub(page) {
  await page.keyboard.press("Escape").catch(() => {});
  const closed = await waitInPage(
    page,
    () => {
      const d = document.getElementById("hub-dialog");
      return !d || !d.open;
    },
    2000,
  );
  if (!closed) {
    await page
      .evaluate(() => {
        const d = document.getElementById("hub-dialog");
        if (d && d.open) d.close();
      })
      .catch(() => {});
  }
  return closed;
}

/* --------------------------------------------------------------- a load -- */

async function measureLoad(page, net, meta, events, settleMs) {
  const logStart = net.server.log.length;
  const load = { ...meta, console: [], pageErrors: [], unservedRequests: [], navError: null };
  events.current = load;
  try {
    if (meta.kind === "cold") await page.goto(PAGE_URL, { waitUntil: "load", timeout: 30000 });
    else await page.reload({ waitUntil: "load", timeout: 30000 });
  } catch (e) {
    load.navError = String((e && e.message) || e);
  }
  load.gearAppeared = await waitInPage(
    page,
    () => {
      const s = window.__smoke;
      return !!s && s.marks.gear !== undefined && !!s.api && s.api.doneAt !== undefined;
    },
    WAIT_MS,
  );
  await sleep(settleMs);
  load.before = await page.evaluate(collectState).catch((e) => ({ error: String(e) }));
  load.click1 = await clickGear(page, 0, false);
  load.closed1 = await closeHub(page);
  load.click2 = await clickGear(page, 1, true);
  // Time for a second graph instance (created by the first lazy import) to
  // get through its start-up and show itself (see e.single-instance).
  await sleep(500);
  load.after = await page.evaluate(collectState).catch((e) => ({ error: String(e) }));
  await closeHub(page);
  load.requests = net.server.log.slice(logStart).map((r) => ({
    host: r.host,
    method: r.method,
    path: r.path,
    status: r.status,
    auth: r.auth ? (r.auth === load.after?.smoke?.api?.token ? "page token" : "other") : null,
  }));
  events.current = null;
  return load;
}

async function runSession(puppeteer, opts, net, build, sessionIndex, loadsInSession, log) {
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "better-intra-smoke-"));
  const copy = path.join(copyRoot, "extension");
  fs.cpSync(build.dir, copy, { recursive: true });
  const session = {
    index: sessionIndex,
    build: build.label,
    loads: [],
    orphanConsole: [],
    unservedRequests: [],
    error: null,
  };
  const events = { current: null };
  let browser = null;
  try {
    browser = await puppeteer.launch(
      opts.browser === "chrome"
        ? {
            browser: "chrome",
            // installExtension needs the pipe transport and enableExtensions.
            pipe: true,
            enableExtensions: true,
            executablePath: opts.chromePath,
            headless: !opts.headful,
            acceptInsecureCerts: true,
            defaultViewport: { width: 1280, height: 900 },
            args: [
              `--host-resolver-rules=${net.server.hosts.map((h) => `MAP ${h} 127.0.0.1:${net.server.port}`).join(", ")}`,
              "--ignore-certificate-errors",
              ...(opts.noSandbox ? ["--no-sandbox"] : []),
            ],
          }
        : {
            browser: "firefox",
            protocol: "webDriverBiDi",
            executablePath: opts.firefoxPath,
            headless: !opts.headful,
            acceptInsecureCerts: true,
            defaultViewport: { width: 1280, height: 900 },
            extraPrefsFirefox: {
              ...net.prefs,
              "network.trr.mode": 5, // no DNS over HTTPS: localDomains must win
              "extensions.update.enabled": false,
            },
          },
    );
    session.browser = await browser.version();
    session.extensionId = await browser.installExtension(copy);
    await sleep(INSTALL_SETTLE_MS);
    const page = (await browser.pages())[0] || (await browser.newPage());

    page.on("console", (m) => {
      const loc = m.location() || {};
      const entry = {
        type: m.type(),
        text: m.text().slice(0, 500),
        url: String(loc.url || "").replace(/^([a-z-]+:\/\/)[^/]+\//, "$1<id>/"),
        line: loc.lineNumber,
        extension: /^(moz|chrome)-extension:/.test(String(loc.url || "")),
      };
      (events.current ? events.current.console : session.orphanConsole).push(entry);
    });
    page.on("pageerror", (e) => {
      const entry = { message: String((e && e.message) || e).slice(0, 500), stack: String((e && e.stack) || "").slice(0, 800) };
      (events.current ? events.current.pageErrors : session.orphanConsole).push({ type: "pageerror", ...entry });
    });

    // BiDi and CDP report the page's and the content script's http(s)
    // requests (not the extension's own file loads). One to a host the
    // harness does not serve went to the real network (port 443 and Chrome
    // modes) or was refused (proxy mode).
    const served = new Set(net.server.hosts);
    page.on("request", (r) => {
      let host = "";
      try {
        const u = new URL(r.url());
        if (u.protocol !== "https:" && u.protocol !== "http:") return;
        host = u.hostname;
      } catch {
        return;
      }
      if (!served.has(host)) {
        (events.current ? events.current.unservedRequests : session.unservedRequests).push(r.url().slice(0, 200));
      }
    });

    await page.evaluateOnNewDocument(instrumentSource());

    for (let i = 0; i < loadsInSession; i++) {
      const kind = i === 0 ? "cold" : "warm";
      log(`  ${build.label}: session ${sessionIndex + 1}, ${kind} load${kind === "warm" ? ` ${i}` : ""}`);
      session.loads.push(await measureLoad(page, net, { kind, session: sessionIndex, index: i }, events, opts.settleMs));
    }
  } catch (e) {
    session.error = String((e && e.stack) || e);
    log(`  ${build.label}: session ${sessionIndex + 1} failed: ${String((e && e.message) || e)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return session;
}

/* --------------------------------------------------------------- checks -- */

const SHEET_FOR_THEME = { dark: "darkV3", light: "lightV3" };

/** One load -> [{ id, ok, detail }]. */
function checkLoad(load) {
  const out = [];
  const add = (id, ok, detail = "") => out.push({ id, ok: !!ok, detail });
  const b = load.before && !load.before.error ? load.before : null;
  const a = load.after && !load.after.error ? load.after : null;
  const s = (a && a.smoke) || (b && b.smoke) || null;
  if (load.navError) add("navigation", false, load.navError);
  if (!s) {
    add("instrumentation", false, "window.__smoke missing: the page or the preload script did not run");
    return out;
  }
  const hookScripts = (s.extensionScripts || []).filter((x) => /(^|\/)hook\.js$/.test(x.file));
  const extScripts = (s.extensionScripts || []).map((x) => x.file);

  // hook.js is either a MAIN-world content script (no <script> tag at all)
  // or, in builds before 1.11.1, a <script src> appended by content.js.
  const hookRan = hookScripts.length > 0 || (s.api && s.api.fetchWrappedAtFirstRequest === true);
  add(
    "content-script",
    hookRan || s.marks.gear !== undefined,
    hookRan || s.marks.gear !== undefined
      ? ""
      : "no hook.js and no gear: the content scripts did not run (host permissions not granted?)",
  );

  // a. hook.js in place before the Intra's first API request, token captured.
  add(
    "a.hook-first",
    s.api && s.api.fetchWrappedAtFirstRequest === true,
    !s.app || s.app.moduleAt === undefined
      ? "the Intra bundle did not run"
      : s.api && s.api.fetchWrappedAtFirstRequest !== undefined
        ? `fetch wrapped at the first intrapy request: ${s.api.fetchWrappedAtFirstRequest}`
        : `the page never logged in (${(s.api && s.api.error) || "no token"})`,
  );
  const token = s.api && s.api.token;
  const stored = s.api && s.api.tokenStoredAfterFirstFetch;
  const evented = (s.tokenEvents || []).some((e) => e.detail === token);
  add(
    "a.token-captured",
    !!token && stored === token && evented,
    !token
      ? "the page did not send its request"
      : `sessionStorage ft_intrapy_token after the first request: ${stored === token ? "this load's token" : stored ? "an older token" : "empty"}; 42_INTRAPY_TOKEN with it: ${evented}`,
  );
  add(
    "a.hook-relays",
    s.api && s.api.cursusStored === "21" && s.campusEvent === String(CAMPUS.id),
    `ft_active_cursus_id=${s.api && s.api.cursusStored}; 42_CAMPUS_DETECTED=${s.campusEvent ?? "none"}`,
  );

  // b. the app code runs.
  add("b.gear", load.gearAppeared && s.marks.gear !== undefined, s.marks.gear === undefined ? "#hub-gear-btn never appeared" : "");
  if (a) {
    const want = SHEET_FOR_THEME[a.html.theme];
    const enabled = a.links.filter((l) => l.media !== "not all");
    const cls = a.html.cls.split(/\s+/);
    const themeOk =
      !!want &&
      cls.includes("dark") === (a.html.theme === "dark") &&
      enabled.length === 1 &&
      enabled[0].name === want &&
      enabled[0].id === "better-intra-theme-stylesheet" &&
      enabled[0].loaded;
    add(
      "b.theme",
      themeOk,
      `data-theme=${a.html.theme}; html.class="${a.html.cls}"; sheets: ${a.links.map((l) => `${l.name}(${l.media}${l.loaded ? "" : ", not loaded"})`).join(", ") || "none"}`,
    );
    add("b.perf-styles", a.counts.perf === 1 && a.perfCssLength > 0, `#better-intra-perf: ${a.counts.perf}, ${a.perfCssLength} chars`);
    add(
      "b.clusters-button",
      a.counts.clusters === 1,
      load.kind === "cold"
        ? "fresh profile: the campus is only known through 42_CAMPUS_DETECTED"
        : "campus already stored",
    );
  }

  // c. lazy code: the hub.
  const c1 = load.click1 || {};
  const r1 = c1.record || {};
  add(
    "c.hub-opens",
    c1.clicked && r1.openAt !== null && r1.openAt !== undefined && r1.renderedAt !== null && r1.renderedAt !== undefined,
    !c1.clicked ? "could not click #hub-gear-btn" : `open: ${r1.openAt != null}, content rendered: ${r1.renderedAt != null}`,
  );
  const c2 = load.click2 || {};
  const r2 = c2.record || {};
  add(
    "c.hub-reopens",
    c2.clicked && r2.openAt != null && r2.dialogExisted === true && load.closed1,
    !c2.clicked ? "could not click #hub-gear-btn again" : `closed with Escape: ${load.closed1}; reopened: ${r2.openAt != null}; same dialog: ${r2.dialogExisted}`,
  );

  // d. errors, console, CSP.
  const pageErrors = [...load.pageErrors, ...(s.errors || []).map((e) => ({ message: `${e.message} (${e.source}:${e.line})` })), ...(s.rejections || []).map((m) => ({ message: `unhandled rejection: ${m}` }))];
  add("d.no-page-errors", pageErrors.length === 0, pageErrors.map((e) => e.message).join(" | "));
  const badConsole = load.console.filter((m) => m.type === "error" || (m.extension && (m.type === "warn" || m.type === "warning")));
  add(
    "d.no-console-errors",
    badConsole.length === 0,
    badConsole.map((m) => `[${m.type}] ${m.text} ${m.url ? `(${m.url}:${m.line})` : ""}`).join(" | "),
  );
  const cspConsole = load.console.filter((m) => /content[- ]security[- ]policy|\bCSP\b/i.test(m.text));
  const cspCount = (s.csp || []).length + cspConsole.length;
  add(
    "d.no-csp-report",
    cspCount === 0,
    [...(s.csp || []).map((v) => `${v.disposition} ${v.directive} blocked ${v.blocked} (${v.source})`), ...cspConsole.map((m) => m.text)].join(" | "),
  );
  add(
    "d.no-preload-helper",
    (s.preloadErrors || []).length === 0 && (!a || a.counts.modulepreload === 0),
    `vite:preloadError: ${(s.preloadErrors || []).length}; link[rel=modulepreload]: ${a ? a.counts.modulepreload : "?"}`,
  );

  // e. one instance of the app.
  if (a) {
    const perSheet = {};
    for (const l of a.links) perSheet[l.name] = (perSheet[l.name] || 0) + 1;
    const problems = [];
    // 0 tags: MAIN-world hook (1.11.1+); 1 tag: injected hook (older builds)
    if (hookScripts.length > 1) problems.push(`hook.js injected ${hookScripts.length}x`);
    if (a.counts.gear !== 1) problems.push(`#hub-gear-btn x${a.counts.gear}`);
    if (a.counts.dialog !== 1) problems.push(`#hub-dialog x${a.counts.dialog} after two opens`);
    if (a.counts.clusters > 1) problems.push(`#ft-clusters-btn x${a.counts.clusters}`);
    if (a.counts.perf > 1) problems.push(`#better-intra-perf x${a.counts.perf}`);
    if (a.counts.preset > 1) problems.push(`#better-intra-theme-preset x${a.counts.preset}`);
    if (a.counts.logtime > 1) problems.push(`#logtime-shadow-wrapper x${a.counts.logtime}`);
    for (const [name, n] of Object.entries(perSheet)) if (n > 1) problems.push(`theme sheet ${name} x${n}`);
    for (const [id, n] of a.duplicateIds) problems.push(`duplicate id #${id} x${n}`);
    const logtimeRequests = (s.logtimeRequests || []).length;
    if (logtimeRequests > 1) problems.push(`42_LOGTIME_REQUEST x${logtimeRequests} (one per logtime module instance)`);
    // A test build may carry console.count("better-intra graph") at the top
    // of main.ts (docs/CODE-SPLITTING.md, test plan): it must never pass 1.
    const graphCounts = load.console
      .map((m) => /better-intra graph: (\d+)/.exec(m.text))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    const graph = graphCounts.length ? Math.max(...graphCounts) : null;
    if (graph !== null && graph > 1) problems.push(`console.count("better-intra graph") reached ${graph}`);
    add(
      "e.single-instance",
      problems.length === 0,
      problems.length
        ? problems.join("; ")
        : `scripts inserted: ${extScripts.join(", ") || "none"}; 42_LOGTIME_REQUEST x${logtimeRequests}; graph count: ${graph ?? "no console.count"}`,
    );
  }
  return out;
}

/* --------------------------------------------------------------- timing -- */

const METRICS = [
  ["hookInjected", "hook.js inserted (content script sync part done)"],
  ["themeLink", "theme <link> inserted"],
  ["perfStyle", "perf <style> inserted"],
  ["dcl", "DOMContentLoaded"],
  ["gear", "(i) #hub-gear-btn inserted"],
  ["hubOpen", "(ii) gear click -> #hub-dialog open"],
  ["hubRendered", "gear click -> hub content rendered"],
  ["hubReopen", "2nd click -> #hub-dialog open"],
];

function loadTimings(load) {
  const st = (load.after && !load.after.error && load.after) || (load.before && !load.before.error && load.before);
  const s = st && st.smoke;
  if (!s) return {};
  const t = {};
  const m = s.marks || {};
  for (const k of ["hookInjected", "themeLink", "perfStyle", "gear"]) if (m[k] !== undefined) t[k] = m[k];
  if (st.nav && st.nav.dcl) t.dcl = st.nav.dcl;
  const r1 = load.click1 && load.click1.record;
  if (r1 && r1.openAt != null) t.hubOpen = r1.openAt - r1.at;
  if (r1 && r1.renderedAt != null) t.hubRendered = r1.renderedAt - r1.at;
  const r2 = load.click2 && load.click2.record;
  if (r2 && r2.openAt != null) t.hubReopen = r2.openAt - r2.at;
  return t;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const r = (x) => Math.round(x * 10) / 10;
  return {
    n: v.length,
    median: r(quantile(v, 0.5)),
    p25: r(quantile(v, 0.25)),
    p75: r(quantile(v, 0.75)),
    min: r(v[0]),
    max: r(v[v.length - 1]),
  };
}

/* -------------------------------------------------------------- summary -- */

function summarise(build, sessions) {
  const loads = sessions.flatMap((s) => s.loads);
  const checkIds = [];
  const agg = {};
  for (const load of loads) {
    for (const c of checkLoad(load)) {
      if (!agg[c.id]) {
        agg[c.id] = { id: c.id, pass: 0, fail: 0, failures: [], sample: c.detail };
        checkIds.push(c.id);
      }
      if (c.ok) agg[c.id].pass++;
      else {
        agg[c.id].fail++;
        if (agg[c.id].failures.length < 3) agg[c.id].failures.push(`${load.kind} s${load.session + 1}#${load.index}: ${c.detail}`);
      }
    }
  }
  for (const s of sessions) {
    if (s.error) {
      agg["session"] = agg["session"] || { id: "session", pass: 0, fail: 0, failures: [], sample: "" };
      if (!checkIds.includes("session")) checkIds.push("session");
      agg["session"].fail++;
      agg["session"].failures.push(`session ${s.index + 1}: ${s.error.split("\n")[0]}`);
    }
  }
  const checks = checkIds.map((id) => ({ ...agg[id], ok: agg[id].fail === 0 && agg[id].pass > 0 }));

  const timings = {};
  for (const kind of ["cold", "warm"]) {
    const ts = loads.filter((l) => l.kind === kind).map(loadTimings);
    timings[kind] = {};
    for (const [key] of METRICS) timings[kind][key] = stats(ts.map((t) => t[key]));
  }

  const themeBefore = loads.filter((l) => {
    const s = l.after && l.after.smoke;
    return s && s.marks.themeLink !== undefined && s.marks.head !== undefined && s.marks.themeLink <= s.marks.head;
  }).length;
  const extConsole = loads.flatMap((l) => l.console.filter((m) => m.extension));
  const otherConsole = loads.flatMap((l) => l.console.filter((m) => !m.extension));
  const smokeOf = (l) => (l.after && l.after.smoke) || (l.before && l.before.smoke) || {};
  const inlineWrapped = loads.map((l) => smokeOf(l).inlineHeadFetchWrapped);
  const bundleWrapped = (kind) => {
    const ls = loads.filter((l) => l.kind === kind);
    return `${ls.filter((l) => smokeOf(l).app && smokeOf(l).app.fetchWrappedAtModule === true).length}/${ls.length}`;
  };
  const notFound = new Map();
  for (const l of loads) for (const r of l.requests || []) if (r.status === 404) notFound.set(`${r.host}${r.path}`, (notFound.get(`${r.host}${r.path}`) || 0) + 1);

  return {
    build: { label: build.label, dir: build.dir, name: build.name, version: build.version, contentScripts: build.contentScripts },
    browser: sessions.find((s) => s.browser)?.browser || null,
    loads: { cold: loads.filter((l) => l.kind === "cold").length, warm: loads.filter((l) => l.kind === "warm").length },
    ok: checks.every((c) => c.ok) && loads.length > 0,
    checks,
    timings,
    info: {
      themeLinkBeforeHead: `${themeBefore}/${loads.length}`,
      inlineHeadScriptSawWrappedFetch: inlineWrapped.every((x) => x === undefined)
        ? "not measured (no inline probe with --csp)"
        : `${inlineWrapped.filter((x) => x === true).length}/${loads.length}`,
      bundleStartSawWrappedFetch: { cold: bundleWrapped("cold"), warm: bundleWrapped("warm") },
      extensionConsole: dedupe(extConsole.map((m) => `[${m.type}] ${m.text} (${m.url}:${m.line})`)),
      otherConsole: dedupe(otherConsole.map((m) => `[${m.type}] ${m.text}`)),
      orphanConsole: dedupe(sessions.flatMap((s) => s.orphanConsole.map((m) => `[${m.type}] ${m.text || m.message}`))),
      stubbed404: [...notFound.entries()].map(([k, n]) => `${k} x${n}`),
      unservedRequests: dedupe([...loads.flatMap((l) => l.unservedRequests), ...sessions.flatMap((s) => s.unservedRequests)]),
    },
    sessions,
  };
}

function dedupe(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].map(([x, n]) => (n > 1 ? `${x} (x${n})` : x));
}

const fmt = (st) => (st ? `${st.median} [${st.p25}-${st.p75}] ${st.min}-${st.max}` : "-");
const pad = (s, n) => String(s).padEnd(n);

function printReport(summary, opts, net, out) {
  const b = summary.build;
  out(`\nCuter Intra smoke test: ${b.label} (${b.name} ${b.version}, content scripts: ${b.contentScripts.join(", ")})`);
  out(`${summary.browser || `${opts.browser} ?`} ${opts.headful ? "headful" : "headless"}; ${net.mode}; ${summary.loads.cold} cold + ${summary.loads.warm} warm loads\n`);
  out("Checks");
  for (const c of summary.checks) {
    out(`  ${c.ok ? "PASS" : "FAIL"}  ${pad(c.id, 22)} ${c.pass}/${c.pass + c.fail} loads${c.ok ? (c.sample ? `  (${c.sample})` : "") : ""}`);
    for (const f of c.failures) out(`          ${f}`);
  }
  out("\nTimings in ms (performance.now() in the page; median [p25-p75] min-max)");
  out(`  ${pad("", 52)}${pad(`cold (n=${summary.loads.cold})`, 28)}warm (n=${summary.loads.warm})`);
  for (const [key, label] of METRICS) {
    out(`  ${pad(label, 52)}${pad(fmt(summary.timings.cold[key]), 28)}${fmt(summary.timings.warm[key])}`);
  }
  out("\nInformation");
  out(`  theme <link> inserted before <head> was parsed: ${summary.info.themeLinkBeforeHead} loads`);
  out(`  hook.js already in place when the Intra bundle started: cold ${summary.info.bundleStartSawWrappedFetch.cold}, warm ${summary.info.bundleStartSawWrappedFetch.warm} loads`);
  out(`  an inline <script> in <head> saw fetch already wrapped: ${summary.info.inlineHeadScriptSawWrappedFetch} loads (the real Intra has no inline script)`);
  const list = (title, items) => {
    out(`  ${title}: ${items.length ? "" : "none"}`);
    for (const i of items) out(`    ${i}`);
  };
  list("console messages from the extension", summary.info.extensionConsole);
  list("other console messages", summary.info.otherConsole);
  if (summary.info.orphanConsole.length) list("console messages outside a measured load", summary.info.orphanConsole);
  list("requests answered 404 by the stubs", summary.info.stubbed404);
  list("requests to hosts the harness does not serve", summary.info.unservedRequests);
  if (opts.verbose) {
    for (const s of summary.sessions) {
      for (const l of s.loads) {
        out(`  -- ${l.kind} load, session ${l.session + 1} #${l.index}`);
        for (const r of l.requests) out(`     ${r.status} ${r.method} ${r.host}${r.path}${r.auth ? ` [auth: ${r.auth}]` : ""}`);
        for (const m of l.console) out(`     console [${m.type}] ${m.text} ${m.url}`);
      }
    }
  }
  out(`\nResult: ${summary.ok ? "PASS" : "FAIL"}`);
}

function printCompare(sa, sb, out) {
  out(`\nComparison: A = ${sa.build.label}, B = ${sb.build.label} (ms, median [p25-p75]; delta = B - A on the medians)`);
  for (const kind of ["cold", "warm"]) {
    out(`\n  ${kind} (A n=${sa.loads[kind]}, B n=${sb.loads[kind]})`);
    out(`  ${pad("", 52)}${pad("A", 20)}${pad("B", 20)}delta`);
    for (const [key, label] of METRICS) {
      const a = sa.timings[kind][key];
      const b = sb.timings[kind][key];
      const short = (st) => (st ? `${st.median} [${st.p25}-${st.p75}]` : "-");
      let delta = "-";
      if (a && b) {
        const d = Math.round((b.median - a.median) * 10) / 10;
        const pct = a.median ? ` (${d >= 0 ? "+" : ""}${Math.round((d / a.median) * 100)}%)` : "";
        delta = `${d >= 0 ? "+" : ""}${d}${pct}`;
      }
      out(`  ${pad(label, 52)}${pad(short(a), 20)}${pad(short(b), 20)}${delta}`);
    }
  }
  const race = (x) => `cold ${x.info.bundleStartSawWrappedFetch.cold}, warm ${x.info.bundleStartSawWrappedFetch.warm}`;
  out(`\n  hook.js in place when the Intra bundle started: A ${race(sa)}; B ${race(sb)}`);
  out(`  checks: A ${sa.ok ? "PASS" : "FAIL"}, B ${sb.ok ? "PASS" : "FAIL"}`);
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`${m}\n`);
  const out = opts.json ? log : (m) => process.stdout.write(`${m}\n`);
  const builds = opts.builds.map(readBuild);
  if (opts.browser === "chrome") opts.chromePath = resolveChrome(opts.chrome);
  else opts.firefoxPath = resolveFirefox(opts.firefox, path.join(ROOT, ".browsers", "firefox"));
  const binary = opts.chromePath || opts.firefoxPath;
  const puppeteer = await loadPuppeteer();
  const net = await startNetwork(opts, builds, log);
  log(`firefox-smoke: ${path.relative(ROOT, binary) || binary}; ${net.mode}`);

  // Every session starts with one cold load; the warm loads are spread over
  // the sessions (10 over 3 sessions: 4, 3, 3).
  const perSession = Array.from(
    { length: opts.cold },
    (_, s) => 1 + Math.floor(opts.warm / opts.cold) + (s < opts.warm % opts.cold ? 1 : 0),
  );
  const sessions = builds.map(() => []);
  let summaries;
  try {
    for (let s = 0; s < opts.cold; s++) {
      // Alternate the order in --compare so that neither build always goes first.
      const order = s % 2 === 0 ? [...builds.keys()] : [...builds.keys()].reverse();
      for (const i of order) {
        sessions[i].push(await runSession(puppeteer, opts, net, builds[i], s, perSession[s], log));
      }
    }
    summaries = builds.map((b, i) => summarise(b, sessions[i]));
  } finally {
    await net.close();
  }

  if (opts.json) {
    const doc = {
      tool: "firefox-smoke",
      date: new Date().toISOString(),
      network: net.mode,
      browser: opts.browser,
      options: {
        cold: opts.cold,
        warm: opts.warm,
        settleMs: opts.settleMs,
        appDelay: opts.appDelay,
        authLatency: opts.authLatency,
        csp: opts.csp,
        headful: opts.headful,
      },
      results: summaries,
    };
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    for (const s of summaries) printReport(s, opts, net, out);
    if (opts.compare) printCompare(summaries[0], summaries[1], out);
  }
  process.exitCode = summaries.every((s) => s.ok) ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`firefox-smoke: ${e instanceof HarnessStop ? e.message : (e && e.stack) || e}\n`);
  process.exitCode = exitCodeFor(e);
});
