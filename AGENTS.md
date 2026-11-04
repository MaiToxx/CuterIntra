# Cuter Intra — Agent Guide

## Quick start

```bash
npm install
npm run build:firefox   # single production build for Firefox
npm run build:chrome    # single production build for Chrome
npm run dev:firefox     # watch + web-ext hot-reload
```

## Project structure

- **`src/main.ts`** — content script entrypoint. Feature init via `featureInitializers` map. Runs on `https://*.intra.42.fr/*` at `document_start`.
- **`src/popup/popup.ts`** — popup entrypoint.
- **`src/features/`** — self-contained features: `account/`, `announcement/`, `calendar/`, `campus/`, `clusters/`, `customize/`, `eggs/`, `friends/`, `hub/`, `logtime/`, `performance/`, `profile/`, `shortcuts/`, `subjects/`.
- **`src/core/config.ts`** — single source of truth for all chrome.storage keys; typed `BetterIntraConfig` interface + defaults (`config/schema.ts`, `config/defaults.ts`, `config/keys.ts` for what cloud sync uploads).
- **`manifests/manifest.{chrome,firefox}.json`** — per-browser manifest templates. `finalizeManifest()` in `vite.config.ts` turns one into the shipped `manifest.json`: version from package.json, worker origin from `config.workerUrl`, Firefox id/update URL from `repository`, and in `authMode: "intra"` no content script on the worker's `/callback` page. `tests/manifests.test.ts` covers it; `tests/privacy-doc.test.ts` ties PRIVACY.md to the manifests.
- **`better-intra-worker`** (sibling repo, `../better-intra-worker`) — the Cloudflare Worker (wrangler) behind cloud sync, public visuals, the calendar feed and the subject tracker. Has its own `package.json`.

## Auth mode

`package.json` `config.authMode` is `"intra"` here (it becomes the `__AUTH_MODE__` define, read as `AUTH_MODE` in `src/core/worker.ts`). Signing in POSTs the Intra session JWT (from `auth.42.fr`, captured by `hook.js`) to the worker's `/auth/intra`; the worker verifies it against 42's JWKS (and its `azp` against `JWT_ALLOWED_AZP`) and answers a random session token, stored as `CLOUD_TOKEN` (the worker keeps only its SHA-256, in D1). The `"oauth"` mode (upstream's 42 application, `/login` + `/callback`, `src/auth-callback.ts`; this fork's worker no longer has those routes) is dormant: `src/features/account/account.ts`, `friends.ts`, `logtime.ts` and `roulette-stats.ts` still branch on `AUTH_MODE`, and `tests/friends-data-oauth.test.ts` keeps that branch honest. Sign-in never needs a 42 API token. The worker's own 42 application (optional, worker secrets `FT_CLIENT_ID`/`FT_CLIENT_SECRET`, `src/ft-api.ts`) serves read-only additions announced by `GET /api/v1/public/features`: today `logtimeHistory`, your own logtime history for "Load older months" (`logtime.ts` `canLoadOlder`). Its secret rotates about every 30 days.

## Build quirks

