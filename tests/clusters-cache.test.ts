/**
 * The cluster SVG cache in chrome.storage.local is bounded: Chrome caps the
 * whole extension at 10 MB and a map weighs a few hundred KB, so browsing the
 * campus selector used to fill it for good and make every later settings
 * write fail, silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCachedCluster,
  setCachedCluster,
  SVG_CACHE_MAX_ENTRIES,
} from "../src/features/clusters/map-dialog/cache";
import { warnOnQuota } from "../src/features/clusters/map-dialog/map-load";

const DAY = 24 * 60 * 60 * 1000;

async function seed(campus: string, cluster: string, ageMs: number) {
  await chrome.storage.local.set({
    [`cluster_svg_${campus}_${cluster}`]: JSON.stringify({
      svg: "<svg/>",
      seats: [],
      viewBox: { w: 1, h: 1 },
      cachedAt: Date.now() - ageMs,
    }),
  });
}

const entry = () => ({ svg: "<svg/>", seats: [], viewBox: { w: 1, h: 1 }, cachedAt: 0 });

async function svgKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith("cluster_svg_")).sort();
}

beforeEach(async () => {
  await chrome.storage.local.clear();
});

describe("cluster SVG cache, bounded on write", () => {
  it("keeps at most SVG_CACHE_MAX_ENTRIES maps, dropping the oldest", async () => {
    for (let i = 0; i < SVG_CACHE_MAX_ENTRIES; i++) {
      // fresh but distinct ages, oldest first
      await seed("9", `c${i}`, (SVG_CACHE_MAX_ENTRIES - i) * 60_000);
    }
    await setCachedCluster("7", "k0", entry());
    const keys = await svgKeys();
    expect(keys).toHaveLength(SVG_CACHE_MAX_ENTRIES);
    expect(keys).toContain("cluster_svg_7_k0");
    expect(keys).not.toContain("cluster_svg_9_c0");
    expect(keys).toContain("cluster_svg_9_c1");
  });

  it("never evicts the campus being written, even beyond the cap", async () => {
    for (let i = 0; i < SVG_CACHE_MAX_ENTRIES + 3; i++) {
      await seed("7", `c${i}`, (i + 1) * 60_000);
    }
    await setCachedCluster("7", "k0", entry());
    expect(await svgKeys()).toHaveLength(SVG_CACHE_MAX_ENTRIES + 4);
  });

  it("removes another campus' expired maps but keeps this campus' as stale fallback", async () => {
    await seed("7", "old", 10 * DAY);
    await seed("9", "old", 10 * DAY);
    await seed("9", "fresh", DAY);
    await setCachedCluster("7", "k0", entry());
    expect(await svgKeys()).toEqual([
      "cluster_svg_7_k0",
      "cluster_svg_7_old",
      "cluster_svg_9_fresh",
    ]);
    // the expired own-campus map is still there for the worker-down path
    expect((await getCachedCluster("7", "old", { allowStale: true }))?.svg).toBe("<svg/>");
  });

  it("leaves every other storage key alone", async () => {
    await chrome.storage.local.set({
      CLUSTERS_CAMPUS: "7",
      FRIENDS_LIST: ["a"],
      CLUSTER_SVG_URLS_V1_7: { data: {}, cachedAt: 0 },
      CAMPUS_DATA_7: { data: {}, timestamp: 0 },
    });
    for (let i = 0; i < SVG_CACHE_MAX_ENTRIES + 2; i++) {
      await seed("9", `c${i}`, 10 * DAY);
    }
    await setCachedCluster("7", "k0", entry());
    const all = await chrome.storage.local.get(null);
    expect(all.CLUSTERS_CAMPUS).toBe("7");
    expect(all.FRIENDS_LIST).toEqual(["a"]);
    expect(all.CLUSTER_SVG_URLS_V1_7).toEqual({ data: {}, cachedAt: 0 });
    expect(all.CAMPUS_DATA_7).toEqual({ data: {}, timestamp: 0 });
  });

  it("reads the whole storage area once, then only its index of the maps", async () => {
    // get(null) copied every stored map, megabytes of SVG, into the tab on each write
    await seed("9", "old", 10 * DAY);
    await seed("9", "fresh", DAY);
    const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    const wholeReads = () => get.mock.calls.filter(([keys]) => keys === null || keys === undefined).length;

    get.mockClear();
    await setCachedCluster("7", "k0", entry());
    expect(wholeReads()).toBe(1);
    // the maps stored before the index existed are in it, and still swept
    expect(await svgKeys()).toEqual(["cluster_svg_7_k0", "cluster_svg_9_fresh"]);

    get.mockClear();
    await setCachedCluster("7", "k1", entry());
    await setCachedCluster("7", "k2", entry());
    expect(wholeReads()).toBe(0);
    const index = (await chrome.storage.local.get("CLUSTER_SVG_INDEX")).CLUSTER_SVG_INDEX;
    expect(Object.keys(index as object).sort()).toEqual([
      "cluster_svg_7_k0",
      "cluster_svg_7_k1",
      "cluster_svg_7_k2",
      "cluster_svg_9_fresh",
    ]);
  });

  it("still keeps to the cap once it works from the index", async () => {
    // one write a minute: the oldest are the ones to go
    vi.useFakeTimers({ now: Date.now() });
    const later = () => vi.advanceTimersByTime(60_000);
    await setCachedCluster("7", "k0", entry());
    for (let i = 0; i < SVG_CACHE_MAX_ENTRIES + 2; i++) {
      later();
      await setCachedCluster("9", `c${i}`, entry());
    }
    later();
    await setCachedCluster("8", "z", entry());
    vi.useRealTimers();
    const keys = await svgKeys();
    expect(keys).not.toContain("cluster_svg_7_k0");
    expect(keys).not.toContain("cluster_svg_9_c0");
    expect(keys).toHaveLength(SVG_CACHE_MAX_ENTRIES);
    expect(keys).toContain("cluster_svg_8_z");
  });

  it("still stores the map when the sweep itself fails", async () => {
    const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    get.mockRejectedValueOnce(new Error("boom"));
    await expect(setCachedCluster("7", "k0", entry())).resolves.toBeUndefined();
    expect(await svgKeys()).toEqual(["cluster_svg_7_k0"]);
  });
});

describe("a full storage is reported once", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns on a quota error and ignores anything else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnQuota(new Error("Network down"));
    expect(warn).not.toHaveBeenCalled();
    warnOnQuota(new Error("QUOTA_BYTES quota exceeded"));
    warnOnQuota(new Error("QUOTA_BYTES quota exceeded"));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
