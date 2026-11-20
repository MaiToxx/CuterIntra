# Code splitting (implemented, measured in Firefox, not shipped)

## Verdict

The split described below was implemented (branch `code-splitting`, commit
`bc61a42`) and passes every check of the Firefox harness
(`scripts/firefox-smoke.mjs`, docs/FIREFOX-TESTING.md). Measured in Firefox
156 against the v1.11.0 single-IIFE build, 30 interleaved warm loads per build:

| median, warm | IIFE | split |
| --- | ---: | ---: |
| perf `<style>` inserted | 46 ms | 55 ms |
| `#hub-gear-btn` inserted | 47 ms | 56 ms |
| first hub open | 5 ms | 8.5 ms |

Risk 1 below was real: Firefox reuses the compiled `content_scripts` file,
and the module loader path costs more than the 32 % of bytes it saves. By the
test plan's rule ("ship only if not slower warm"), **main keeps the single
IIFE**. The lazy boundaries alone, kept inside the IIFE (where `import()` is
inlined and only defers module evaluation), measured no faster either and
added 4.8 KB, so they were not kept.

Two things did come out of it and shipped in 1.11.1:
- the loader's one clear win, hook.js running before the page's scripts, is
  now achieved without any split: hook.js is a manifest content script with
  `"world": "MAIN"` (Firefox 128+, Chrome 111+). In place before the Intra's
  cached bundle on 10 of 10 warm loads, against 2 to 5 of 10 before;
- the Firefox harness itself, which is how the verdict was reached.

Worth re-measuring if Firefox changes how it loads moz-extension modules, or
for a Chrome-only build. The original study follows.

Since 1.21.3 two of its numbers no longer hold: qrcode-generator is replaced by
`src/features/calendar/qr-encode.ts` (about 17 KB less), and the hub is imported
statically, which drops Vite's preload helper from the bundle.

---

# The study

`content.js` is one IIFE (`vite.config.ts`, `format: "iife"`), so every
`import()` in `src/` is inlined: the hub, the cluster map, the profile editor,
the particle effects, the easter-egg effects and qrcode-generator are parsed on
every Intra page, even if the user never opens them. This page measures what ES
modules with code splitting would save, describes how the split would work, and
lists what has to be tested in Firefox before it can ship. **Nothing here
ships.** Nothing under `src/`, `manifests/` or the Vite configs was changed.

Measured on 2026-09-21 on the tree at `9e3e70e`, with Vite 8.3.0 and rolldown
1.2.7, Firefox target. Sizes are raw bytes on disk (KB = 1024 B), with gzip -9
for reference, the same convention as `npm run measure`. A number that was not
measured is marked *estimate*.

## Numbers

### What a normal Intra page loads

| build | files loaded on every page | raw | gzip |
| --- | ---: | ---: | ---: |
| today: `content.js` IIFE | 1 | 553.3 KB (566,619 B) | 166.1 KB |
| ES modules, `src/` unchanged (only the hub is `import()`) | 1 | 464.7 KB (475,877 B), −16.0 % | 139.1 KB |
| ES modules + the boundaries below, default chunking | 7 | 376.5 KB (385,552 B), −32.0 % | 117.9 KB |
| same, with the `$initial` group (**recommended**) | 1 | **375.6 KB (384,654 B), −32.1 %** | 114.0 KB |
| the classic loader (`content.js` in the split) | +1 | 1.6 KB (1,624 B) | 0.8 KB |

With the loader, an Intra page loads **377.2 KB instead of 553.3 KB (−31.8 %)**.
All the JS files together come to 566,787 B, which is 168 B more than today: the
package does not grow, the bytes only move. With default chunking, rolldown puts
modules shared by the entry and a lazy chunk into six extra chunks (lit-html,
config, customize, ...) that the entry imports statically. A single
`codeSplitting.groups` entry with `tags: ["$initial"]` merges them back into the
entry.

