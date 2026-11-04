# Firefox (and Chrome) testing

`scripts/firefox-smoke.mjs` loads a build of Cuter Intra into a real Firefox
(or, with `--browser chrome`, a real Chrome: see [Chrome](#chrome)), opens a
synthetic Intra v3 page that the browser believes is
`https://profile-v3.intra.42.fr/`, checks that the extension works there, and
times it. It exists to compare the current IIFE content script with the ES
module split described in [CODE-SPLITTING.md](CODE-SPLITTING.md), but it runs
on any build folder.

It is a smoke test, not a replacement for the manual test plan in
CODE-SPLITTING.md: see [What it does not cover](#what-it-does-not-cover).

## Running it

```sh
# puppeteer-core is a devDependency: npm install is enough
node scripts/firefox-smoke.mjs dist-baseline-iife               # 3 cold + 10 warm loads
node scripts/firefox-smoke.mjs dist-split-firefox --runs 30 --cold 6
node scripts/firefox-smoke.mjs --compare dist-baseline-iife dist-split-firefox
node scripts/firefox-smoke.mjs dist-firefox --json > smoke.json
npm run smoke:chrome -- dist-chrome --runs 3 --cold 1           # the Chrome build, in Chrome
```

The exit code is 0 when every check passed on every load, 1 when one failed,
2 for a usage error or a crash of the harness, and 3 when there is nothing to
run on: no browser found, or puppeteer-core not installed
(`scripts/firefox-smoke/browsers.mjs`). CI treats only 3 as "skipped". A
default run takes about 25 s per build, and `--compare` about a minute.

| option | default | what it does |
| --- | --- | --- |
| `--runs N` | 10 | warm loads in total (reloads, spread over the cold sessions) |
| `--cold N` | 3 | cold loads: each one starts a new Firefox with a new profile |
| `--compare A B` | | runs both builds, interleaved (A B, B A, A B, ...), and prints the timings side by side |
| `--json` | | one JSON document on stdout, with every raw measurement; progress goes to stderr |
| `--headful` | headless | shows the browser; timings then differ from headless ones |
| `--settle MS` | 1000 | wait between the gear appearing and the first click, so the click is timed on a quiet page |
| `--app-delay MS` | 0 | the synthetic app mounts MS after its module script runs (see [The page](#the-synthetic-page)) |
| `--auth-latency MS` | 30 | how long the fake auth.42.fr takes to answer the page's token request |
| `--csp POLICY` | none | serve the page with this `Content-Security-Policy` (the real profile-v3 sends none) |
| `--proxy` | | force the CONNECT-proxy fallback instead of port 443 |
| `--firefox PATH` | | the Firefox binary; otherwise `FIREFOX_BIN`, otherwise the newest one under `.browsers/firefox/` |
| `--browser B` | firefox | `firefox` or `chrome` (see [Chrome](#chrome)) |
| `--chrome PATH` | | the Chrome binary; otherwise `CHROME_BIN`, otherwise the platform's usual install path |
| `--no-sandbox` | | passes `--no-sandbox` to Chrome (needed when running as root, e.g. in CI) |
| `--verbose` | | also prints every request and console message, per load |

Firefox: the harness never downloads a browser. It looks under `.browsers/`
(gitignored), which is the layout `npx @puppeteer/browsers install
firefox@stable --path .browsers` produces. The runs below used a portable
Firefox 156 from there. To test the `strict_min_version`, point `--firefox` at
a Firefox 140 ESR.

The build folder is never written to. Each session copies it to a temporary
folder and installs the copy, and the copy is deleted at the end.

### Reading the output

Each check line says on how many loads it passed. A check passes only if it
passed on every load, so a race that loses once in 13 loads shows up. The
timing table gives the median, the interquartile range and the extremes, in
milliseconds, from the page's own `performance.now()`. The "Information"
section lists what is worth knowing but is not a failure: every console
message, the requests the stubs answered with a 404, and requests that went to
a host the harness does not serve.

## How the page gets its real origin

The extension only runs on `https://*.intra.42.fr/*`, and several code paths
test `location.hostname === "profile-v3.intra.42.fr"`. So the page must really
be served under that origin, with a certificate Firefox accepts.

- **DNS.** Firefox is started with the pref `network.dns.localDomains` set to
  the list of hosts the harness answers for. Firefox resolves every name on
  that list to the loopback address without asking any resolver. The list is
  `profile-v3.intra.42.fr`, `intrapy.intra.42.fr`, `auth.42.fr`,
  `cdn.intra.42.fr`, `meta.intra.42.fr`, `profile.intra.42.fr`,
  `projects.intra.42.fr`, `intra.42.fr`, plus `api.github.com` (listed by
  name: the extension reaches it without a host permission, as a CORS
  request) and the Cuter Intra worker, taken from the build's
  `host_permissions` and from `package.json` `config.workerUrl`
  (`harnessHosts()` in `scripts/firefox-smoke/server.mjs`, checked by
  `tests/smoke-harness.test.ts`). `network.trr.mode` is set to 5 so that DNS
  over HTTPS cannot bypass it. The pref only affects that throwaway profile.
- **Server.** One Node HTTPS server on `127.0.0.1:443` answers for all of
  those hosts, routing on the `Host` header. On Windows any user can bind
  port 443. On Linux, and wherever 443 is taken, see the fallback below.
- **Certificate.** `scripts/firefox-smoke/cert.mjs` builds a self-signed
  ECDSA P-256 certificate in memory at every run (valid 7 days, SAN = the
  hosts above plus `*.intra.42.fr`). Node has no API to build a certificate,
  so the file encodes the few DER structures by hand and parses the result
  back with `crypto.X509Certificate` to check it. No key is ever written to
  disk or committed.
- **Trust.** Puppeteer starts the WebDriver BiDi session with
  `acceptInsecureCerts: true`. Firefox then ignores certificate errors for
  that session only (it logs "TLS certificate errors will be ignored for this
  session"). This applies to the page, to hook.js's fetch wrapper, and to the
  content script's own requests.
- **Fallback: CONNECT proxy.** If port 443 cannot be bound (EADDRINUSE,
  EACCES), or with `--proxy`, the HTTPS server listens on a random port and a
  tiny HTTP proxy that only understands `CONNECT` is started too. Firefox is
  pointed at it with `network.proxy.type = 1` and `network.proxy.ssl`. It
  sends `CONNECT profile-v3.intra.42.fr:443`, the proxy opens the tunnel to
  the HTTPS server, and the browser still sees `https://profile-v3.intra.42.fr/`
  on port 443, so the origin is exact. Any other host gets a 403, so this mode
  is fully offline. Timings go through one more local hop.

What the server answers:

| host | answer |
| --- | --- |
| `profile-v3.intra.42.fr` | the synthetic `index.html`, its module bundle (`/assets/index-<hash>.js`, cacheable like the real one), a small stylesheet, a favicon |
| `auth.42.fr` | the Keycloak token endpoint: a fake JWT, new for every login (`alg: none`, `exp` one hour ahead), after `--auth-latency` ms |
| `intrapy.intra.42.fr` | JSON for `/users/me`, `/users/{login}` and its `/locations_stats`, `/projects`, `/projects/marked`, `/achievements`, `/cursus`, `/campus`, `/summary`, and `/users/me/events`. Anything else: 404 |
| `cdn.intra.42.fr` | a 1x1 PNG for every picture |
| `api.github.com` | `{}` for every path: no release (the background keeps its state), no star or follower count |
| the worker | `/api/v1/public/announcement` (no announcement), `/gh/campuses/campuses.json` (one campus) and that campus's file (no clusters), `/gh/data/event_types.json` (no types), `/api/v1/public/stats` (`{}`). Anything else: 404 |
| everything else | 404 |

Every request the extension makes on a plain profile page must get a 200 from
a stub: Chrome prints each 404 a page or content script receives as a console
error, which would fail `d.no-console-errors` on every Chrome load.

Every response carries CORS headers for the `Origin` it was asked from, as
intrapy does, and preflights get a 204. Without them a stubbed 404 would turn
into a "Cross-Origin Request Blocked" console error.

## The synthetic page

The real `https://profile-v3.intra.42.fr/` is a 446-byte Vite shell: an empty
`<div id="root">`, one `<script type="module" crossorigin src=...>` and one
stylesheet in `<head>`, and no `Content-Security-Policy` header (checked on
2026-09-21). The synthetic page has the same shape. Its bundle,
`scripts/firefox-smoke/page/app.js`, runs in the page world and does what the
Intra does, in the same order:

1. **Login, then API.** keycloak-js gets the token with an `XMLHttpRequest` to
   auth.42.fr, which hook.js does not watch. Only then are the intrapy requests
   sent with `Authorization: Bearer <JWT>`: `/users/me`, then
   `/locations_stats` (hook.js relays the logtime payload),
   `/projects/marked?cursus_id=21` (hook.js stores the cursus id) and
   `/campus` (hook.js dispatches `42_CAMPUS_DETECTED`, the extension stores
   the campus and mounts its Clusters button). The token is new at every load,
   so a token left in sessionStorage by an earlier load cannot pass for a
   fresh capture.
2. **The app.** It inserts into `#root` only the parts of the Intra DOM that
   Cuter Intra hooks into, with the classes its selectors expect:
   - the sidebar: `<a href="https://profile-v3.intra.42.fr">` inside
     `div.flex.flex-col.w-full` (`findSidebarMainGroup`), the bottom group
     (`.pb-16`) and the slots link;
   - the profile card: `p[class="text-sm"]` (the login line) inside
     `.flex.flex-col.lg:flex-row`, whose parent is the card
     (`findProfileCard`), the seat pill and the stats row;
   - `AVATAR_SELECTOR`, `BANNER_SELECTOR`, `BACKGROUND_SELECTOR` and
     `TITLE_BADGE_SELECTOR` from `src/core/intra/selectors.ts`;
   - the nav avatar (`img.aspect-square.h-full.w-full` from cdn.intra.42.fr)
     and three dashboard cards (`.bg-white.md:h-96`).

By default the app is inserted as soon as the module runs, before
`DOMContentLoaded`. The reason is `initHubSettings`: its first `watchDom` pass
runs right away, but later passes are debounced by 50 ms. If the sidebar
arrived after that first pass, the gear time would measure the debounce, and a
slower build could even look faster. With the sidebar already there, the gear
time measures the extension. `--app-delay` gives the slower-SPA variant.

**Instrumentation.** The recording code is not part of the page. The harness
registers `scripts/firefox-smoke/page/instrument.js` as a WebDriver BiDi
preload script (`page.evaluateOnNewDocument`). Firefox runs it in the page
world when the document is created, before the `<html>` element exists, so
before the document_start content script and before any page script. Its
MutationObserver sees every node the content script inserts, including the
hook.js `<script>` that is removed right after insertion. A MutationObserver
callback runs at the end of the task that made the change, so a time is when
the inserting script finished its synchronous part, not when it started.

The page has one inline script, a one-liner that only records whether an
inline `<script>` in `<head>` already sees the wrapped `fetch` (it never does,
see below). It is left out with `--csp`.

## The extension

Each session starts Firefox with a new profile through puppeteer-core
(`protocol: "webDriverBiDi"`), then installs the copied build with
`browser.installExtension(dir)`, which is the BiDi command
`webExtension.install`. The add-on is a temporary one, as from
about:debugging. Firefox 156 grants a temporary MV3 add-on its
`host_permissions`: the content scripts ran without any extra step, and the
`content-script` check fails with a hint if that ever changes. The harness
waits one second after the install, so that the background script's first run
(the update check, answered `{}` by the stub) is out of the way.

Extension storage starts empty in every session, so all settings are at their
defaults (dark theme, every feature on).

## Checks

Every check runs on every load.

| check | passes when |
| --- | --- |
| `content-script` | hook.js was injected or the gear appeared: the content script ran |
| `a.hook-first` | `window.fetch` was already wrapped when the page sent its first intrapy request |
| `a.token-captured` | right after that first request, `sessionStorage.ft_intrapy_token` holds this load's token, and a `42_INTRAPY_TOKEN` event carried it |
| `a.hook-relays` | hook.js stored `ft_active_cursus_id` and dispatched `42_CAMPUS_DETECTED` with the campus id |
| `b.gear` | `#hub-gear-btn` appeared in the sidebar |
| `b.theme` | `data-theme` and the `dark` class agree, and exactly one page sheet is enabled: the right one (`darkV3`/`lightV3`), with id `better-intra-theme-stylesheet`, loaded |
| `b.perf-styles` | one `#better-intra-perf` element, not empty |
| `b.clusters-button` | one `#ft-clusters-btn`. On a cold load the campus is not stored yet, so this also proves that `42_CAMPUS_DETECTED` reached the app (the event has no replay, risk 7 in CODE-SPLITTING.md) |
| `c.hub-opens` | after a real click on the gear, `#hub-dialog` is open and its shadow root has rendered its tab list |
| `c.hub-reopens` | Escape closes it, a second click opens the same dialog again |
| `d.no-page-errors` | no uncaught error or unhandled rejection, whether it comes from the page or from the content script (Firefox reports both through BiDi) |
| `d.no-console-errors` | no `console.error` at all, and no warning from a `moz-extension://` script |
| `d.no-csp-report` | no `securitypolicyviolation` event, no CSP report, no console message about CSP |
| `d.no-preload-helper` | no `vite:preloadError` event and no `<link rel="modulepreload">` in the page (risk 5) |
| `e.single-instance` | after two hub opens: hook.js inserted once; one gear, one dialog, at most one Clusters button, perf style, preset style and logtime widget; one `<link>` per theme sheet; no duplicate element id; `42_LOGTIME_REQUEST` dispatched at most once; and, if the build carries `console.count("better-intra graph")`, a count of 1 |

The `42_LOGTIME_REQUEST` count is what catches a second instance of the ES
module graph. The logtime module dispatches that event once when it starts, so
each instance dispatches one. The DOM writes of a second instance are mostly
idempotent (the gear checks for an existing gear, the theme manager of the
split adopts the loader's `<link>`), so counting elements alone does not catch
it. This was checked with a copy of the split build whose loader imports
`content-main.js?dup`, the cache-buster that rule 2 of CODE-SPLITTING.md
forbids: the first lazy chunk then imports `../content-main.js` and evaluates
the app a second time, and the check failed with `42_LOGTIME_REQUEST x2`.

## Timings

All times come from the page's `performance.now()`, so they start at the
navigation (the time origin of the document).

| row | what it is |
| --- | --- |
| hook.js inserted | the content script's synchronous part is done. For the IIFE, that is the end of the whole 553 KB script, since the injection is at the end of `main.ts`. For the split, it is the loader's first statement |
| theme `<link>` inserted | the page theme sheet is in the document. On warm loads it comes from the sessionStorage cache at document_start; on a cold load the theme is read from storage first |
| perf `<style>` inserted | `initPerfStyles` has read its settings: the first thing the app does after a storage read |
| DOMContentLoaded | for reference: the app starts its main work there |
| (i) `#hub-gear-btn` inserted | the go/no-go number: the app is evaluated, has read its settings and has written into the Intra DOM |
| (ii) gear click -> `#hub-dialog` open | the first open, which is also the first lazy import in the split |
| gear click -> hub content rendered | the hub's shadow root has its tab list |
| 2nd click -> `#hub-dialog` open | the same, once the code is loaded |

A cold load is the first page load in a Firefox that was just started with a
new profile and the add-on just installed. A warm load is a reload in the same
browser. `--cold 3 --runs 10` makes three sessions of 5, 4 and 4 loads. In
`--compare`, the sessions alternate between the two builds and swap the order
every time, so neither build always runs first.

Keep in mind:

- The synthetic page is tiny and local, so the extension's own latency is a
  large part of every number. On the real Intra, the React app and the network
  take hundreds of milliseconds, and most of these differences disappear
  behind them. That makes the harness good at comparing two builds and bad at
  predicting what a user feels.
- Headless and headful timings differ. Compare builds within one run, not
  across runs or machines.
- The medians move by a few milliseconds between runs of the same build.
  Differences below that are noise. Use more loads (`--cold 6 --runs 30`)
  before deciding anything.

## Results on 2026-09-21

Windows 11, Firefox 156.0 headless, port-443 mode, one interleaved run:
`--compare dist-baseline-iife dist-split-firefox --cold 6 --runs 30`, so 6
cold and 30 warm loads per build. A is `dist-baseline-iife` (the 1.11.0
release, one IIFE `content.js`). B is `dist-split-firefox` as it was at 17:36
that day (the 1.6 KB loader plus a 387,931 B `content-main.js` and nine
chunks). Every check passed on all 36 loads of each build, with no console
message from either extension.

Milliseconds, median [p25-p75], delta = B - A on the medians:

| warm (n=30 each) | A: IIFE | B: split | delta |
| --- | ---: | ---: | ---: |
| hook.js inserted | 18 [18-20] | 14 [13-14] | -4 |
| theme `<link>` inserted | 18 [18-20] | 14 [13-14] | -4 |
| perf `<style>` inserted | 46 [45-48] | 55 [54-56.8] | +9 |
| DOMContentLoaded | 23 [21-24] | 22 [19.3-24] | -1 |
| (i) gear inserted | 47 [46-49] | 56 [54.3-57.8] | +9 |
| (ii) click -> hub open | 5 [4-5] | 8.5 [8-9] | +3.5 |
| click -> hub rendered | 25 [24-27] | 28 [27.3-29.8] | +3 |
| 2nd click -> hub open | 9 [8-9] | 9 [8-9] | 0 |

| cold (n=6 each) | A: IIFE | B: split | delta |
| --- | ---: | ---: | ---: |
| hook.js inserted | 73 [72.3-73.8] | 65 [58.3-65] | -8 |
| theme `<link>` inserted | 99.5 [94.8-102] | 110.5 [108-116] | +11 |
| perf `<style>` inserted | 99.5 [94.8-102] | 110.5 [108-116] | +11 |
| DOMContentLoaded | 102 [95.3-110.3] | 107.5 [96.5-111.8] | +5.5 |
| (i) gear inserted | 107 [103-111.8] | 115 [110-117.8] | +8 |
| (ii) click -> hub open | 4 [3.3-4] | 9 [9-9.8] | +5 |
| click -> hub rendered | 25 [25-26.5] | 29 [29-30.5] | +4 |
| 2nd click -> hub open | 9 [9-9] | 9 [8.3-9] | 0 |

hook.js was already in place when the Intra bundle started on 6/6 cold and
5/30 warm loads with A, and on 6/6 and 30/30 with B.

What this says, on this page:

- The loader does its job: hook.js and the cached theme are in the page about
  4 ms earlier warm (8 ms cold) than with the IIFE, which only injects hook.js
  after evaluating all of its code.
- Everything that needs the module graph comes later: about 9 ms warm and
  8 to 11 ms cold for the first storage-driven writes (perf styles, gear). The
  interquartile ranges do not overlap, so this is not noise. On a cold load
  the theme is one of those writes, since the loader has no cached theme yet.
- The first hub open pays the chunk import, about 4 ms; the second open costs
  the same in both builds.
- With `--app-delay 150` (the sidebar mounts 150 ms after the bundle runs,
  closer to the real Intra), the gear time is the same for both builds (warm
  224 vs 222 ms, `--cold 2 --runs 10`): the app is ready long before the
  sidebar, so the 9 ms stay hidden. The perf styles (+9 ms) and the first hub
  open (+4 ms) do not depend on the page and stay later.

So by the test plan's rule ("ship only if the split is not slower warm"), the
split is slower warm on this page by about 9 ms for the app's first writes.
Whether that is visible on the real Intra, where they happen long before the
React app has rendered, is what the Profiler run of test-plan step 7 has to
show.

## Findings

Status in 1.11.1: finding 1 is fixed (hook.js is a `"world": "MAIN"` content
script, in place before the Intra's bundle on every load) and finding 2 is
fixed (the profile pass catches its fire-and-forget work). The notes below
describe what the harness observed on v1.11.0.

1. **hook.js does not beat every page script.** It is a `<script src>`
   appended at document_start, so it loads asynchronously. An inline script in
   `<head>` never sees the wrapped `fetch` (0 of 36 loads, both builds), and
   neither does the Intra's own deferred module bundle on most warm reloads
   of the IIFE build, when the bundle comes from the cache (hook.js was in
   place on 5 of 30). The token is still captured, because the Intra only
   sends intrapy requests after the Keycloak login, a network round trip
   later. A test page that sends its first request before logging in makes
   `a.hook-first` fail on the release build (the first version of this
   harness did, on 1 warm load in 3): the synthetic page logs in first, as
   the real one does. The split's loader injects hook.js as its first
   statement instead of after 553 KB of code, and had it in place on 30 of 30
   warm loads.
2. **An unreachable worker leaks unhandled rejections.** When no campus is
   stored yet, `injectFriendsWidget()` (called without `await` or `catch` at
   the end of the profile pass in `profile.ts`) calls `getClusterData("")`.
   With the worker's `campuses.json` answering 404, that rejects with "Failed
   to fetch campus list"; with an empty campus list, with "No campus data
   available". Either way it is an unhandled rejection on the profile page.
   The real worker always answers (and the first campus of its list then gets
   loaded), so users only see this when the worker is down or the machine is
   offline. The stubs answer like the real worker so that the baseline
   passes; the extension was not changed.
3. **CSP (experiment with `--csp`).** With `script-src 'self'` and a
   `connect-src` that leaves the worker out, Firefox 156 blocked neither the
   injected `moz-extension://` hook.js nor the split's `import()` of
   `content-main.js` and its chunks: the hub opened in both builds. It did
   block the content script's own `fetch()` calls to the worker, which are
   subject to the page's `connect-src` in Firefox MV3. That applies to both
   builds equally. The real profile-v3 sends no CSP today.
4. **`chunks/*.js` must be web-accessible.** With it removed from
   `web_accessible_resources` in a copy of the split build, the hub never
   opens and the loader logs "the settings hub could not be opened": bug
   1803950 applies to Firefox 156 (test plan step 1).

## What it does not cover

- **Real Intra data and DOM.** Only the selectors listed above exist, the
  payloads are empty or minimal, and there is no real React: most profile
  cards, the friends list and the cluster map have nothing to work on.
- **Being logged in.** There is no real Keycloak, no cookies, and no Better
  Intra cloud account. Every worker endpoint except the three stubbed ones
  answers 404, so cloud sync, public profiles and statistics never run.
- **Other pages**: profile.intra.42.fr v2, `/users/<login>`, projects and
  other subdomains, the auth callback, and a page restored from bfcache.
- **Lifecycle**: the popup and the background script beyond their first run.
  Updating the add-on with a tab open is not one of the automated checks, but
  it was checked by hand with the harness for 1.12.0 (install 1.11.1, load the
  page, install the new build over it): one friends widget, one theme link,
  and the gear and Clusters button work. 1.11.1 over itself still shows the
  old bug, which is what `src/core/lifecycle/stale-instance.ts` fixes.
- **Load counts of extension files.** BiDi does not report `moz-extension://`
  loads, so "content-main.js is fetched once" cannot be checked here. Use the
  Browser Toolbox.
- **Where time goes inside Firefox**: compile time, and first paint or visual
  flashes (no screenshots). Use the Firefox Profiler (test plan, step 7).
- **Attribution of content-script errors.** Firefox reports an unhandled
  rejection from the content script with no stack, so the report shows the
  message only.
- **Firefox 140 ESR**, unless you point `--firefox` at one.
- On Chrome, the popup and the service worker beyond their first run, and
  Chrome's own timings as a benchmark (see [Chrome](#chrome)).

## Chrome

`--browser chrome` runs the same page, stubs and checks against `dist-chrome`
in a real Chrome, through CDP instead of WebDriver BiDi:

- **No port 443, no proxy, no certificate install.** The server listens on a
  random port and Chrome is started with
  `--host-resolver-rules=MAP <host> 127.0.0.1:<port>, ...` for every host the
  harness serves (the rule maps the port too), plus
  `--ignore-certificate-errors` for the in-memory certificate. The browser
  still sees `https://profile-v3.intra.42.fr/`, so the origin is exact.
- **The extension** is installed with `browser.installExtension(copy)`, the
  CDP `Extensions.loadUnpacked` route (puppeteer needs `pipe: true` and
  `enableExtensions: true` for it). Chrome 137+ dropped `--load-extension`
  for branded builds, so this is the one that keeps working. Headless Chrome
  (the new headless mode, not chrome-headless-shell) runs extensions.
- **Binary.** `--chrome PATH`, then `CHROME_BIN`, then the usual install path
  of the platform (`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  `/usr/bin/google-chrome`, the `.app` on macOS). The harness never downloads
  a browser.
- **CI.** `.github/workflows/ci.yaml` runs
  `node scripts/firefox-smoke.mjs dist-chrome --browser chrome --runs 3 --cold 1 --no-sandbox`
  after the builds on `ubuntu-latest`, which ships `google-chrome`. A failed
  check (1) or a crash of the harness (2) fails the job; a runner without
  Chrome (3, "no Chrome found") only prints a warning. When a crash shared
  "no Chrome"'s code, a broken harness passed CI as skipped.
- **Release gate.** The same command ends `npm run release:check`, which
  `publish.yaml` runs before it attaches or signs anything and
  `finish-release.yaml` before it attaches Chrome files. There any non-zero
  exit fails, 3 included: CI's run races the release and gates nothing (for
  1.16.0 the Chrome files were attached 14 s before CI's smoke test ended).

It is a functional smoke test, not a benchmark: the timing table is printed
but headless Chrome's numbers are not comparable with Firefox's, or with the
results below. Compare Chrome builds with other Chrome builds only, in one
run. On 2026-09-22 (Windows 11, Chrome 153 headless, `--runs 3 --cold 1`)
every check passed on all 4 loads of the 1.12.1 Chrome build, with no
console message, no stubbed 404 and no unserved host.

## Files

- `scripts/firefox-smoke.mjs`: the CLI, the Firefox sessions, the checks and
  the report.
- `scripts/firefox-smoke/server.mjs`: the HTTPS server, the stubs, the page
  shell and the CONNECT-proxy fallback.
- `scripts/firefox-smoke/cert.mjs`: the in-memory self-signed certificate.
- `scripts/firefox-smoke/browsers.mjs`: finding the browser and
  puppeteer-core, and the exit codes (`tests/smoke-harness-exit.test.ts`).
- `scripts/firefox-smoke/page/app.js`: the synthetic Intra bundle.
- `scripts/firefox-smoke/page/instrument.js`: the preload script that records
  everything the checks read.
