import { describe, it, expect } from "vitest";
import {
  BACKUP_EXCLUDED_KEYS,
  exportableSettings,
  sanitizeBackup,
} from "../src/features/hub/backup";
import { CONFIG_DEFAULT } from "../src/core/config";

describe("exportableSettings", () => {
  it("drops credentials and caches, keeps regular settings", () => {
    const out = exportableSettings({
      LOGTIME_GOAL_HOURS: 120,
      CLOUD_TOKEN: "secret",
      CLOUD_LOGIN: "me",
      CALENDAR_SYNC_TOKEN: "cal-secret",
      FRIENDS_DATA_CACHE: { data: [], timestamp: 1 },
      NOT_A_SETTING: "x",
    });
    expect(out).toEqual({ LOGTIME_GOAL_HOURS: 120 });
  });

  it("excludes every key listed in BACKUP_EXCLUDED_KEYS", () => {
    const items: Record<string, unknown> = {};
    for (const key of BACKUP_EXCLUDED_KEYS) items[key] = "value";
    expect(exportableSettings(items)).toEqual({});
  });
});

describe("sanitizeBackup", () => {
  it("throws on non-object payloads", () => {
    expect(() => sanitizeBackup(null)).toThrow();
    expect(() => sanitizeBackup([1, 2])).toThrow();
    expect(() => sanitizeBackup("x")).toThrow();
  });

  it("does not carry this device's consents and push policy", () => {
    // someone else's file turned automatic pushes and subject sharing back on
    const out = sanitizeBackup({
      CLOUD_SYNC_ENABLED: true,
      SUBJECT_TRACKER_ENABLED: true,
      SUBJECT_TRACKER_SEND_DATA: true,
      LOGTIME_EMOJI: "🍕",
    });
    expect(out).toEqual({ LOGTIME_EMOJI: "🍕" });
  });

  it("refuses to restore credentials from a backup file", () => {
    const out = sanitizeBackup({
      CLOUD_TOKEN: "attacker-token",
      CLOUD_LOGIN: "attacker",
      LOGTIME_EMOJI: "🍕",
      PENDING_SETTINGS_RESTORE: true,
    });
    expect(out).not.toHaveProperty("CLOUD_TOKEN");
    expect(out).not.toHaveProperty("CLOUD_LOGIN");
    expect(out).not.toHaveProperty("PENDING_SETTINGS_RESTORE");
    // an ordinary string setting next to them is still restored
    expect(out.LOGTIME_EMOJI).toBe("🍕");
  });

  it("drops values whose type does not match the default", () => {
    const out = sanitizeBackup({
      ACTIVE_SCRIPTS: {}, // must be an array
      LOGTIME_GOAL_HOURS: "140", // must be a number
      FRIENDS_LIST: ["a", "b"],
      PROFILE_SHOW_MARKS: "true", // must be a boolean
      LOGTIME_EMOJI: "🍕",
    });
    expect(out).toEqual({ FRIENDS_LIST: ["a", "b"], LOGTIME_EMOJI: "🍕" });
  });

  it("accepts arrays stored as JSON strings by the UI", () => {
    // FRIENDS_LIST / SHORTCUTS_LINKS / ACTIVE_SCRIPTS are written with JSON.stringify
    const out = sanitizeBackup({
      FRIENDS_LIST: '["alice","bob"]',
      ACTIVE_SCRIPTS: '["logtime"]',
      SHORTCUTS_LINKS: '[{"name":"x","url":"https://x"}]',
      LOGTIME_EMOJI: "[not json",
    });
    expect(out.FRIENDS_LIST).toEqual(["alice", "bob"]);
    expect(out.ACTIVE_SCRIPTS).toEqual(["logtime"]);
    expect(out.SHORTCUTS_LINKS).toEqual([{ name: "x", url: "https://x" }]);
    // a string that merely starts with "[" but is not JSON stays a string
    expect(out.LOGTIME_EMOJI).toBe("[not json");
    // export parses them too, so the file contains real arrays
    expect(exportableSettings({ FRIENDS_LIST: '["a"]' })).toEqual({
      FRIENDS_LIST: ["a"],
    });
  });

  it("accepts null for nullable keys", () => {
    const out = sanitizeBackup({ ACCOUNT: null, LAST_CLOUD_SYNC: null });
    // both are excluded as session state, so nothing is restored
    expect(out).toEqual({});
  });

  it("round-trips a clean export", () => {
    const exported = exportableSettings({ ...CONFIG_DEFAULT });
    expect(sanitizeBackup(exported)).toEqual(exported);
  });
});

