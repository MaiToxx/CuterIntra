import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readRepoInfo, readWorkerUrl } from "../scripts/repo-info.js";
import { CLOUD_SYNC_KEYS } from "../src/core/config/keys";
import { exportableSettings } from "../src/features/hub/backup";
import { CONFIG_DEFAULT } from "../src/core/config";

/**
 * PRIVACY.md is what a student or a store reviewer reads before installing.
 * It drifted once into describing the upstream product; these checks tie it
 * to the manifests, package.json and the sync key list so it cannot again.
 */
const ROOT = path.resolve(__dirname, "..");
const privacy = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
const listing = fs.readFileSync(path.join(ROOT, "CHROME_LISTING.md"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const repo = readRepoInfo();
const workerHost = new URL(readWorkerUrl()).host;
const src = (file: string) => fs.readFileSync(path.join(ROOT, "src", file), "utf8");

/** The sentence of PRIVACY.md that starts with `start`, up to its full stop. */
function sentence(start: string): string {
  const at = privacy.indexOf(start);
  expect(at, `PRIVACY.md: "${start}"`).toBeGreaterThan(-1);
  return privacy.slice(at, privacy.indexOf(".", at) + 1);
}

/** The line (a list item, a paragraph) of PRIVACY.md that starts with `start`. */
function line(start: string): string {
  const at = privacy.indexOf(start);
  expect(at, `PRIVACY.md: "${start}"`).toBeGreaterThan(-1);
  const end = privacy.indexOf("\n", at);
  return privacy.slice(at, end < 0 ? undefined : end);
}

const manifests = (["chrome", "firefox"] as const).map((t) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `manifests/manifest.${t}.json`), "utf8")),
);