### The lazy chunks

"Extra" is what the first trigger adds on top of the eager graph, including the
small shared chunks it pulls in.

| chunk | extra raw | gzip | loaded when |
| --- | ---: | ---: | --- |
| `hubSettings.ui.js` (+ `presets`, `reset`, `grip-vertical`) | 71.7 KB (73,462 B) | 22.0 KB | the sidebar gear is clicked (already `await import()` today) |
| `map-dialog.js` (+ `reset`) | 48.9 KB (50,055 B) | 14.2 KB | the Clusters sidebar button, the Clusters link of the personal-info block, the seat badge (profile-card.ts) or a seat label (highlight.ts) is clicked |
| `profile.modal.js` (+ `grip-vertical`) | 25.8 KB (26,455 B) | 7.1 KB | the user clicks their own avatar (the profile editor) |
| `qr.js` (qrcode-generator) | 20.5 KB (21,010 B) | 7.2 KB | the hub opens while a calendar sync token exists |
| `extras-effects.js` | 7.3 KB (7,500 B) | 3.0 KB | a profile's extras ask for a particle effect (and the viewer does not prefer reduced motion) |
| `eggs-effects.js` | 6.1 KB (6,284 B) | 2.4 KB | an egg with a visual effect is triggered: konami, barrel, matrix, maxwell, 7 gear clicks, a 42h00 month |
| `presets.js` | 2.5 KB (2,539 B) | 1.2 KB | the 7th fast gear click (hacker egg); otherwise it loads with the hub |

The calendar panel itself stays in the hub chunk: the hub renders every tab
panel when it opens (`tab-panel.ts`), so a separate chunk would load right after
the hub every time. Only qrcode-generator is worth deferring.

### Boundaries used (in a copy of `src/`)

- Cluster map: a 3-line `open-map.ts` exports `openClusterDialog()` as
  `import("./map-dialog.ts").then(m => m.openClusterDialog(opts))`, and the
  four importers (hubSettings.ts, personal-info.ts, profile-card.ts,
  highlight.ts) use it. `map-dialog/seats.ts` stays eager (highlight.ts).
- Profile editor: `avatar-clicks.ts` imports `profile.modal.ts` on click.
- Particle effects: `extras-apply.ts` imports `extras-effects.ts` on the first
  `startEffect`; a request counter makes a `stopEffect` issued during the load
  cancel the pending start.
- Easter eggs: the six effect functions move to `eggs-effects.ts`. `eggs.ts`
  keeps the triggers, `toast` and wrappers with the same names, and imports
  `savePreset` on the 7th click.
- Calendar: `calendar.ui.ts` imports `qr.ts` only when there is a token (inside
  an `update()` that is already async).
- `main.ts`: the hook injection, the avatar pre-hide and its fail-safe move to
  the loader, and `theme-manager.ts` adopts the loader's `<link>` (see below).

The modified copy type-checks (`tsc --noEmit`, 0 errors).

### Indicators, not Firefox numbers

- V8 compile time (Node 24 on this machine, median of 41 runs, compile cache
  defeated): 7.7 ms for `content.js` against 5.0 ms for the eager
  `content-main.js`, or 19.5 ms against 13.0 ms with `--no-lazy`. SpiderMonkey
  is not V8, and see risk 1 below.
- Next candidate: the hub's setting definitions (`hub/settings/*`, 42,934 B
  rendered before minification) are eager only because
  `hubSettings.storage.ts` imports `FEATURE_DEFS` from `hubSettings.data.ts`,
  which also builds `HUB_SETTING_DEFS`. Moving `HUB_SETTING_DEFS` to its own
  module brought the eager graph down to **343.7 KB (351,997 B, −37.9 %)** and
  the hub chunk up to 103.6 KB. That changes the exports of `hubSettings.data.ts`, so it is a
  separate decision.
