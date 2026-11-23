# Development

## Prerequisites

- Node.js
- npm

## Setup

```bash
git clone https://github.com/MaiToxx/CuterIntra.git
cd CuterIntra
npm install
```

## Commands

```bash
npm run dev:firefox     # watch + web-ext auto-reload in Firefox
npm run dev:chrome      # watch + web-ext auto-reload in Chrome
npm run dev:brave       # watch + web-ext auto-reload in Brave
npm run build:firefox   # single production build for Firefox
npm run build:chrome    # single production build for Chrome
npm run build:chrome-store # the Chrome Web Store build (no release check, no alarms permission) -> dist-chrome-store/
npm test                # vitest (jsdom)
npm run measure         # size of every built file, and what fills the bundles
npm run check:size      # fails when a built file is over its budget (CI)
npm run check:cycles    # fails on a runtime import cycle in src/ (CI)
npm run release:check   # the release gate: tests, theme and cycle checks, both builds, budgets, Chrome smoke test
npm run generate:themes # themes.json + style.css theme blocks + hub list from scripts/themes/palettes.mjs
npm run smoke:firefox -- dist-firefox                    # automated Firefox smoke + timings
npm run smoke:firefox -- --compare <build-A> <build-B>   # side-by-side timing table
```

The Firefox harness needs a Firefox binary: `npx @puppeteer/browsers install firefox@stable --path .browsers` puts a portable copy in `.browsers/` (gitignored), or pass `--firefox <path>`. `npm run smoke:chrome -- dist-chrome` runs the same checks in an installed Chrome (`--chrome <path>` or `CHROME_BIN` otherwise); CI runs it on every push, and `npm run release:check` before every release. Both serve a synthetic Intra page under the real `https://profile-v3.intra.42.fr` origin; see docs/FIREFOX-TESTING.md.

Output goes to `dist-firefox/` or `dist-chrome/`.

## Build pipeline

