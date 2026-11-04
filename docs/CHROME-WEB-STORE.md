# Automatic updates on Chrome (Windows / macOS): the Chrome Web Store

Chrome on Windows and macOS only auto-updates extensions that come from the
Chrome Web Store. An unpacked build (*Load unpacked*) or a self-hosted `.crx`
never updates itself there (`CRX_REQUIRED_PROOF_MISSING`). On Linux the
self-hosted `.crx` + `updates.xml` route works; on Firefox, `updates.json`
already does the job.

The release workflow can publish every release to the Web Store by itself.
It needs a developer account and five repository secrets, once.

## The store package

`npm run build:chrome-store` writes `dist-chrome-store/`. It is the Chrome
build (`dist-chrome/`) with three differences, all decided at build time
(`CHROME_STORE=1`, compiled in as `__STORE_BUILD__`):

- no `update_url` in the manifest: the store sets its own;
- no GitHub release check: no **NEW** badge, no *Download* banner in the
  popup, no update prompt in the About tab. A release is tagged on GitHub
  hours or days before Google's review lets the store copy follow, and that
  prompt would send store users to a zip that installs a second copy of the
  extension next to the store one;
- no `alarms` permission, since the release check was its only use.

The GitHub builds (`.xpi`, `better-intra-chrome.zip`, `.crx`) keep the check:
for them it is the only way to hear about a new version. Every package ships
`LICENSE` and `THIRD_PARTY_NOTICES.txt` next to `manifest.json`.

Every release also carries the store package itself, built from the release
tag by the release workflow: `chrome-web-store-upload.zip`. It is for the
dashboard only. Installed by hand it would never hear of an update, so its
name is not `better-intra*.zip`, the pattern students and the in-extension
update check (`RELEASE_ASSET_CHROME`) look for.

## 1. Developer account and first upload (one-time, 5 USD)

1. Sign in at https://chrome.google.com/webstore/devconsole with a Google
   account and pay the one-time registration fee.
2. *New item* → upload the store package: `chrome-web-store-upload.zip` from
   the GitHub release (also kept for 90 days as an artifact of the release's
   *Build and Publish* run). Not `better-intra-chrome.zip`: that one is
   `dist-chrome`, with the self-hosted `update_url` and the release check.
   Before the first release that attaches it, build and zip it with:

   ```bash
   npm run build:chrome-store
   npx web-ext build --source-dir dist-chrome-store --filename better-intra-chrome-store.zip --overwrite-dest
   ```

   The zip lands in `web-ext-artifacts/`, with `manifest.json` at its root.
   Do not zip the folder with Explorer (*Send to* → *Compressed folder*) or
   Windows PowerShell's `Compress-Archive`: they write `icons\icon-128.png`
   with a backslash, a path the zip format does not define, and the store
   may not find the icons. A `better-intra-chrome-store.zip` left at the
   repository root by an earlier manual build was made that way: rebuild it.
