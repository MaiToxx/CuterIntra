/**
 * The workflows hold the signing credentials and a write token: every action
 * they run is pinned to a commit, not to a tag its owner can move, and the
 * release drafter never pastes a commit subject into a script.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { installedFirefox, stepExitCode } from "../scripts/smoke-firefox.mjs";

const DIR = path.resolve(__dirname, "../.github/workflows");
const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");

describe("workflows", () => {
  it("pin every action to a full commit SHA, with the version in a comment", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const uses = read(f).split(/\r?\n/).filter((l) => /^\s*(- )?uses:/.test(l));
      for (const line of uses) {
        expect(line, `${f}: ${line.trim()}`).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/);
      }
    }
  });

  it("run on a fixed Node major", () => {
    for (const f of files) expect(read(f), f).not.toContain("lts/*");
  });

  it("the release drafter reads commit subjects from the environment, on pushes only", () => {
    const drafter = read("release-drafter.yaml");
    expect(drafter).not.toMatch(/^\s*pull_request/m);
    // no expression inside a run: script
    const scripts = drafter.split(/\n\s+run: \|\n/).slice(1).map((s) => s.split(/\n {6}- /)[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
  });

  it("publish.yaml signs only a commit that is on main, before installing anything", () => {
    const publish = read("publish.yaml");
    const check = publish.indexOf('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(publish.indexOf("run: npm ci", check - 2000 < 0 ? 0 : check));
  });
});

describe("smoke-firefox step", () => {
  it("passes when there is no Firefox, and reports every other outcome as it is", () => {
    expect(stepExitCode(3)).toBe(0);
    expect(stepExitCode(0)).toBe(0);
    expect(stepExitCode(1)).toBe(1);
    expect(stepExitCode(2)).toBe(2);
    expect(stepExitCode(null)).toBe(2);
  });

  it("leaves FIREFOX_BIN to the harness and otherwise takes the installed Firefox", () => {
    const none = () => false;
    expect(installedFirefox({ FIREFOX_BIN: "/x/firefox" }, ["/a"], () => true)).toBeNull();
    expect(installedFirefox({}, ["/a", "/b"], (p: string) => p === "/b")).toBe("/b");
    expect(installedFirefox({}, ["/a"], none)).toBeNull();
  });
});
