# Performance

What Cuter Intra costs on an Intra page, what it gives back, and how to keep
the numbers from creeping up.

## What it costs today

Measured on the minified v1.12.0 build (`npm run measure`, `dist-firefox`;
`dist-chrome` is the same output with a different manifest):

| file                 |      raw |     gzip | loaded                                   |
| -------------------- | -------: | -------: | ---------------------------------------- |
| `content.js`         | 575.8 KB | 173.1 KB | on every `*.intra.42.fr` page            |
| `shared-styles.css`  | 128.4 KB |  20.0 KB | once, then served from cache             |
| `theme-dark-v2.css`  |  62.4 KB |  10.4 KB | only on the old v2 Intra                 |
| `popup.js`           |  39.9 KB |  13.1 KB | when the popup opens                     |
| `shared-themes.css`  |  37.5 KB |   6.1 KB | only with a preset other than light/dark |
| `theme-dark-v3.css`  |  12.3 KB |   2.1 KB | with the dark theme on v3                |
| `theme-light-v3.css` |  10.0 KB |   1.6 KB | with a light theme preset                |
| `auth-callback.js`   |   9.8 KB |   4.3 KB | oauth builds only, on the callback page  |
| `hook.js`            |   4.2 KB |   1.4 KB | in the page's own world, at document_start |
| `background.js`      |   2.7 KB |   1.3 KB | once per browser session                 |

Raw is the number that matters. An extension file is read from disk, never
downloaded, so nothing un-gzips it: what the browser pays on an Intra page load
is parsing `content.js`.

### Unreleased

- **The milestone ring no longer runs a script per frame.** The dashboard's
  current milestone had a `requestAnimationFrame` loop writing `--angle` on
  every frame for as long as the tab was open: 3,750 wake-ups a minute, none
  of them in the table above, so the real dashboard figure was about eight
  times the 465 measured. The ring is now a CSS animation on a registered
  `@property`, stopped by `prefers-reduced-motion` and by Disable animations
  (`tests/timers.test.ts`, row "milestones: ring angle": 3,750 -> 0).
- **The profile-card stylesheet stays put.** It was removed and re-inserted on
  every profile pass, which invalidated the styles of the whole document each
  time (`tests/runtime-perf.test.ts`).
- **Profile stats read the v2 pages three at a time** and the history page
  together with the first feedback page, instead of up to 16 pages one after
  the other; the walk stops at the first empty page. Writing that cache no
  longer copies the whole storage area into the tab: the cleanup of the keys
  older builds left runs in the background, once per update.
- **One GitHub request per six hours**, conditional (`If-None-Match`), stored
  with its time; the popup and the hub read the stored result and make no
  request of their own. The About tab no longer fetches the star and follower
  counts from `api.github.com`.

### What changed in 1.12.0

`content.js` grew by 19 KB (556.5 to 575.8 KB) with this release's fixes:
accessible names and keyboard handling in the hub and on the profile, the
friends widget's failure states, the stale-if-error caches and the cleanup
after an add-on update. Measured with the Firefox harness against 1.11.1
(`npm run smoke:firefox -- --compare`, 3 cold and 10 warm loads each), the
app's first writes and the hub's opening times did not move (every median
within 1 ms on warm loads).

### What changed in 1.11.0

| | v1.10.0 | v1.11.0 |
| --- | ---: | ---: |
| `content.js` | 606.7 KB | 556.5 KB |
| Tailwind CSS parsed on a default-theme page | 300.7 KB | 127.4 KB |
| storage reads before the profile page is usable | about 50 | 1 |
| timer wake-ups per minute, tab visible / in background | 726 / 395 | 465 / 66 |

- **Settings snapshot.** Every `getConfig` used to be one round trip to the extension process. Each context (page, popup, service worker) now loads the settings once and keeps them exact through `storage.onChanged` and a write-through on its own writes. `src/core/config/snapshot.ts` explains the design and its fallback.
- **A leaner stylesheet.** Tailwind was scanning the whole repository (tests, docs, an agent skill file) and generating rules nothing uses; it scans `src/` only now. Eight daisyUI components nothing uses are out, and 33 duplicated theme blocks were collapsed. The 34 theme presets other than light and dark live in `shared-themes.css`, fetched only when one is picked. Checked in Chromium against the previous sheet on every theme: no computed value changed.
- **Dead code out.** Discord reminders, the students directory, worker image upload and the Outstanding star need a 42 API application this fork does not have; they were removed after checking the worker side.
- **No polling left.** Waits are observers with a deadline; clocks and countdowns pause while the tab is hidden. 1.13.0 removed the three loops that had survived: the perf sheet's hunt for the logtime root (20 x 500 ms on every page), the subject tracker's wait for its PDF link (40 x 150 ms on every project page) and the document_start avatar observer that watched every page for its lifetime.

### What changed in 1.10.0

| | v1.9.1 | v1.10.0 |
| --- | ---: | ---: |
| `content.js` | 968.9 KB | 606.7 KB |
| `popup.js` | 334.6 KB | 34.4 KB |
| Tailwind sheet parsed per page | 9 times (once per shadow root) | once |