Always `tsc` (type-check only, `noEmit`) → `vite build` (content script) → `vite build --config vite.popup.config.ts` (popup) → `vite build --config vite.background.config.ts` (background service worker) → `node scripts/build-auth.mjs` (`auth-callback.js`, content script for the worker's OAuth callback page so the login completes even when the opener window is gone). The last one only builds in `config.authMode: "oauth"`: in intra mode (this deployment) `finalizeManifest()` leaves the script out of the manifest, so `build-auth.mjs` does not build it and removes a copy an older build left in the output folder.

```bash
cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox tsc && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build --config vite.popup.config.ts && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build --config vite.background.config.ts
```

- `content.js` is bundled as IIFE. `popup.js` is bundled separately. `background.js` is bundled as IIFE.
- `manifest.json` is generated from `manifests/manifest.{chrome,firefox}.json` by `finalizeManifest()` in `vite.config.ts`: version from `package.json`, worker origin from `config.workerUrl`, Firefox id and update URL from `repository`, the `/callback` content script only in oauth mode. `tests/manifests.test.ts` checks it, and `tests/privacy-doc.test.ts` checks that PRIVACY.md names every permission and host the manifests ask for.
- Host permissions are `https://*.intra.42.fr/*` and the worker. `api.github.com` is reached as a plain CORS request, by the release check in `src/background.ts` only (the About tab reads what that check stored and calls nothing; the Chrome Web Store build has no check). The Firefox manifest sets `strict_min_version` 140.0. The Chrome manifest sets `minimum_chrome_version` 111 (MAIN-world content scripts).
- Icons are copied from `public/icons/` on build. To regenerate: `node scripts/generate-icons.js` (requires `sharp`).

## Project structure

- `src/main.ts` — content script entrypoint. Feature init via `featureInitializers` map.
- `src/background.ts` — background service worker: GitHub release check on a 6-hour alarm, Intra page fetches for content scripts (with the user's cookies), tab reload after login. Nothing else runs in the background.
- `src/popup/popup.ts` — popup entrypoint (account/cloud sync UI).
- `src/core/` — what every feature uses and no feature owns. It never imports from `src/features/`.
  - `config.ts` — the public entry point for settings (`getConfig`, `getConfigMany`, `setConfig`, `CONFIG_DEFAULT`...), over `config/`: `schema.ts` (the `BetterIntraConfig` interface), `defaults.ts`, `keys.ts` (cloud-synced keys), `snapshot.ts` (the in-memory settings snapshot, one storage read per context; read its comment before touching it), `access.ts`.
  - `styles/` — `style.css` (Tailwind + daisyUI, built to `shared-styles.css` and `shared-themes.css`) and `shared-styles.ts`, which hands the sheets to shadow roots. docs/PERFORMANCE.md explains the two ways to use it and why the choice matters.
  - `theme/` — the theme manager and the Intra theme sheets.
  - `dom/` — `dom-wait.ts` (observer-based waits and visibility-aware tickers: use them instead of `setInterval` polling), tooltips, skeletons, dialogs, countdown, `svg.ts` (bundled icons without HTML strings).
  - `security/` — CSS value sanitisers for anything that ends up in a stylesheet.
  - `intra/` — Intra knowledge: `intrapy.ts`, the page selectors, profile login detection.
  - `lifecycle/` — `stale-instance.ts`, imported first by `main.ts`: after an add-on update, an open tab still holds the old instance's nodes (dead gear and Clusters button, a second friends widget). It removes them and the "already bound" flags before anything mounts. `own-ids.ts` lists the id prefixes the extension owns; add yours there when a feature mounts a node with a new id.
- `src/features/` — self-contained features: `account/`, `announcement/`, `calendar/`, `campus/`, `clusters/`, `customize/`, `eggs/`, `friends/`, `hub/` (`settings/` one data module per tab, `controls/` one renderer per setting family), `logtime/`, `performance/`, `profile/` (`header/`, `cards/`, `layout/`, `extras/`), `shortcuts/`, `subjects/`.
- `scripts/move-modules.mjs` — move files and rewrite every relative import that points at them (`git mv` keeps history); dry run by default. `scripts/reorganise-plan.json` is the plan used for the 1.11.0 layout.
- `manifests/` — per-browser manifest templates.
- `../better-intra-worker` — the Cloudflare Worker (wrangler) behind the cloud features, a sibling repository with its own `package.json`.

## Auth mode

`package.json` `config.authMode` selects how *Sign in with 42* works and is compiled in as `AUTH_MODE` (`src/core/worker.ts`). This deployment uses `"intra"`: the extension sends the Intra session JWT (issued by `auth.42.fr`, captured by `hook.js`) once to the worker's `/auth/intra`, the worker verifies it against 42's JWKS and returns a random session token that the extension stores as `CLOUD_TOKEN`. Friends, correction stats and roulette history are then read from the Intra with the user's own session. `"oauth"` is upstream's flow (a 42 application on the worker, `/login`, `/callback` and `src/auth-callback.ts`); its code paths stay in the tree and are tested (`tests/friends-data-oauth.test.ts`) but are never taken here.

## Toolchain

- **Vite 8** + `@tailwindcss/vite` plugin (Tailwind v4 CSS-driven config, no `tailwind.config.js`).
- **daisyUI 5** — loaded via `@plugin "daisyui"` in `src/core/styles/style.css`. Scoped to shadow DOM roots. Only a subset of components included (the `include` list of that block): alert, avatar, badge, button, card, countdown, divider, dropdown, indicator, input, join, label, list, loading, menu, modal, progress, select, skeleton, swap, tab, textarea, toggle.
- **TypeScript 7** — `strict: true`, `moduleResolution: bundler`, `types: ["chrome"]`.
- **lit-html** — DOM templating for settings UI and popup.
- **web-ext** — running and signing the extension.
- **Icons**: Font Awesome SVG icons in `src/assets/svg/`.

## Worker

The Cloudflare Worker (`../better-intra-worker`) handles the Intra-token sign-in and its sessions, settings sync, public visuals and looks, uploaded profile images, the calendar `.ics` feed, the subject tracker, the data export, the announcement and the public stats. With its own 42 API application configured (optional secrets `FT_CLIENT_ID` and `FT_CLIENT_SECRET`), it also serves four read-only routes announced by `GET /api/v1/public/features`: `/api/v1/private/logtime/history` (your own logtime history), `/api/v1/private/evaluations` (your correction stats, Outstanding counts, booked evaluations and correction points), `/api/v1/private/coalitions` and `/api/v1/private/events/attendees` (*Who's going*, the only route that names other students); without the application they answer 404. It has its own `package.json`, and its README documents every route, limit and table. AGENTS.md has the short version, including the error codes and the compatibility rule: extension builds stay installed for weeks, so a worker change keeps the routes and success bodies they read.

### Commands

```bash
cd ../better-intra-worker
npm install
npm test            # vitest, with an in-memory KV and a SQLite D1 built from migrations/
npm run typecheck   # tsc --noEmit -p .
npm run dev         # wrangler dev (run `npx wrangler d1 migrations apply better-intra-d1 --local` once first)
npm run deploy      # never without the user's explicit consent: see below
```

### Storage

- **`BETTER_INTRA_KV`** — one record per login hash (`{settings, settingsRev}`), the uploaded images (`img:<hash>:<slot>`) and two small caches (JWKS, announcement). The free plan allows 1,000 writes a day for the whole namespace, so pushes, uploads and first sign-ins spend a daily budget counted in D1 (200 a day per login) before writing.
- **D1** (`better_intra_d1`, database `better-intra-d1`) — `sessions` (a SHA-256 of each token, 10 per login, 365 days) and `session_migrations`, `users` (login hash, first sign-in; feeds `/api/v1/public/stats`), `calendar_ics`, `calendar_tokens`, `subjects`, `kv_write_budget`, `ft_call_budget` (the hourly count of calls to the 42 API: 200 per login, 1,000 in all), `public_visuals` (what visitors are served, read before the KV record). The live database also keeps upstream tables that nothing reads; they are left alone.
- **Migrations** — `migrations/NNNN_name.sql`, applied in order by `npx wrangler d1 migrations apply better-intra-d1 --remote`. They only add (`CREATE ... IF NOT EXISTS`) and are never edited once applied: a schema change is a new numbered file.

### Deploy and roll back

Both touch the live worker: only with the user's explicit consent.

1. `npx wrangler d1 migrations list better-intra-d1 --remote`, and `... migrations apply better-intra-d1 --remote` when one is pending (before the deploy: the new code needs its tables).
2. `npm run deploy` (`scripts/deploy.mjs`) refuses uncommitted changes, failing tests or type check and unapplied migrations, then deploys with the commit as the version tag (`npm run deploy -- --dry-run` runs the checks but the live migrations one, and builds without uploading).
3. Check that `https://betterintra-remake.maitox.workers.dev/api/v1/public/stats` answers JSON.
4. To roll back: `npx wrangler deployments list`, then `npx wrangler rollback <version-id> --message "<why>"`. Code and config go back, D1 and KV do not: read the "Rolling back" notes in the worker README first (a worker from before D1 sessions signs out the sessions opened since, and brings back the ones revoked since while their KV record still lists them).

### Removed upstream code

Upstream's OAuth login (`/login`, `/callback`), evaluation notifications (Discord), the students directory, logtime history (read with user tokens) and every cron were removed from the worker in 1.13.0; its tests assert that those routes answer 404. Two of them came back in another form, through the worker's own 42 application, without user tokens or crons: your own logtime history in 1.19.0 and your own evaluations in 1.20.0 (see *Worker* above). The extension's `"oauth"` auth mode stays in the tree (see *Auth mode*) but would need upstream's worker.

## Testing

Tests use [Vitest](https://vitest.dev/) with `jsdom` environment. Test files are in `tests/`.

```bash
npm test           # vitest run (single pass)
npm run test:watch # vitest (watch mode)
```

Test files: `tests/*.test.ts`, one per feature or concern (about two hundred). Global setup (the `chrome.storage` mock) is in `tests/setup.ts`. `tests/no-html-injection.test.ts` enforces the no-`innerHTML` rule, `tests/manifests.test.ts` the manifest build, `tests/privacy-doc.test.ts` keeps PRIVACY.md in step with the manifests and the sync key list and, when the worker repository sits next to this one, with the worker's D1 tables, session limits, write budget and export.

## Coding conventions

- **No `innerHTML`** — use `lit-html` (`render`, `unsafeHTML`) for all DOM templating.
- **Stylesheets in template literals** — tag them `css` (`src/core/dom/css.ts`): the build (`scripts/collapse-lit-templates.ts`) ships a `css` block and the `<style>` of an `html` template without comments or indentation, so comment them as freely as code. `tests/collapse-css-equivalence.test.ts` checks that the shipped text parses to the same rules.
- Features register in the `featureInitializers` map in `src/main.ts`.

## CI

- **CI** (`ci.yaml`) — on push/PR: type-check, tests, generated themes, both builds, the Chrome smoke test in the runner's Chrome (soft-skipped only when none is found, exit code 3), size budgets, import cycles.
- **Release drafter** (`release-drafter.yaml`) — on push to `main`; sorts the commits since the last tag into a draft release.
- **Publish** (`publish.yaml`) — on GitHub Release publish: the tag must name `package.json`'s version (`scripts/check-release-tag.mjs`, also worth running before `gh release create`), then `npm run release:check`, then the Chrome zip and `.crx`, the Chrome Web Store package (`chrome-web-store-upload.zip`, attached and kept as a run artifact), `updates.xml`, the store upload when its secrets exist, and last the AMO signing, the `.xpi` and `updates.json`. A submission Mozilla never created or refused turns the run red at its last step.
- **Finish release** (`finish-release.yaml`) — every half hour and on `gh workflow run finish-release.yaml -f tag=vX`: completes the latest release (the Chrome files a failed publish run left out, for a day and after that only on a manual run; the signed `.xpi` once Mozilla approves it; an `updates.json`/`updates.xml` push that failed). Never while a publish run for the tag is going or in the release's first 30 minutes (`scripts/release-state.mjs`), and it runs the same `release:check` before attaching Chrome files. A publish run that stopped before the AMO submission is recovered with `gh run rerun <id> --failed`; after the submission, leave the rest to this workflow (a rerun resubmits a version AMO already has, and its signing step fails).

## Formatting

Prettier is used for formatting (editor-level; no project config file committed). No linter is configured.