3. Fill the **Store listing** tab: description (`npm run generate:description`
   turns `CHROME_LISTING.md` into `images-store/description.txt`), category
   *Productivity*, language, the images (see [Store images](#store-images)),
   and the privacy policy URL:
   `https://github.com/MaiToxx/BetterIntraRemake/blob/main/PRIVACY.md` (the
   file tests/privacy-doc.test.ts checks against the manifests).
4. Fill the **Privacy practices** tab: see [Privacy practices](#privacy-practices-tab).
5. Fill the **Test instructions** tab: see [Test instructions](#test-instructions-tab).
6. Submit for review. The first review takes from a few hours to a few days.
   Note the **extension id** shown in the dashboard (32 letters).

The Web Store id is not the same as the unpacked or `.crx` id: users switch
by installing from the store once and removing the old copy (cloud sync
brings their settings back). Two copies side by side inject the same widgets
twice into every Intra page.

## Store images

- **Screenshots**: at most five, 1280×800. Take them fresh from
  `dist-chrome-store` loaded in a real Chrome, on your own profile, with **no
  other student visible**: leave out the cluster map and the friends list, or
  blur every other student's photo and login in them, and use no film or
  cartoon characters as avatars. Suggested set: logtime calendar, profile
  editor, settings hub (with the search box), Customize tab, cluster map with
  the seats blurred. Put the captures (PNG or JPEG, 16:10, e.g. 1280×800 or
  2560×1600) in `store-screenshots/` and run `npm run generate:store-images`:
  it crops each to 1280×800 edge to edge (no white bands), warns when a
  capture is far from 16:10, and refuses a sixth.
- **Small promo tile** (440×280, required) and **marquee** (1400×560,
  optional): the same command draws them from `src/assets/svg/icon.svg` and
  the name on a teal gradient. No screenshot, no 42 photo.
- Output: `images-store/` (gitignored). Upload `promo-small.png`,
  `promo-marquee.png` and the `*-screenshot.png` files.
- `images/` holds upstream's 1.8.6 screenshots for the README. Never upload
  them: `intra.png` is upstream's author's own 42 profile, and `friends.png`
  uses film characters as avatars.

## Permission justifications

One line per entry of the store package's manifest:

- `storage`: settings and caches in `chrome.storage.local`
- host permission `https://*.intra.42.fr/*`: the extension only runs on the
  42 intranet; the background also reads Intra pages there with the user's
  cookies (correction stats, roulette history)
- host permission on the worker (`betterintra-remake.maitox.workers.dev`):
  the extension's own server (sign-in, settings sync, public visuals,
  calendar feed, subject tracker)
- `minimum_chrome_version` 111: the first Chrome that runs the MAIN-world
  `hook.js` content script and the Tailwind 4 stylesheet; older Chromiums
  refuse the install with a clear message instead of running a broken
  extension

Not requested, in case a reviewer asks: `alarms` (the store package has no
release check), `activeTab` (the Firefox manifest keeps it; on Chrome the
Intra host permission already covers the popup), any host permission for
`api.github.com`. In `config.authMode: "intra"` (this deployment) the
manifest carries no content script on the worker's `/callback` page: that
script only serves the OAuth flow (docs/SELF-HOSTING.md).

## Privacy practices tab

The answers must match what the package sends (PRIVACY.md, written from the
code), and the listing and the product must say the same: since the policy
update of 1 August 2026, data collection has to be disclosed in the product
itself, before it happens. Revisit this tab whenever a release changes what
leaves the browser.

**Single purpose**

> Improves the 42 school intranet (*.intra.42.fr) for the student using it:
> extra views, widgets and customisation on those pages, with optional
> settings sync through the extension's own server. It does nothing on other
> sites.

**Are you using remote code?** No.

> All JavaScript is in the package. The server returns JSON, images and an
> .ics file, never code. Campus and cluster data files are JSON fetched
> through our server's /gh/ proxy; cluster map SVGs are sanitised (scripts,
> event handlers and javascript: links removed) before they are shown.
> hook.js is a packaged MAIN-world content script: it reads the page's own
> Intra API token from the page's fetch calls, locally, for the sign-in and
> the logtime data.

**Data usage**: tick these, and only these.

| Category | What the extension sends |
| --- | --- |
| Personally identifiable information | The SHA-256 hash of an Intra login (the key of everything stored, and of each profile lookup); at sign-in, the Intra session token, which carries the login; the friends list (other students' logins) inside pushed settings. |
| Authentication information | The Intra session token (JWT), sent once at sign-in, checked against 42's public keys and not stored; the random session token the worker returns, kept by the extension (the worker keeps only its SHA-256 hash, 365 days at most). |
| Location | Not collected. The IP address reaches Cloudflare with every request and is not stored; no country is kept (since 1.14.0), and uploaded images are stripped of their GPS metadata. Leave this box unticked. |
| Web history | The login hash of each Intra profile opened (`?login=<hash>`, also when signed out); when signed in with *Share with the community* on, the project slug and subject PDF address of project pages opened. |
| Website content | Pushed settings (shortcuts, custom CSS, texts), the public profile texts and look, uploaded images, the subscribed Intra events of the calendar feed, subject PDF addresses. |

Leave unticked: health information, financial and payment information,
personal communications, user activity.

The Firefox package declares the same practices to Firefox's install prompt
(`data_collection_permissions` in `manifests/manifest.firefox.json`:
`authenticationInfo`, `browsingActivity`, `personallyIdentifyingInfo`,
`websiteContent`). tests/privacy-doc.test.ts ties each of them to a row
ticked here, each ticked row to its Firefox category, and both to
PRIVACY.md: change the three files together.

Tick the three certifications: no sale or transfer of user data outside the
approved use cases, no use or transfer unrelated to the single purpose, no
use for creditworthiness or lending.

**In-product disclosure.** The sign-in buttons (popup and hub footer) must
show, next to the button, a line to this effect, with *Privacy policy*
linking to PRIVACY.md:

> Signing in sends the Intra session token this page already holds, once, to
> betterintra-remake.maitox.workers.dev. The server checks it against 42's
> public keys and does not keep it; it stores a hash of your login and
> your first sign-in date. Once you are signed in,
> the project pages you open report their subject link to the community
> tracker (switch it off in Extras), and the settings you push are stored
> under your login hash. Privacy policy

Profile lookups made while signed out (the `?login=<hash>` above) happen
before any in-product notice; PRIVACY.md and the listing's privacy paragraph
cover them.

## Test instructions tab

Google marks this tab optional and meant for items that need credentials a
reviewer does not have, which is this case: every feature runs behind a 42
student sign-in. Fill it once; it stays for later versions, and every
auto-published version is reviewed again. Paste:

> Cuter Intra only runs on https://*.intra.42.fr, the intranet of the 42
> schools. Using it needs a personal 42 student account, and the school's
> rules forbid sharing one, so we cannot provide test credentials. Off the
> Intra, the toolbar popup only offers to open the Intra, and the extension
> does nothing. The screenshots show each feature on the author's own
> profile. Signing in is optional: it sends the user's Intra session token
> once to our server at betterintra-remake.maitox.workers.dev, which checks
> it against 42's public keys and returns a random session token (privacy
> policy: https://github.com/MaiToxx/BetterIntraRemake/blob/main/PRIVACY.md).
> Source code: https://github.com/MaiToxx/BetterIntraRemake. This package is
> built with `npm run build:chrome-store` (output: dist-chrome-store/).

Optional: a 2-3 minute unlisted walkthrough video, with its link added to
the text above (*Walkthrough video: <link>*). Film only your own profile:
install, open profile-v3.intra.42.fr, the hub (settings and search), logtime,
a profile customisation, then *Sign in with 42* with the disclosure line
visible, and the signed-in *Account Status* card. Leave out the cluster map, the friends
list and other students' profiles, or blur them: they show other students'
names, logins and photos.

## 2. API credentials (one-time)

Follow https://github.com/fregante/chrome-webstore-upload-keys (5 minutes):
it walks through creating a Google Cloud project, enabling the *Chrome Web
Store API*, creating an OAuth client and obtaining a **refresh token**. Set
the OAuth consent screen's publishing status to *In production*: a refresh
token issued while it is *Testing* expires after 7 days.

## 3. Repository secrets

In the GitHub repository → *Settings* → *Secrets and variables* → *Actions*:

| Secret               | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `CWS_EXTENSION_ID`   | the extension id from the developer dashboard                      |
| `CWS_PUBLISHER_ID`   | the publisher id, in the dashboard's account settings (not the extension id) |
| `CWS_CLIENT_ID`      | OAuth client id                                                    |
| `CWS_CLIENT_SECRET`  | OAuth client secret                                                |
| `CWS_REFRESH_TOKEN`  | refresh token                                                      |

Until all five exist, the release workflow skips the store upload (with a
warning when the extension id is set but the publisher id is not); it still
builds the store package and attaches it for an upload by hand.

Check the credentials once before the first release that uses them, with a
store zip whose version is above the store's current one (built as in step
1). `upload` only uploads, it does not submit anything:

```bash
EXTENSION_ID=… PUBLISHER_ID=… CLIENT_ID=… CLIENT_SECRET=… REFRESH_TOKEN=… \
  npx chrome-webstore-upload-cli@4.0.1 upload --source web-ext-artifacts/better-intra-chrome-store.zip
```

## What a release does then

Publishing a GitHub release runs `.github/workflows/publish.yaml`, in this
order:

1. the release tag must name `package.json`'s version, then the release gate
   (`npm run release:check`: tests, theme and cycle checks, both builds, size
   budgets, the Chrome smoke test);
2. the Chrome zip and `.crx` are attached to the release;
3. the store package is built from the tag, kept as a run artifact and
   attached as `chrome-web-store-upload.zip`;
4. `updates.xml` is updated (Linux `.crx` installs);
5. with the five secrets, the store package is uploaded and submitted for
   review (`chrome-webstore-upload-cli` 4, Chrome Web Store API v2; the v1.1
   API it replaces stops on 15 October 2026);
6. last, the Firefox build goes to Mozilla for signing; once signed, the
   `.xpi` is attached and `updates.json` updated. When Mozilla takes longer
   than the run waits, `finish-release.yaml` does both later.

Each version still goes through Google's review before it reaches users,
usually within a day; Chrome then installs it by itself within a few hours.

The store steps are allowed to fail: the store refuses an upload while the
previous version is still in review, and that must not hold back Firefox and
Linux updates. A failure leaves a warning on the workflow run. That version
then reaches the store with the next release, or upload
`chrome-web-store-upload.zip` from the release by hand in the dashboard.

## Firefox

Nothing to do: the signed `.xpi` and `updates.json` are already automatic.
Firefox checks once a day; *about:addons* → gear → *Check for Updates*
forces it.