The Tailwind + daisyUI sheet used to be a 300 KB string inside the JavaScript,
in **both** bundles, and it was concatenated into the `<style>` of every widget.
Each widget's text differed slightly, so the engine's identical-text cache
missed and it parsed those 300 KB again for every shadow root. Measured in
Chrome on nine roots: **54.4 ms** of style work, against **3.2 ms** when the
same sheet is a single constructable `CSSStyleSheet` shared by all of them.

It is now a real file (`shared-styles.css`) that the browser fetches once,
parses once and caches. `src/core/styles/shared-styles.ts` hands it out two ways, and
the difference matters:

- `adoptSharedStyles(root, extraCSS?)` — adopted sheets apply **after** a
  root's own `<style>`, so this is only for roots where the helper owns every
  stylesheet. The widget's own rules are adopted as a second sheet right after
  the shared one, which keeps the old order.
- `sharedStylesLink()` — a `<link>` rendered as the first node of a lit
  template, for roots that keep a `<style>` of their own. Tree order is
  preserved exactly.

Swapping one for the other on the wrong root silently changes which rules win.

## Where the bytes are

`npm run measure` lists the longest string literals in each bundle. After the
extraction, `content.js` has about 104 KB of literals across 23 strings: the
lit-html template texts of the widgets, the settings metadata and inline SVG.
No single one is over 16 KB. The rest is feature code.

The indentation of those templates does not ship: `scripts/collapse-lit-templates.ts` collapses the whitespace of every `html` template (except one with `<pre>`, `<textarea>` or a `white-space: pre*` value) and of every `css`-tagged stylesheet, and drops their CSS comments and the HTML comments of `html` templates (a comment that must ship, such as a licence notice, starts with `<!--!`; a template where a `${}` cuts a comment keeps all of its comments). In September 2026 two gaps in it cost about 6 KB of `content.js`: a template whose `<style>` said `white-space: nowrap` was skipped whole (the cluster map dialog), and in a CRLF file every line kept its newline.

## "Lighten the Intra" (Advanced tab)

These three settings are about the **Intra page**, not about this extension.
They cannot shrink `content.js`, which loads before any setting is read; what
they do is remove work the browser would otherwise do for the page itself. All
three are on by default and each can be turned off on its own.

- **Skip off-screen content** — `content-visibility: auto` on the repeated rows
  of the long cards (projects, achievements, logtime months), so
  the browser stops laying out and painting what is scrolled out of sight. On a
  synthetic page of 400 rows, 90 % of the body's elements sit inside a deferred
  block. Every target is inside a fixed-height `md:h-96` card with its own
  scrollbar, so a wrong size estimate can only move that card's scrollbar, never
  the page. Guarded by `@supports`, so Firefox before 125 simply skips it.
  The evaluation rows are left out on purpose: each hosts an inline
  `position: fixed` tooltip that containment would clip (1.12.1).
- **Pause when the tab is hidden** — stops the page's CSS animations and
  transitions while you are looking at another tab. It cannot pause an animated
  GIF; CSS has no say over those.
- **Connect early to the image server** — a `preconnect` to `cdn.intra.42.fr`,
  which saves the DNS, TCP and TLS round trips on the first avatar, typically
  100 to 300 ms on a cold connection.

There used to be a fourth, **Load images when needed**, which added
`loading="lazy"` to the page's images once they were in the document. It never
deferred a download: the browser decides lazy or eager when the request starts,
and React sets `src` on an image before inserting it, so the request is already
under way when any observer sees the element. Chrome 153 and Firefox 156
fetched every late image with and without it; the attribute only works when it
is set before `src`. It was removed in 1.14 together with its document-wide
observer and the layout read each pass cost. The stored key is kept and ignored.

The extension also does less itself than it used to: the profile pass ignores
bursts of DOM changes that only contain its own writes, the polling timers are
gone (about 260 timer wake-ups per page load replaced by five observers and four
one-shot deadlines), and the start-up path makes roughly 24 fewer storage
round-trips.

## Measuring locally

```bash
npm run build:firefox   # or build:chrome; measure only reads built output
npm run measure         # per-file raw + gzip, and the biggest literals
npm run check:size      # same report, exits 1 if a file is over budget
```

With nothing built, `npm run measure` prints `nothing built, nothing checked`
and exits 0; `npm run check:size` prints the same line and exits **1**, because
"I could not look" must never read as "it passed".

The literal scan does not parse JavaScript — it jumps from quote to matching
quote and drops overlaps. It is a map of what fills a bundle, not an accounting
statement; the sizes it prints will not add up to the file exactly.

## The budget rule

`scripts/measure-bundle.js` holds one `BUDGETS_KB` constant: a ceiling per built
file, including the stylesheets. CI runs `npm run check:size` after both builds,
so a pull request that pushes a file past its ceiling goes red.

A budget is a tripwire, not a target. Raising one is allowed and sometimes right
— but only in the same commit as the feature that needs the room, with the
reason in the commit message. Never raise a budget to make CI green.
