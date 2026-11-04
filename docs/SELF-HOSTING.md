# Self-hosting the cloud worker

Cuter Intra's cloud features (sign-in, settings sync, custom profile visuals
shared with other users, cluster map proxy, calendar sync, subject tracker)
talk to a Cloudflare Worker. This edition uses
`https://betterintra-remake.maitox.workers.dev`. If that instance is down or
you want to own your users' data, deploy your own and point the extension at it.

Everything the extension needs is driven by **one setting**:
`package.json` → `config.workerUrl`. The build injects it into the code and the
manifests' host permissions (and, in `"oauth"` mode only, the callback content
script's match pattern).

> Switching worker means a fresh cloud account for every user: sessions,
> synced settings and shared visuals live in the worker's storage and are not
> migrated. Users simply click *Sign in with 42* again.

The public visuals endpoint (`/api/v1/public/visuals`) also returns a `look`
object when the user turned on *Publish my look on my profile*: the subset of
their Customize settings listed in `PUBLIC_LOOK_KEYS` (worker
`src/handlers/settings.ts`, extension `src/features/customize/public-look.ts`).
The extension validates every value again before applying it.

Those two key lists are kept in sync by hand. Each repository pins the list
in a test (`tests/extras-contract.test.ts` here, `tests/settings.test.ts` in
the worker), so adding a public setting fails both suites until the worker is
updated and redeployed.

## Without a 42 OAuth application: "intra" auth mode