- What is still eager (rendered length before minification): profile 34 %,
  logtime 11 %, hub 9 %, friends 8 %, inline SVG 8 %. An `import()` per entry
  of `featureInitializers` would keep a disabled feature's code off the page
  (not measured).

## Design

```
content.js         classic content script, document_start, 1.6 KB, no state
  ├─ injects hook.js
  ├─ applies the cached theme (classes + <link data-better-intra-theme>)
  ├─ avatar pre-hide observer + 5 s fail-safe
  └─ import(chrome.runtime.getURL("content-main.js"))
       content-main.js   ES module: everything with state, evaluated once
         ├─ import("./chunks/hubSettings.ui.js") ── import("./qr.js")
         ├─ import("./chunks/map-dialog.js")
         ├─ import("./chunks/profile.modal.js")
         ├─ import("./chunks/extras-effects.js")
         └─ import("./chunks/eggs-effects.js")
       every chunk that needs shared code imports it from "../content-main.js"
```

To ship it (outline): `format: "es"`, a fixed entry name (`content-main.js`),
hashed chunk names (`chunks/[name]-[hash].js`), the `$initial` group, and a
second, classic build for the loader. The manifests keep `content.js` in
`content_scripts` and add `content-main.js` and `chunks/*.js` to
`web_accessible_resources` for `https://*.intra.42.fr/*` (Firefox MV3 needs this
for `import()` from a content script, bug 1803950; Chrome needs it too).
`measure-bundle.js` needs budgets for the new files.

### What stays synchronous in the loader

Everything `main.ts` does before its first `await` today either needs to beat
the page's own scripts or its first paint, or it only registers something.

1. **hook.js injection.** It moves verbatim. It wraps `window.fetch` before the
   Intra app sends its first request, which is how the token, the campus and
   the logtime payload are seen. Inside the module graph it would run later by
   the import latency, and the first fetches could go unseen.
2. **Avatar pre-hide and its 5 s fail-safe.** They move verbatim, together. The
   observer only sees *added* nodes. Started from the graph after React has
   inserted the avatar, it would never fire: the Intra picture flashes before
   the custom avatar, and the observer stays connected. The fail-safe must be
   in the loader too, so that the avatar comes back even if the graph fails to
   load.
3. **Cached theme.** The loader reads `sessionStorage["intra-theme"]` and does
   the synchronous part of `applyTheme()`: the `dark` class, `data-theme` on
   v3, and the page theme `<link>`. It never writes sessionStorage and does not
   build the preset `<style>`, which needs a settings read and is already async
   today. What can go wrong:
   - `theme-manager.ts` keeps its links in a module-level `Map`. If it does not
     adopt the loader's link, it creates a second one, and a later theme switch
     turns off only its own: the loader's sheet stays on (stuck dark). The copy
     fixes this in `themeLink()`: it first looks for
     `link[data-better-intra-theme="<name>"]` (8 lines).
   - The sheet file names, the link id and the v3 host check are duplicated.
     They should move to a constants-only module that both builds import (it
     is stateless, so having a copy in each build is harmless), or a test
     should compare them.
   - sessionStorage can throw (blocked storage): the loader catches it, and the
     graph applies the theme a little later, as today when nothing is cached.