describe("sanitizeBackup, beyond the shape", () => {
  it("drops lists whose items have the wrong type (they used to make getConfig throw)", () => {
    const out = sanitizeBackup({
      PROFILE_CARD_ORDER: [1, 2],
      SHORTCUTS_LINKS: [1],
      FRIENDS_LIST: [42],
      LOGTIME_GOAL_HOURS: 120,
      PROFILE_IMAGE_HISTORY: ["https://a/b.png"],
    });
    expect(out).toEqual({ LOGTIME_GOAL_HOURS: 120, PROFILE_IMAGE_HISTORY: ["https://a/b.png"] });
  });

  it("keeps a select to its options, but not the lists only known at run time", () => {
    const out = sanitizeBackup({
      PROFILE_THEME_PRESET: "nope",
      LOGTIME_SHOW_DAYS_MODE: "date",
      CLUSTERS_DEFAULT_ID: "abc",
      PROFILE_EVENT_TYPE_FILTER: "x",
      CLUSTERS_CAMPUS: "62",
    });
    expect(out).toEqual({
      LOGTIME_SHOW_DAYS_MODE: "date",
      CLUSTERS_DEFAULT_ID: "abc",
      PROFILE_EVENT_TYPE_FILTER: "x",
      CLUSTERS_CAMPUS: "62",
    });
  });

  it("keeps a number within the bounds of its setting", () => {
    const out = sanitizeBackup({
      CUSTOM_FONT_SCALE: -3,
      CUSTOM_CARD_OPACITY: 60,
      LOGTIME_GOAL_HOURS: Number.POSITIVE_INFINITY,
    });
    expect(out).toEqual({ CUSTOM_CARD_OPACITY: 60 });
  });

  it("drops an image link that is not a plain http(s) URL, keeps 'no image'", () => {
    const out = sanitizeBackup({
      PROFILE_IMAGE_URL: "javascript:alert(1)",
      PROFILE_BANNER_URL: "data:image/png;base64,AAAA",
      PROFILE_BACKGROUND_URL: "",
      CUSTOM_PAGE_BG_URL: "https://images.example/bg.png",
    });
    expect(out).toEqual({
      PROFILE_BACKGROUND_URL: "",
      CUSTOM_PAGE_BG_URL: "https://images.example/bg.png",
    });
  });

  it("coerces the Customize keys present like a theme code, without filling the absent ones", () => {
    const out = sanitizeBackup({ CUSTOM_PAGE_BG_DIM: 40, CUSTOM_CARDS: { bogus: 1 } });
    expect(out.CUSTOM_PAGE_BG_DIM).toBe(40);
    expect(out.CUSTOM_CARDS).toEqual({});
    expect(out).not.toHaveProperty("CUSTOM_ACCENT_COLOR");
  });
});

describe("backup file shape", () => {
  it("wraps the settings with the version and the date, and reads both shapes back", async () => {
    const { unwrapBackup, wrapBackup } = await import("../src/features/hub/backup");
    const settings = exportableSettings({ LOGTIME_GOAL_HOURS: 120 });
    const file = wrapBackup(settings, "1.13.0", new Date("2026-09-22T10:00:00.000Z"));
    expect(file).toEqual({
      version: "1.13.0",
      exportedAt: "2026-09-22T10:00:00.000Z",
      settings: { LOGTIME_GOAL_HOURS: 120 },
    });
    expect(unwrapBackup(JSON.parse(JSON.stringify(file)))).toEqual(file);
    // the bare key -> value files of the earlier versions
    expect(unwrapBackup({ LOGTIME_GOAL_HOURS: 120 })).toEqual({
      settings: { LOGTIME_GOAL_HOURS: 120 },
    });
    expect(() => unwrapBackup([])).toThrow();
  });

  it("round-trips a wrapped export of the defaults", async () => {
    const { unwrapBackup, wrapBackup } = await import("../src/features/hub/backup");
    const exported = exportableSettings({ ...CONFIG_DEFAULT });
    const back = unwrapBackup(wrapBackup(exported, "x"));
    expect(sanitizeBackup(back.settings)).toEqual(exported);
  });
});

describe("backupSensitiveKeys", () => {
  it("lists custom CSS and the public profile fields that hold something", async () => {
    const { backupSensitiveKeys } = await import("../src/features/hub/backup");
    expect(
      backupSensitiveKeys({
        CUSTOM_CSS: "body{}",
        PROFILE_PUB_BIO: "hi",
        PROFILE_PUB_STATUS_TEXT: "  ",
        PROFILE_PUB_ENABLED: true,
        PROFILE_PUB_CARD_GLOW: true,
        LOGTIME_GOAL_HOURS: 1,
      }).sort(),
    ).toEqual(["CUSTOM_CSS", "PROFILE_PUB_BIO", "PROFILE_PUB_CARD_GLOW"]);
    expect(backupSensitiveKeys({ CUSTOM_CSS: "", PROFILE_PUB_BIO: "" })).toEqual([]);
  });
});