describe("PRIVACY.md matches the build", () => {
  it("names every permission and every host permission of the manifests", () => {
    for (const m of manifests) {
      for (const p of m.permissions as string[]) expect(privacy).toContain(`\`${p}\``);
      for (const origin of m.host_permissions as string[]) {
        // The upstream worker origin is swapped for the fork's at build time.
        const host = origin.includes("api.betterintra.com") ? workerHost : new URL(origin.replace("*.", "")).host;
        expect(privacy).toContain(host);
      }
    }
  });

  it("mentions no host permission the manifests do not ask for", () => {
    const permitted = manifests.flatMap((m) => m.host_permissions as string[]);
    expect(permitted.some((p) => p.includes("github.com"))).toBe(false);
    expect(privacy).toMatch(/No permission is requested for `api\.github\.com`/);
  });

  it("describes the Intra-token sign-in, not the upstream OAuth and Discord flows", () => {
    expect(privacy).toContain("/auth/intra");
    expect(privacy).toMatch(/JWKS/);
    expect(privacy).not.toMatch(/Discord User ID|Evaluations Background Service|OAuth Authentication/);
  });

  it("says that the friends list and the calendar token travel with pushed settings", () => {
    expect(CLOUD_SYNC_KEYS).toContain("FRIENDS_LIST");
    expect(CLOUD_SYNC_KEYS).toContain("CALENDAR_SYNC_TOKEN");
    expect(privacy).toMatch(/\*\*friends list\*\*/);
    expect(privacy).toMatch(/\*\*calendar subscription token\*\*/);
  });

  it("points at this fork, and so do the listing and the README", () => {
    expect(privacy).toContain(`${repo.url}/issues`);
    expect(privacy).not.toContain("nicopasla/better-intra/issues");
    expect(listing).toContain(`${repo.url}/blob/main/PRIVACY.md`);
    // Upstream features this build does not ship (README, "Not available").
    // Outstanding counts are back since 1.20.0 (the worker's 42 application).
    expect(listing).not.toMatch(/Discord DM|Le Bassin|Belgium|Students directory/);
    expect(readme).not.toContain("Nothing leaves the browser until you connect");
  });

  it("lists the third parties the extension contacts on its own: shortcut icons", () => {
    const shortcuts = src("features/shortcuts/shortcuts.ui.ts");
    if (shortcuts.includes("/favicon.ico")) expect(privacy).toContain("/favicon.ico");
    if (shortcuts.includes("icons.duckduckgo.com")) expect(privacy).toContain("icons.duckduckgo.com");
  });

  it("does not describe the GitHub request the About tab no longer makes", () => {
    expect(src("features/hub/hub.about.ts")).not.toMatch(/fetch\([^)]*api\.github\.com/);
    expect(privacy).not.toMatch(/About tab[^.\n]*api\.github\.com/);
    expect(privacy).not.toMatch(/star and follower counts/);
  });

  it("says the Chrome Web Store build has no update check and no alarms permission", () => {
    expect(privacy).toMatch(/\*\*Update check\*\* \(not in the Chrome Web Store build/);
    expect(privacy).toMatch(/`alarms` — [^\n]*not in the Chrome Web Store build/);
    expect(privacy).toMatch(/`activeTab` \(Firefox only\)/);
  });

  // Each phrase the policy uses for a stored value, and its storage key.
  const PHRASE_KEYS: Array<[RegExp, string]> = [
    [/session token/, "CLOUD_TOKEN"],
    [/(detected campus|campus (the extension|it) detected)/, "CLUSTERS_CAMPUS"],
    [/easter eggs/, "EGGS_FOUND"],
    [/friends' data cache/, "FRIENDS_DATA_CACHE"],
    [/subject tracker's local state/, "SUBJECT_TRACKER_STATE"],
    [/subject tracker choices/, "SUBJECT_TRACKER_SEND_DATA"],
    [/Manual\/Auto push setting/, "CLOUD_SYNC_ENABLED"],
  ];
  const named = (text: string) => PHRASE_KEYS.filter(([re]) => re.test(text)).map(([, key]) => key);

  it("\"Never pushed\" names only keys that are not in CLOUD_SYNC_KEYS, and the pushed list names the ones that are", () => {
    const never = named(sentence("Never pushed:"));
    expect(never).toEqual(expect.arrayContaining(["CLOUD_TOKEN", "EGGS_FOUND", "FRIENDS_DATA_CACHE", "SUBJECT_TRACKER_STATE"]));
    for (const key of never) expect(CLOUD_SYNC_KEYS, key).not.toContain(key);
    // the other direction: a synced key the policy mentions is in the pushed list
    const item = line("- **Your settings**");
    const pushed = item.slice(0, item.indexOf("Never pushed:"));
    for (const key of named(pushed)) expect(CLOUD_SYNC_KEYS, key).toContain(key);
    if (CLOUD_SYNC_KEYS.includes("CLUSTERS_CAMPUS")) expect(named(pushed)).toContain("CLUSTERS_CAMPUS");
    if (CLOUD_SYNC_KEYS.includes("CALENDAR_EVENTS_HASH")) expect(pushed).toMatch(/hash of the last calendar pushed/);
  });

  it("what it says Backup leaves out is left out, and what it says Backup keeps is kept", () => {
    const all = Object.fromEntries(Object.keys(CONFIG_DEFAULT).map((k) => [k, (CONFIG_DEFAULT as Record<string, unknown>)[k]]));
    const exported = Object.keys(exportableSettings(all));
    // "None of these is exported by *Backup* or sent to the cloud."
    const localOnly = privacy.slice(0, privacy.indexOf("None of these is exported by *Backup*"));
    const notExported = named(localOnly.slice(localOnly.lastIndexOf("The extension also keeps")));
    expect(notExported).toContain("CLOUD_TOKEN");
    for (const key of notExported) {
      expect(exported, key).not.toContain(key);
      expect(CLOUD_SYNC_KEYS, key).not.toContain(key);
    }
    const kept = named(sentence("It therefore includes"));
    expect(kept.length).toBeGreaterThan(0);
    for (const key of kept) expect(exported, key).toContain(key);
    for (const key of ["CLOUD_TOKEN", "CALENDAR_SYNC_TOKEN", "FRIENDS_DATA_CACHE"]) expect(exported, key).not.toContain(key);
  });
});

describe("Firefox's data collection declaration matches PRIVACY.md and the store answers", () => {
  const firefox = manifests[1];
  const declared = firefox.browser_specific_settings?.gecko?.data_collection_permissions ?? {};
  const required: string[] = declared.required ?? [];
  const storeDoc = fs.readFileSync(path.join(ROOT, "docs/CHROME-WEB-STORE.md"), "utf8");
  // Firefox category -> the Chrome Web Store "Data usage" row it answers to
  const STORE_ROW: Record<string, string> = {
    personallyIdentifyingInfo: "Personally identifiable information",
    authenticationInfo: "Authentication information",
    locationInfo: "Location",
    browsingActivity: "Web history",
    websiteContent: "Website content",
    websiteActivity: "User activity",
    personalCommunications: "Personal communications",
    healthInfo: "Health information",
    financialAndPaymentInfo: "Financial and payment information",
  };
  /** The store row for a category, or "" when the table has none. */
  const storeRow = (label: string) => storeDoc.split("\n").find((l) => l.startsWith(`| ${label} |`)) ?? "";

  it("does not tell Firefox users that nothing leaves the browser while PRIVACY.md lists what does", () => {
    // "none" made Firefox's install prompt say the add-on collects no data
    // (upstream's value, never revisited) while the sign-in token and the
    // profile lookups below reach the worker.
    if (privacy.includes("/auth/intra") || privacy.includes("/api/v1/public/visuals")) {
      expect(required).not.toContain("none");
      expect(required.length).toBeGreaterThan(0);
    }
  });

  it("declares what the code sends: the sign-in token, the pages opened, the login and friends' logins, the pushed content", () => {
    expect(required).toEqual(
      expect.arrayContaining(["authenticationInfo", "browsingActivity", "personallyIdentifyingInfo", "websiteContent"]),
    );
  });

  it("every category is required: nothing in the code asks for an optional one", () => {
    // The signed-out profile lookup runs before any sign-in, and an optional
    // grant would need a permissions.request({ data_collection }) flow from
    // an extension page, which the extension does not have.
    expect(declared.optional).toBeUndefined();
    const sources = [src("popup/popup.ts"), src("features/account/handlers.ts"), src("background.ts")].join("\n");
    expect(sources).not.toMatch(/data_collection/);
  });

  it("each category is named in PRIVACY.md and answers a box ticked on the store form", () => {
    for (const category of required) {
      expect(privacy, category).toContain(`\`${category}\``);
      const label = STORE_ROW[category];
      expect(label, `${category} has no store row mapped`).toBeTruthy();
      const row = storeRow(label);
      expect(row, label).not.toBe("");
      expect(row, label).not.toMatch(/Not collected|unticked/);
    }
  });

  it("each box ticked on the store form has its category declared to Firefox", () => {
    // The other direction: the Chrome form ticked "Personally identifiable
    // information" (the login hash, the token carrying the login, friends'
    // logins) while Firefox's install prompt was left without it.
    const ticked = Object.entries(STORE_ROW).filter(([, label]) => {
      const row = storeRow(label);
      return row !== "" && !/Not collected|unticked/.test(row);
    });
    expect(ticked.length).toBeGreaterThan(0);
    for (const [category, label] of ticked) expect(required, `${label} is ticked for Chrome`).toContain(category);
  });
});

describe("PRIVACY.md names the Logtime values the public visuals route serves", () => {
  const settingsPath = path.join(ROOT, "../better-intra-worker/src/handlers/settings.ts");
  // The worker is a sibling repository: present on the maintainer's machine, not in CI.
  it.skipIf(!fs.existsSync(settingsPath))("lists each served value, and says the rate is private exactly when it is", () => {
    const worker = fs.readFileSync(settingsPath, "utf8");
    const block = /\n\s*logtime: \{([\s\S]*?)\n\s*\},/.exec(worker.slice(worker.indexOf("export function publicVisuals")))?.[1] ?? "";
    const served = [...block.matchAll(/settings\.(LOGTIME_\w+)/g)].map((m) => m[1]);
    expect(served.length).toBeGreaterThan(0);
    const item = line("- **Public visuals and look**");
    const PHRASE: Record<string, RegExp> = {
      LOGTIME_CALENDAR_COLOR: /calendar colour/,
      LOGTIME_LABELS_COLOR: /labels colour/,
      // the emoji itself, not only "emoji value" or "emoji count"
      LOGTIME_EMOJI: /\bemoji\b(?! value| count)/,
      LOGTIME_EMOJI_DIVISOR: /emoji value/,
      LOGTIME_RAINBOW_PALETTE: /rainbow colours/,
    };
    for (const key of served) {
      if (key === "LOGTIME_EMOJI_RATE") continue;
      expect(PHRASE[key], `${key}: add its phrase here and to PRIVACY.md`).toBeDefined();
      expect(item, key).toMatch(PHRASE[key]);
    }
    // The hub asks for the rate as an hourly pay: PRIVACY.md must say
    // whether it is public, and say it right.
    if (served.includes("LOGTIME_EMOJI_RATE")) expect(item).not.toMatch(/rate of the emoji count is not published/);
    else expect(item).toMatch(/rate of the emoji count is not published/);
  });
});

describe("PRIVACY.md says what the worker keeps, as the worker keeps it", () => {
  const WORKER = path.join(ROOT, "../better-intra-worker");
  const worker = (file: string) => fs.readFileSync(path.join(WORKER, file), "utf8");
  const has = (file: string) => fs.existsSync(path.join(WORKER, file));
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

  // Each D1 table the worker's migrations create, and the phrase of PRIVACY.md
  // that tells a student about it; null for a table that holds nothing about
  // anyone. A new table fails here until someone decides what the policy says.
  const TABLE_PHRASE: Record<string, RegExp | null> = {
    users: /\*\*A users row\*\*/,
    sessions: /\*\*Your sessions\*\*/,
    session_migrations: /a row saying your sessions were moved/,
    calendar_ics: /pushed as an `\.ics` file/,
    calendar_tokens: /revoked calendar links/,
    subjects: /\*\*Subject tracker\*\*/,
    projects: null, // project names a 42 application once filled; read by nothing
    kv_write_budget: /\*\*A daily write counter\.\*\*/,
    public_visuals: /copied to the worker's database \(D1\)/,
  };

  // The worker is a sibling repository: present on the maintainer's machine, not in CI.
  it.skipIf(!has("migrations"))("names every D1 table the worker's migrations create", () => {
    const sql = fs
      .readdirSync(path.join(WORKER, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => worker(`migrations/${f}`))
      .join("\n");
    // with or without IF NOT EXISTS, whatever the case: a table must not slip past by its spelling
    const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(Object.keys(TABLE_PHRASE), `${table}: add it to TABLE_PHRASE and to PRIVACY.md`).toContain(table);
      const phrase = TABLE_PHRASE[table];
      if (phrase) expect(privacy, table).toMatch(phrase);
    }
  });

  it.skipIf(!has("src/sessions.ts"))("gives the session cap and age limit the worker enforces, and says tokens are kept hashed", () => {
    const sessions = worker("src/sessions.ts");
    const max = Number(/MAX_SESSIONS = (\d+)/.exec(sessions)?.[1]);
    const days = Number(/SESSION_MAX_AGE_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(sessions)?.[1]);
    expect(max, "MAX_SESSIONS").toBeGreaterThan(0);
    expect(days, "SESSION_MAX_AGE_MS in days").toBeGreaterThan(0);
    const item = line("- **Your sessions**");
    expect(item).toMatch(new RegExp(`\\b(${max}|${NUMBER_WORDS[max] ?? max}) at most`, "i"));
    expect(item).toContain(`${days} days old`);
    expect(item).toMatch(/SHA-256 hash of the session token/);
    // the wording from when the record kept the tokens themselves
    expect(privacy).not.toMatch(/up to ten session tokens/);
    // Tokens copied from the old records get a fixed date, which decides when
    // they expire. The policy gives that date: a constant written any other
    // way must fail here, not skip the check.
    const legacy = /LEGACY_SESSION_CREATED_AT = Date\.UTC\((\d+), (\d+), (\d+)\)/.exec(sessions);
    if (sessions.includes("LEGACY_SESSION_CREATED_AT") || /\bdated \d/.test(item)) {
      expect(legacy, "LEGACY_SESSION_CREATED_AT = Date.UTC(y, m, d) in src/sessions.ts").not.toBeNull();
    }
    if (legacy) {
      const [, y, m, d] = legacy.map(Number);
      const day = (year: number) =>
        new Date(Date.UTC(year, m, d)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
      expect(item).toContain(`dated ${day(y)}`);
      expect(days, "the expiry date below assumes a one-year limit").toBe(365);
      expect(item).toContain(`expire on ${day(y + 1)} at the latest`);
    }
  });

  it.skipIf(!has("src/budget.ts"))("gives the daily write cap per account, how long the counter is kept and what its log line shows", () => {
    const budget = worker("src/budget.ts");
    const perLogin = Number(/DAILY_KV_WRITES_PER_LOGIN = (\d+)/.exec(budget)?.[1]);
    expect(perLogin, "DAILY_KV_WRITES_PER_LOGIN").toBeGreaterThan(0);
    const item = line("- **A daily write counter.**");
    expect(item).toContain(`Past ${perLogin} in a day`);
    // The first write of a day deletes the rows before yesterday: two days kept.
    expect(budget).toMatch(/WHERE day < \?[\s\S]{0,40}day - 1\b/);
    expect(item).toMatch(/deleted after two days/);
    const shown = /loginHash\.slice\(0, (\d+)\)/.exec(budget)?.[1];
    if (shown) expect(privacy).toContain(`first ${shown} characters of the login hash`);
    else expect(privacy).not.toMatch(/characters of the login hash/);
  });

  it.skipIf(!has("src/index.ts"))("describes the export exactly when the worker serves one, and it hands out no token", () => {
    const routed = worker("src/index.ts").includes('"/api/v1/private/export"');
    expect(privacy.includes("/api/v1/private/export")).toBe(routed);
    if (!routed) return;
    const item = line("- **A copy of your cloud data**");
    expect(item).toMatch(/never a token/);
    expect(item).toContain("`[redacted]`");
    const handler = worker("src/handlers/export.ts");
    expect(handler).toContain('"[redacted]"');
    // sessions leave by their short id, never by their hash or token
    expect(handler).toMatch(/tokenHash\.slice\(0, 8\)/);
  });

  it.skipIf(!has("src"))("keeps after a wipe exactly the bookkeeping rows it says stay, and deletes the public copy", () => {
    const code: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".ts")) code.push(fs.readFileSync(file, "utf8"));
      }
    };
    walk(path.join(WORKER, "src"));
    const workerSrc = code.join("\n");
    const wipe = line("- **Cloud data**");
    // "What stays": a DELETE on any of these tables would make the sentence false.
    expect(wipe).toMatch(/What stays: the revoked calendar links/);
    expect(workerSrc).not.toMatch(/DELETE FROM calendar_tokens/i);
    expect(wipe).toMatch(/a row saying your sessions were moved/);
    expect(workerSrc).not.toMatch(/DELETE FROM session_migrations/i);
    expect(wipe).toMatch(/the daily write counter \(two days at most\)/);
    const budgetDeletes = [...workerSrc.matchAll(/DELETE FROM kv_write_budget[^"`]*/gi)].map((m) => m[0]);
    expect(budgetDeletes, "only the prune of the days before yesterday").toEqual(["DELETE FROM kv_write_budget WHERE day < ?"]);
    // and the copy visitors are served goes with the rest
    expect(wipe).toMatch(/published visuals and look \(their database copy included\)/);
    expect(workerSrc).toMatch(/DELETE FROM public_visuals WHERE hash = \?/);
  });

  it("sends data requests to the export and the wipe before the public tracker", () => {
    const contact = privacy.slice(privacy.indexOf("## Contact"));
    expect(contact).toMatch(/the export above/);
    expect(contact).toMatch(/\*Wipe All Data\*/);
    expect(contact).toMatch(/issues are public, so leave your login and its hash out/);
  });
});

describe("the worker's logging matches the Server logs section", () => {
  const wranglerPath = path.join(ROOT, "../better-intra-worker/wrangler.json");
  // The worker is a sibling repository: present on the maintainer's machine, not in CI.
  it.skipIf(!fs.existsSync(wranglerPath))("does not promise per-request logs the worker has turned off", () => {
    const wrangler = JSON.parse(fs.readFileSync(wranglerPath, "utf8"));
    if (wrangler.observability?.logs?.invocation_logs === false) {
      expect(privacy).not.toMatch(/Every request is logged/);
      expect(privacy).toMatch(/invocation logs off/);
    }
  });

  // The other way round: a wrangler.json that turns the logs back on, or
  // traces (one record per request, query string included), would make the
  // policy's promise false while it still reads well.
  it.skipIf(!fs.existsSync(wranglerPath))("keeps per-request logs and traces off while the policy says so", () => {
    const wrangler = JSON.parse(fs.readFileSync(wranglerPath, "utf8"));
    if (!/invocation logs off/.test(privacy)) return;
    expect(wrangler.observability?.logs?.invocation_logs).toBe(false);
    expect(wrangler.observability?.traces?.enabled ?? false).toBe(false);
  });
});

describe("PRIVACY.md promises only the account tools the extension has", () => {
  const code = (dir: string): string =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) =>
        e.isDirectory() ? code(path.join(dir, e.name)) : e.name.endsWith(".ts") ? fs.readFileSync(path.join(dir, e.name), "utf8") : "",
      )
      .join("\n");
  const client = code(path.join(ROOT, "src"));

  it("lists the sessions and signs out the other browsers through the worker's sessions route", () => {
    const item = line("- **Your sessions**");
    expect(item).toMatch(/you can list your sessions/);
    expect(item).toMatch(/sign out every browser but the current one/);
    expect(client).toContain('"/api/v1/private/sessions"');
    expect(client).toMatch(/\?others=true/);
  });

  it("downloads the export it describes", () => {
    expect(line("- **A copy of your cloud data**")).toMatch(/the extension can download one JSON file/);
    expect(client).toContain('"/api/v1/private/export"');
  });
});

describe("CHROME_LISTING.md matches what the code does", () => {
  it("describes the subject tracker, which reports visited project pages when signed in", () => {
    expect(listing).toMatch(/Subject tracker/);
    expect(listing).toMatch(/Share with the community/);
  });

  it("gives the cluster map's real refresh period and no friends timer that does not exist", () => {
    const poll = /POLL_INTERVAL = (\d+)_?(\d*)/.exec(src("features/clusters/map-dialog/context.ts"));
    expect(Number(`${poll![1]}${poll![2]}`)).toBe(60_000);
    expect(listing).toMatch(/refresh every minute/);
    expect(listing).not.toMatch(/every 30 seconds|every 3 minutes/);
  });
});