Everything else moves into the graph unchanged: the `onMessage` listener (the
popup's Intra login already reports "not running on this tab yet"),
`initCustomize`, `initPerfStyles`, the eggs, the announcement, the tooltips, the
v2 banner and `runBetterIntra` (all of them handle a `readyState` that is no
longer `"loading"`).

### Exactly one instance of every stateful module

`src/core/config/snapshot.ts` wraps `chrome.storage.local.set/remove/clear` and
registers an `onChanged` listener. Its "once" guard is a module variable, so a
second copy of the module would wrap again: every write would be recorded
twice, and there would be two snapshots. The same goes for the theme manager's
`Map`, the customize and perf listeners, the shared constructed stylesheet, the
cluster map's `opening` guard, and so on.

What makes the split safe:

- An ES module is instantiated once per module map, keyed by its URL, and a
  content script has one module map per frame.
- A rolldown build puts every module in exactly one chunk. Measured: 228
  modules over 10 chunks, 0 duplicates. Every chunk with shared code imports
  `../content-main.js`.
- The loader bundle contains only `loader.ts`, `selectors.ts` (string
  constants) and Vite's preload helper. It has no `chrome.storage`.

Rules:

1. Everything with state lives in the ES graph. The loader imports only modules
   that hold constants: no top-level side effects, no module-level `let`. A
   test should fail if the loader bundle mentions `chrome.storage` or grows
   past a few KB.
2. The entry has one URL: `chrome.runtime.getURL("content-main.js")`, with no
   query string and no hash. A cache-buster would create a second instance of
   the whole app as soon as the first lazy chunk imports `../content-main.js`.
3. There is one classic content script on `*.intra.42.fr`. No second
   `content_scripts` entry may bundle core.
4. Keep the `$initial` group. With one eager chunk, modules evaluate
   dependency-first in a single chunk, as in the IIFE. Rolldown documents that
   placing modules in shared chunks can change the order unless
   `strictExecutionOrder` is on. The relative order only shifts where the split
   changed an import edge (for example `map-dialog/seats.ts` now comes through
   highlight.ts). `config/snapshot.ts` comes right after lit-html in both
   builds, and its listener is the first `onChanged` registration in the file.
   That is the ordering `snapshot.ts` relies on.
5. Belt and braces (not done, since `src/` was not touched): mark the wrapper,
   for example with a `Symbol.for(...)` property on the wrapped function. A
   second instance would then see the mark and fall back to direct reads
   instead of wrapping twice.

## Risks

1. **Firefox time, not bytes.** As far as we know (not verified here), Firefox
   compiles `content_scripts` files once per process and reuses the compiled
   script. Files loaded with `import()` go through the module loader, and
   nobody has checked here whether it caches moz-extension: modules. So the
   split could save 32 % of the bytes and no time, or even cost time. This is
   the go/no-go measurement (test plan, step 7).
2. **First paint.** Customize, perf and preset CSS arrive later by the import
   latency (not measured; *estimate*: a few ms warm, more cold). The theme
   itself is safe because the loader applies it. If a flash shows, the loader
   can inject a cached copy of the generated customize CSS, the same way it
   handles `intra-theme`.
3. **Stale tabs after an update** (mostly Chrome, where an orphaned content
   script keeps running). An old graph that imports a new chunk with the same
   name binds it to the old entry: a missing-export SyntaxError, or the wrong
   code. With hashed chunk names this becomes a clean 404. Every lazy call site
   needs a `.catch` (the study shims have none).
4. **Races on first use last longer.** The profile editor has no `opening`
   guard, so a double click during the import can open two modals (the same
   race exists today during its awaits, but it is shorter). A `stopEffect`
   during the load must cancel the start (the copy uses a counter). The
   calendar QR gets one more await on its first render.
5. **Vite's preload helper** stays in the entry (about 1 KB minified,
   *estimate*) and even wraps the loader's `import()`. With empty deps it does
   nothing. When a load fails, it dispatches `vite:preloadError` on the page's
   `window`, and with non-empty deps it would add
   `<link rel="modulepreload" href="/chunks/...">` to the Intra page. Keep
   `cssCodeSplit: false`, build the loader without Vite's import analysis, and
   check that no output contains `modulepreload`.
6. **Exposure to the page.** The chunks become fetchable by `*.intra.42.fr`
   pages, like hook.js and the CSS today. They hold no secrets. A page that
   imports them into its own world fails at the first `chrome.storage` access.
7. **hook.js events.** The listeners attach later by the import latency. Today
   they already attach after DOMContentLoaded, and most have a replay: the
   token and the cursus id are in sessionStorage, and there is
   `42_LOGTIME_REQUEST`. `42_CAMPUS_DETECTED` has no replay.
