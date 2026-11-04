import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isNewerVersion,
  parseLatestRelease,
} from "../src/core/update-check";

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.8.10", "1.8.9")).toBeGreaterThan(0);
    expect(compareVersions("1.8.6", "1.8.6")).toBe(0);
    expect(compareVersions("v1.9.0", "1.8.6")).toBeGreaterThan(0);
    expect(compareVersions("1.8", "1.8.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("isNewerVersion is strict", () => {
    expect(isNewerVersion("1.8.7", "1.8.6")).toBe(true);
    expect(isNewerVersion("1.8.6", "1.8.6")).toBe(false);
    expect(isNewerVersion("1.8.5", "1.8.6")).toBe(false);
  });
});

describe("parseLatestRelease", () => {
  it("extracts the version and page url from a GitHub release", () => {
    expect(
      parseLatestRelease({
        tag_name: "v1.8.7",
        html_url: "https://github.com/o/r/releases/tag/v1.8.7",
        draft: false,
      }),
    ).toEqual({
      version: "1.8.7",
      url: "https://github.com/o/r/releases/tag/v1.8.7",
    });
  });

  it("ignores a release whose build files are not attached yet", () => {
    const base = { tag_name: "v1.8.21", html_url: "https://github.com/o/r/releases/tag/v1.8.21" };
    expect(parseLatestRelease({ ...base, assets: [] })).toBeNull();
    expect(parseLatestRelease({ ...base, assets: [{ name: "sources.zip" }] })).toBeNull();
    expect(parseLatestRelease({ ...base, assets: [{ name: "better-intra.xpi" }] })?.version).toBe("1.8.21");
    // no assets field at all (older API shape): accept
    expect(parseLatestRelease(base)?.version).toBe("1.8.21");
  });

  it("rejects drafts, odd tags and non-GitHub urls", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(
      parseLatestRelease({ tag_name: "v1.8.7", html_url: "https://x", draft: true }),
    ).toBeNull();
    expect(
      parseLatestRelease({ tag_name: "nightly", html_url: "https://github.com/o/r" }),
    ).toBeNull();
    expect(
      parseLatestRelease({ tag_name: "v1.8.7", html_url: "https://evil.example/" }),
    ).toBeNull();
  });
});

describe("a release is announced once its browser's file is attached", () => {
  const release = (names: string[]) => ({
    tag_name: "v9.9.9",
    html_url: "https://github.com/MaiToxx/CuterIntra/releases/tag/v9.9.9",
    assets: names.map((name) => ({ name })),
  });

  it("Firefox waits for the signed .xpi, Chrome only needs its zip or crx", async () => {
    const { parseLatestRelease, RELEASE_ASSET_FIREFOX, RELEASE_ASSET_CHROME } = await import(
      "../src/core/update-check"
    );
    const chromeOnly = release(["better-intra-chrome.zip", "better-intra.crx"]);
    expect(parseLatestRelease(chromeOnly, RELEASE_ASSET_FIREFOX)).toBeNull();
    expect(parseLatestRelease(chromeOnly, RELEASE_ASSET_CHROME)?.version).toBe("9.9.9");
    const both = release(["better-intra-chrome.zip", "better-intra.crx", "better-intra.xpi"]);
    expect(parseLatestRelease(both, RELEASE_ASSET_FIREFOX)?.version).toBe("9.9.9");
    expect(parseLatestRelease(release([]), RELEASE_ASSET_CHROME)).toBeNull();
    // the default still accepts any of them
    expect(parseLatestRelease(chromeOnly)?.version).toBe("9.9.9");
  });
});