Creating a 42 API application requires student status (pisciners get
"YOU ARE NOT ALLOWED TO CREATE A NEW APP"). The fork of the worker at
[MaiToxx/CuterIntra-worker](https://github.com/MaiToxx/CuterIntra-worker)
adds `POST /auth/intra`: the extension sends the Keycloak session token the
Intra v3 front-end already uses, the worker verifies its signature against
`auth.42.fr`'s public keys and opens a session for that login. No popup, no
redirect, no application to register. Enable it in `package.json`:

```json
"config": {
  "workerUrl": "https://<your-worker-url>",
  "authMode": "intra"
}
```

What needs a 42 application stays out of this edition: evaluation reminders
and Discord, the students directory, outstanding stars, logtime history beyond
what the Intra page provides. Since 1.13.0 the worker fork no longer carries
those routes at all: they answered 404 or errors on a deployment without an
application, so they were removed with their crons, D1 tables and secrets. What
the worker does today is listed in its README (`Routes`, `Limits`, `Data kept
in D1`).

Friends' live data is rebuilt from the Intra's own API by the extension
(src/features/friends/friends-intra.ts); correction stats and Thursday Roulette
history are rebuilt from the Intra v2 pages
(src/features/profile/cards/profile-stats-intra.ts). Settings sync, shared
profile visuals, cluster map proxy, announcements, subject tracker and calendar
sync work.

## 1. What you need

- A **Cloudflare** account (the free plan is enough: Workers, KV, D1 and the
  rate limit bindings).
- **Node.js** and `npx wrangler` (installed by the worker's `npm ci`).

No R2 bucket, no Discord bot. A 42 application is optional: with one (its UID
and secret as the worker secrets `FT_CLIENT_ID` and `FT_CLIENT_SECRET`), the
worker also serves your own logtime history ("Load older months"); without
one that route answers 404 and the card stays hidden.

## 2. Get the worker code

```bash
git clone https://github.com/MaiToxx/CuterIntra-worker.git better-intra-worker
cd better-intra-worker
npm ci
npx wrangler login
```

The campus/data proxy (`src/handlers/gh-proxy.ts`, `SOURCES`) points at this
extension repository; change it if you fork the campus files too.

## 3. Create the storage resources

```bash
npx wrangler kv namespace create BETTER_INTRA_KV
npx wrangler d1 create better-intra-d1
```

Each command prints an id. Edit `wrangler.json`:

- `name`: e.g. `better-intra-42campus` (becomes the URL `https://better-intra-42campus.<account>.workers.dev`)
- `kv_namespaces[0].id`: the KV id
- `d1_databases[0].database_id`: the D1 id. Keep `database_name`
  `better-intra-d1` and `migrations_dir` `migrations`: the deploy script and
  the commands below use that name.
- `ratelimits`: keep as is (the namespace ids only need to be unique inside
  your account)
- `workers_dev: true` and `preview_urls: false`: keep them. A preview URL
  keeps every past version of the worker reachable, running its old code
  against your live data.

Then create the tables:

```bash
npx wrangler d1 migrations apply better-intra-d1 --remote
```

This applies every file of `migrations/` in order and records each one in the
database's `d1_migrations` table, so a later update applies only the new
files. Migrations only ever add tables and columns (`CREATE ... IF NOT
EXISTS`). For `npm run dev`, run the same command once with `--local`
instead of `--remote`.

A worker set up before `migrations/` existed (with
`npx wrangler d1 execute ... --file=schema.sql`) runs that same apply command
once before its next update: `0001_baseline.sql` only creates what is
missing, so it changes nothing on a database made from the old schema, and
the files after it add the new tables.

## 4. Secrets and variables

One secret, and it is optional:

```bash
npx wrangler secret put ANNOUNCEMENT_SECRET     # lets you publish banners to all users
```

Give it a long random value (`openssl rand -base64 32`); running the command
again replaces it. Without it the announcement route stays closed. For
`npm run dev`, put `ANNOUNCEMENT_SECRET=<value>` in a `.dev.vars` file next to
`wrangler.json` (the worker's `.gitignore` already excludes it).

One variable, in `wrangler.json` → `vars`: `JWT_ALLOWED_AZP`, the
comma-separated Intra clients whose tokens may sign in. `"frontend-react"` is
the Intra v3 front-end, the only client the extension sends tokens from:
keep it. A token issued to any other client gets the same 401 as an invalid
one. An empty value turns the check off, which is the way back if 42 ever
renames that client.

## 5. Deploy and check

Commit your `wrangler.json` edits first, then:

```bash
npm run deploy
curl https://<your-worker-url>/api/v1/public/stats
```

`npm run deploy` (`scripts/deploy.mjs`) refuses to deploy a working tree with
uncommitted changes, failing tests or type check, or a database that has not
applied every migration (it reads `d1_migrations`, read-only). Then it runs
`wrangler deploy` with the commit as the version's tag and message.
`npm run deploy -- --dry-run` runs the same checks, except the live
migrations one, and builds without uploading.
A bare `npx wrangler deploy` still works but skips every check and tags
nothing.

The stats endpoint must answer JSON.

## 6. Point the extension at it

In this repository, edit `package.json`:

```json
"config": {
  "workerUrl": "https://<your-worker-url>",
  "authMode": "intra"
}
```

Build (`npm run build:firefox` / `npm run build:chrome`) or publish a release:
the manifests and every API call now target your worker. Users install that
build and click *Sign in with 42* once.

## Updating the worker

```bash
git pull
npm ci
npx wrangler d1 migrations list better-intra-d1 --remote    # what the update adds
npx wrangler d1 migrations apply better-intra-d1 --remote
npm run deploy
```

`git pull` may have to merge `wrangler.json`: keep your own `name` and ids,
and take every new key (a variable, a binding, `migrations_dir`). `npm ci`
installs exactly what `package-lock.json` lists and never rewrites it
(`npm install` can, and the deploy script refuses a working tree with a
change).

Apply the migrations before deploying. They only add, so the worker still
running is unaffected; the other way round, the new code can answer 500 on
the routes that need a table it does not find yet, which is why the deploy
script refuses to run while one is pending. Never edit or delete a migration
that was applied: the next schema change is the next numbered file.

The update keeps working for users of older extension builds: the worker
keeps the routes and answers they use, and records written by an older
worker are converted when they are next used (session tokens copied into
D1, hashed, on each login's first request).

## Rolling back

```bash
npx wrangler deployments list    # each version's tag is its commit
npx wrangler rollback <version-id> --message "why"
```

A rollback restores the worker's code and configuration (bindings,
variables, rate limits), never the D1 schema, the D1 rows or the KV data:
those only move forward, and an older worker ignores what it does not know.
Rolling back to a worker from before sessions moved to D1 makes it check the
tokens still listed in each KV record: every session opened since, and every
browser of a user who pushed since, is signed out (they sign in again), and a
session revoked since (*Sign out*, signing out the other browsers, the
365-day limit) works again while its user has not pushed since. After
rolling forward, the copies of public visuals in D1 may be stale. The worker
README (the *Rolling back* notes under *Sessions* and *Operations notes*, and
*Deploy and roll back*) gives the details and the clean-up command.

## Notes

- Logins are stored hashed (SHA-256). The worker never holds a student's 42
  API token: the Intra session JWT is verified once against `auth.42.fr`'s public keys,
  and the worker keeps only the SHA-256 of the random session token it
  answers (in D1, 10 per login, refused after 365 days).
- Limits (rate limits, the daily KV write budget, size caps, what "Wipe all
  data" deletes) are documented in the worker's README and in PRIVACY.md.
- Deploying is `npm run deploy` from your machine; there is no CI pipeline
  in the worker repository.