8. **CSP.** Nobody has checked here whether Intra's CSP applies to a content
   script's module loads in Firefox (test plan, step 6).

## Firefox test plan

Build the split into its own folder (never `dist-firefox`) and load it from
about:debugging. Test Firefox 140 ESR (`strict_min_version`) first, then the
current release. The test build only gets temporary instrumentation:
`console.count("better-intra graph")` at the top of `main.ts`, and
`performance.mark()` in the loader and at the entry.

1. **Loading** (profile-v3.intra.42.fr, own profile). No error in the
   content-script context (Browser Toolbox), the count is 1, and
   `content-main.js` is fetched once. Then remove `chunks/*.js` from
   `web_accessible_resources`: the hub must fail to open, which confirms that
   bug 1803950 applies. Restore it.
2. **document_start** (same page, hard reload with dark, light and a colour
   preset).
   - No light flash on dark, exactly one `link[data-better-intra-theme]` per
     sheet, and dark → light → dark from the hub leaves one page sheet on.
   - The Intra picture does not flash before the custom avatar. With
     `content-main.js` renamed, the avatar comes back after 5 s.
   - The token is captured (the marks, freeze and achievements cards load), the
     logtime card gets its data, and with `CLUSTERS_CAMPUS` removed the campus
     is detected again and the Clusters button appears.
3. **One instance under use.** Open every lazy feature twice: the count must
   stay at 1. A setting changed in the hub reads back after reopening the hub,
   and another open tab follows.
4. **Every lazy chunk, first and second use.**
   - The hub gear, then 7 fast gear clicks (hacker preset and matrix rain).
   - The calendar tab, with and without a sync token (the QR code shows).
   - The Clusters sidebar button, the Clusters link in personal info, the
     seat badge and the seat labels.
   - The user's own avatar, including a fast double click (one modal only).
   - Another user's profile with a particle effect, left before the effect
     starts (no canvas left behind).
   - Every egg: konami, barrel, matrix, and maxwell twice.
5. **Other pages.** Test these pages:
   - profile.intra.42.fr v2 (the dark v2 sheet and the v2 banner)
   - profile-v3 for another user, and /users/...
   - at least one other subdomain without the sidebar (e.g.
     projects.intra.42.fr, meta.intra.42.fr), with no error
   - the auth callback (`?token=&login=` still closes the window)
   - a page restored from bfcache (back/forward)
6. **CSP and lifecycle.**
   - Look for CSP violations in the console on each subdomain.
   - Update or reload the add-on while a tab is open, then click the gear in
     that tab: it must fail cleanly, with no duplicate UI.
   - Use the popup's Intra login while a page is still loading.
7. **Performance, the go/no-go.** Use the Firefox Profiler (JS + screenshots)
   on profile-v3, own page, cold (first load after starting the browser) and
   warm (5 reloads), comparing the IIFE with the split. Measure:
   - the time until the graph is evaluated
   - the time until the theme is applied
   - the time until the customize CSS is applied
   - the time until the first widget renders
   - the total compile and run time of the content script

   Ship only if the split is not slower warm and shows no new flash.
8. **Chrome.** Run steps 1 to 6 once.

## How the numbers were produced

A throwaway config imported the default export of `vite.config.ts`, dropped the
`write-manifest` plugin, and replaced only `input` and `output`:

```ts
output: {
  format: "es",
  entryFileNames: "content-main.js",
  chunkFileNames: "chunks/[name].js",
  codeSplitting: { groups: [{ name: "content-core", tags: ["$initial"] }] },
},
// + build.modulePreload: false (the helper is emitted anyway)
```

The IIFE baseline, built through the same config, came out at exactly the
shipped 566,619 B. The module list per chunk came from a `generateBundle` hook.
The scratch folder was deleted afterwards.