Always set **both** `TARGET` and `BUILD_OUT_DIR` env vars (cross-env handles this). The build pipeline is: `tsc` → `vite build` (content script) → `vite build --config vite.popup.config.ts` (popup) → `vite build --config vite.background.config.ts` (background service worker) → `node scripts/build-auth.mjs` (`auth-callback.js`, the content script for the worker's OAuth callback page, built with `vite.auth.config.ts` only in `authMode: "oauth"`; in intra mode it is not built and a stale copy is removed).

```bash
cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox tsc && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build --config vite.popup.config.ts && cross-env TARGET=firefox BUILD_OUT_DIR=dist-firefox vite build --config vite.background.config.ts
```

- `tsc` type-checks only (`noEmit: true` in tsconfig.json).
- Output is `dist-firefox/` or `dist-chrome/` (gitignored).
- `content.js` is bundled as IIFE. `popup.js` is bundled separately. `background.js` is bundled as IIFE.
- `manifest.json` is generated on the fly from per-browser manifest templates.
- Icons are copied from `public/icons/` on build. To regenerate: `node scripts/generate-icons.js` (requires `sharp`).

## dev scripts

- `npm run dev:firefox` — watch mode + web-ext auto-reload with Firefox.
- `npm run dev:chrome` — watch mode + web-ext auto-reload with Chrome.
- `npm run dev:brave` — like Chrome but uses Brave binary path from `package.json`.

## Framework & toolchain

- **Vite 8** + `@tailwindcss/vite` plugin (no `tailwind.config.js` — Tailwind v4 CSS-driven config).
- **daisyUI 5** — loaded via `@plugin "daisyui"` in `src/core/styles/style.css`; only a subset of components included.
- **TypeScript 7** — `strict: true`, `moduleResolution: bundler`, `types: ["chrome"]`.
- **`lit-html`** — used for DOM templating in the settings UI (hub) and popup.
- **`web-ext`** — for running and signing the extension.
- **Icons**: Font Awesome SVG icons in `src/assets/svg/`.

## DaisyUI note

daisyUI is scoped to shadow DOM roots (see `style.css` `root:` config). Only these components are included: `button, toggle, input, select, radio, label, card, tabs, modal, divider, swap, fieldset, status, tooltip, badge, collapse, ring, avatar, indicator, list, loading, join, kbd, dropdown, menu`.

## Testing

Tests use Vitest with `jsdom` environment and global API. Run `npm test` (single pass) or `npm run test:watch` (watch mode). Test files: `tests/*.test.ts` (one file per feature or concern, about a hundred), with the chrome.storage mock in `tests/setup.ts`. Config: `vitest.config.ts`. `tests/no-html-injection.test.ts` fails on any `innerHTML` / `insertAdjacentHTML` / `outerHTML` in `src/`. `tests/worker-contract.test.ts` pins each worker request of the cloud flows (path, method, query, body fields) and, with `../better-intra-worker` next to this repository (not in CI; `vitest.config.ts` allows that directory), runs the same flows against the worker's own code on its test D1 and KV.

Browser-level: `node scripts/firefox-smoke.mjs <build>` (Firefox) and `--browser chrome` (Chrome, also run in CI) load a build into a real browser against a synthetic Intra page: docs/FIREFOX-TESTING.md.

## Extension mechanics

- Runs as a content script injected at `document_start` on `https://*.intra.42.fr/*`.
- Hooks `window.fetch` in `public/hook.js` to intercept `/locations_stats` for logtime data and the Intra token. It is declared in the manifests as a content script with `"world": "MAIN"` at `document_start` (Firefox 128+, Chrome 111+), so it runs before any page script; it is no longer injected with a `<script>` tag.
- Settings stored in `chrome.storage.local` via typed `getConfig()` helper (one snapshot per context, see `src/core/config/snapshot.ts`).
- Cloud sync (optional) talks to the worker with the session token from the Intra-token sign-in (see *Auth mode*). The worker keeps settings, published visuals, the calendar `.ics` and subject reports under a SHA-256 hash of the login, and each session as a hash of its token in D1; PRIVACY.md is the reference for what goes where (with the worker repo next to this one, `tests/privacy-doc.test.ts` fails when a D1 table of its migrations is not described there).
- `src/background.ts` (built by `vite.background.config.ts`) does three things: the GitHub release check on a 6-hour alarm (badge + `UPDATE_AVAILABLE`, a plain CORS request, no host permission), fetching Intra pages cross-origin with the user's cookies for content scripts (`FT_FETCH_INTRA_PAGE`), and reloading the profile tabs after a login. No polling, no notifications.
- Host permissions are `*.intra.42.fr` and the worker only; the popup and the login button request exactly those with `chrome.permissions` (Firefox treats MV3 host permissions as optional).

## Worker (`../better-intra-worker`)

Its README is the reference (every route, limit and table, what *Wipe all data* deletes and in which order, rollback caveats); this is the map.

- **Older builds keep calling it.** Extension builds stay installed for weeks after a release, so a worker change keeps every route and every success body they read: add fields, optional parameters and routes; change a body only when the client opts in (as with `baseRev` below). Old KV records keep working and are migrated lazily when used, never in bulk (a bulk pass costs one KV write per user).
- **`BETTER_INTRA_KV`** — one JSON record per login hash, `{settings, settingsRev}` (a record not pushed since sessions moved to D1 still carries its old `sessionTokens`: read once to copy them, dropped by its next write), `img:<hash>:<slot>` uploaded images (KV metadata `{type, v}`), and two small caches, `INTRA_JWKS_CACHE` and `ANNOUNCEMENT`. The namespace shares 1,000 writes a day on the free plan: never add a write on a hot path. Each counted put (settings push, image upload, a first sign-in's record) first spends one unit of the daily budget in D1 (`src/budget.ts`: 200 a day per login, 900 in all, sign-ins up to 980; past it `503 daily_write_budget`, nothing written; sign-outs and deletes are never counted), and a put KV refuses for its one-write-per-second-per-key limit is retried once after about 1.1 s, then answers `503 kv_busy` with `Retry-After: 2`. A sign-in answers neither: past the budget, or with KV refusing twice, it leaves the record to the first push and still signs in (a 503 there reads as "42's key server did not answer" in every build).
- **D1** (binding `better_intra_d1`, database `better-intra-d1`) — `sessions` (login hash, SHA-256 hex of the token, `created_at` in ms; 10 per login, the newest kept, refused after 365 days) and `session_migrations` (logins whose KV `sessionTokens` were copied, kept after a wipe), `users` (login hash and first sign-in, the public stats; `country` is no longer written), `calendar_ics` and `calendar_tokens` (revoked links stay as tombstones), `subjects` (and `projects`, read by nothing), `kv_write_budget` (UTC day, login hash or `'*'`, count; two days kept), `public_visuals` (the public subset of a login's settings, written by a push that changes it, deleted by a wipe; the public routes fall back to the KV record for a login without a row). The live database also holds upstream tables nothing reads (`eval_*`, `outstanding_*`, `*_stats_cache`, `logtime_history`, `cursus`, `correction_point_historics`): never drop or alter them, the operator decides that by hand.
- **Migrations** — `migrations/NNNN_name.sql` (`wrangler.json` `migrations_dir`), additive only (`CREATE ... IF NOT EXISTS`, new tables and columns), never edited once applied: a schema change is the next numbered file. `0001_baseline.sql` is the schema from before migrations and changes nothing on the live database. `schema.sql` is the same schema in one file (a test checks they agree), and the tests' SQLite D1 (`tests/helpers/fake-env.ts`) is built from `migrations/`. Local: `npx wrangler d1 migrations apply better-intra-d1 --local`. Live: see *Deploy and roll back*.
- **Routes** (full table in the worker README). Private routes take `?login=<hash>` (64 hex) and `Authorization: Bearer <session token>`.
  - `/auth/intra` — sign-in; the JWT's `azp` must be listed in `JWT_ALLOWED_AZP` (else the same 401 as an invalid token). Writes the session to D1 only; the KV record only with the login's first live session, when it has none.
  - `/api/v1/private/settings` — GET answers `rev` (0 when absent), also with `&fields=meta`. POST takes `{settings}` and an optional numeric `baseRev`: stored rev newer → `409 {"error":"conflict","message","rev":<stored>}`, nothing written; success → `{"ok":true,"rev":<new>}` when `baseRev` was sent, the text `Saved` when not (older builds, partial pushes). Rev = max(now, previous + 1). DELETE signs this session out, `&all=true` wipes.
  - `/api/v1/private/sessions` — GET `{"sessions":[{"id":"<first 8 hex of the token hash>","createdAt":<ms>,"current":bool}]}`; DELETE `&others=true` revokes every session but the caller's, `{"revoked":<n>}`.
  - `/api/v1/private/export` — GET: everything kept about the caller as one JSON file (`exportedAt`, `loginHash`, `settings`, `rev`, `sessions`, `firstSignIn`, `calendar`, `images`, `publicVisuals`); never a token, never another login's data; write rate limit.
  - `/api/v1/private/calendar/*` — `token` GET answers `{"token":"<live token>"|null}`, POST creates a link, DELETE stops sharing and deletes the feed; `update` answers 410 `calendar_stopped` once every link is revoked. `/calendar/<token>.ics` serves the feed.
  - `/api/v1/private/images` (POST `?slot=avatar|banner|background`, DELETE `?slot=`) and `/img/<hash>/<slot>`; `/api/v1/private/subjects/*`.
  - Public: `/api/v1/public/visuals` (by login hash, `?logins=` for up to 50; D1 first, then the KV record, same bytes either way), `/api/v1/public/stats`, `/api/v1/public/announcement`, `/api/v1/cluster/svg`, `/gh/*` (GitHub proxy for campus and data files).
- **Errors** — every error body is `{"error":"<code>","message":"<English text>"}` with the status the case always had (401, 409, 410, 413, 415, 429, 500...; the two new cases, `daily_write_budget` and `kv_busy`, are 503). Stable codes: `unauthorized`, `rate_limited`, `daily_write_budget`, `too_large`, `conflict`, `calendar_stopped`, `bad_request`, `not_found`, `kv_busy`, `unsupported_image_type`, `image_too_large`, `server_error`. The client translates from the code; `message` is for older builds and logs.
- **Rate limits** — writes per login hash, anonymous routes per IP (an IPv6 address by its /64 prefix, IPv4 as is).
- **Removed in 1.13.0**, not dormant: 42 OAuth `/login` + `/callback`, Discord, evaluations, the students directory, upstream's logtime history (with user tokens) and every cron. Your own logtime history came back in 1.19.0 through the worker's own 42 application (`/api/v1/private/logtime/history`, 404 when the application is not configured). `tests/index.test.ts` asserts they answer 404 and that there is no `scheduled` handler. The extension's `"oauth"` mode (*Auth mode*) needs upstream's worker.
- **Secrets and vars** — one secret, optional: `ANNOUNCEMENT_SECRET` (the announcement POST; unset, the route is closed). Set or rotate it with `npx wrangler secret put ANNOUNCEMENT_SECRET`; for `wrangler dev` it goes in `.dev.vars` (gitignored). Never read, print or commit it. `wrangler.json` `vars`: `JWT_ALLOWED_AZP` (`"frontend-react"`, the Intra v3 front-end; empty or absent turns the client check off, so a wrong value is undone by editing it). Bindings: `BETTER_INTRA_KV`, `better_intra_d1`, rate limits `WRITE_RL`, `ANON_RL`, `VISUALS_RL`, `ADMIN_RL`. `"preview_urls": false` on purpose: a preview URL keeps an old version reachable against the live KV and D1.

### Commands

```bash
cd ../better-intra-worker
npm install
npm test            # vitest: FakeKV, FakeD1 on real SQLite built from migrations/
npm run typecheck   # tsc --noEmit -p .
npm run dev         # wrangler dev (local KV and D1: apply the migrations with --local first)
npm run deploy      # only with explicit user consent, see below
```

### Deploy and roll back

Live operations: each step that touches the live worker or database needs the user's explicit consent.

1. **Migrations first.** `npx wrangler d1 migrations list better-intra-d1 --remote`, then, when one is pending, `npx wrangler d1 migrations apply better-intra-d1 --remote`. They only add, so the running worker is unaffected; a worker deployed without its tables answers 500 on the routes that need them.
2. **Deploy** with `npm run deploy` (`scripts/deploy.mjs`): it refuses uncommitted changes, failing tests or type check, and a live database that has not applied every file of `migrations/` (it reads `d1_migrations`, read-only), then runs `wrangler deploy --tag <commit> --message "<commit> <subject>"`. `npm run deploy -- --dry-run` runs the same checks but the live migrations one and builds without uploading. Not `wrangler deploy --remote` (wrangler 4 refuses the flag), not a bare `npx wrangler deploy` (it skips every check and tags nothing).
3. **Check**: `curl https://betterintra-remake.maitox.workers.dev/api/v1/public/stats` answers 200 JSON.
4. **Roll back**: `npx wrangler deployments list` (each version's tag is its commit), then `npx wrangler rollback <version-id> --message "<why>"`. It restores code and config only, never the D1 schema, the D1 rows or the KV data: read the "Rolling back" notes (under Sessions and Operations notes) in the worker README first. A worker from before D1 sessions checks the tokens still listed in each KV record: every session opened since, and every browser of a login that pushed since, is signed out, while a session revoked since (sign-out, sign out other browsers, 365 days) works again as long as its record was not pushed since. After rolling forward again, `public_visuals` rows may be stale.

## CI

- **Release drafter** — on push/PR to `main`; auto-categorizes commits into draft release.
- **Publish** — triggers on GitHub Release publish; builds Firefox (`.xpi`) and Chrome (`.zip`); signs Firefox via AMO for full releases.

## Languages (English and French)

- Every text a user sees or hears goes through `t()` from `src/core/i18n/i18n.ts`: the English text is the key, `src/core/i18n/fr/*.json` (one file per area) gives the French. `tp(n, one, other)` for counts, `msg()` for module-level constants (translated with `t()` where shown), `intlLocale()` for dates.
- The first argument is a string literal: the build (`scripts/i18n-catalog.ts`) keeps in each bundle only the translations whose English text it contains.
- `tests/i18n-catalog.test.ts` fails on a text without French, an unused entry or a lost `{placeholder}`. Tests run in English (`tests/setup.ts` stubs an en-US browser).
- The language is `UI_LANGUAGE` (Advanced tab: Auto / Français / English), read by `initI18n()` before anything renders. Never translate text matched against the Intra's own page.
- French style: tutoiement, U+00A0 before `: ; ! ?` and inside `« »`, apostrophe `’`.

## DOs and DON'Ts

- **NEVER use `innerHTML`** — lit-html is always available. Use `render(unsafeHTML(...), container)` from `lit-html` and `lit-html/directives/unsafe-html.js` instead.
- **NEVER commit without explicit user approval** — do not run `git commit`, amend, or push unless the user explicitly asks you to.

## NEVER deploy the worker without explicit user consent

## No linter; Prettier for formatting

Prettier is used for formatting (editor-level; no committed config). No ESLint or similar configured.
