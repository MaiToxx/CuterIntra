/**
 * The release workflow (.github/workflows/publish.yaml), read as text: a
 * release must be tested before it is signed, the Chrome Web Store step must
 * use the API that still exists and must never hold back the Firefox and
 * Linux update manifests, and nothing that holds a signing key or a store
 * token may run a moving version.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RELEASE_ASSET_ANY, RELEASE_ASSET_CHROME, RELEASE_ASSET_FIREFOX } from "../src/core/update-check";

const ROOT = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/publish.yaml"), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

type Step = { name: string; text: string };

/** The text of one job (between its `  <id>:` line and the next job). */
function job(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  if (start < 0) throw new Error(`job ${id} not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The steps of a job, in order: each `      - ` item with its name. */
function steps(id: string): Step[] {
  const body = job(id).split("\n    steps:\n")[1] ?? "";
  return body
    .split(/\n(?= {6}- )/)
    .filter((s) => s.trimStart().startsWith("- "))
    .map((text) => ({ name: /name: (.+)/.exec(text)?.[1].trim() ?? "", text }));
}

function indexOf(list: Step[], name: string): number {
  const i = list.findIndex((s) => s.name === name);
  if (i < 0) throw new Error(`step "${name}" not found`);
  return i;
}

/** The first step that ships something: a signed file, a release file, a store upload, a manifest push. */
const RISKY = /crx@|cmd: sign|action-gh-release|chrome-webstore-upload|git push|push-update-manifest/;

/** The commands of an npm script chained with &&, in order. */
const chain = (script: string): string[] => String(pkg.scripts[script] ?? "").split(/\s*&&\s*/);

describe("publish.yaml: release gate", () => {
  it("release:check chains every check, both builds before the budgets, and the Chrome smoke test", () => {
    const cmds = chain("release:check");
    const at = (cmd: string) => cmds.findIndex((c) => c.startsWith(cmd));
    for (const cmd of ["npm test", "npm run check:themes", "npm run check:cycles", "npm run build:firefox", "npm run build:chrome", "npm run check:size"]) {
      expect(at(cmd), cmd).toBeGreaterThan(-1);
    }
    // the size budgets hold both builds to the same numbers
    expect(at("npm run check:size")).toBeGreaterThan(at("npm run build:firefox"));
    expect(at("npm run check:size")).toBeGreaterThan(at("npm run build:chrome"));
    // the only browser test: in the gate, after the Chrome build, and with no
    // exception for any exit code (a crash or a runner without Chrome fails)
    const smoke = at("node scripts/firefox-smoke.mjs dist-chrome --browser chrome");
    expect(smoke).toBeGreaterThan(at("npm run build:chrome"));
    expect(String(pkg.scripts["release:check"])).not.toMatch(/\|\||;|exit 0/);
  });

  for (const id of ["build-prerelease", "build-and-sign"]) {
    it(`${id}: the tag check and the whole release gate run before anything is signed or uploaded`, () => {
      const list = steps(id);
      const firstRisky = list.findIndex((s) => RISKY.test(s.text));
      expect(firstRisky).toBeGreaterThan(0);
      const tag = list.findIndex((s) => s.text.includes("node scripts/check-release-tag.mjs"));
      const gate = list.findIndex((s) => s.text.includes("run: npm run release:check"));
      expect(tag).toBeGreaterThan(-1);
      expect(gate).toBeGreaterThan(tag);
      expect(gate).toBeLessThan(firstRisky);
      // the gate is one step with no escape hatch
      expect(list[gate].text).not.toContain("continue-on-error");
      expect(list[tag].text).not.toContain("continue-on-error");
    });
  }

  it("the tag must equal v<package.json version>; only a prerelease may add a suffix", () => {
    const strict = steps("build-and-sign").find((s) => s.text.includes("check-release-tag.mjs"))!;
    expect(strict.text).toContain('check-release-tag.mjs "$RELEASE_TAG"');
    expect(strict.text).not.toContain("--prerelease");
    const pre = steps("build-prerelease").find((s) => s.text.includes("check-release-tag.mjs"))!;
    expect(pre.text).toContain("--prerelease");
  });

  it("pins what it runs: no action on a branch, exact versions for npx tools", () => {
    expect(workflow).not.toMatch(/uses: \S+@(main|master)\b/);
    for (const m of workflow.matchAll(/npx --yes (\S+)/g)) {
      expect(m[1], m[1]).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  it("pushes the update manifests through the retrying script, never with a bare git push", () => {
    const list = steps("build-and-sign");
    expect(list[indexOf(list, "Update Chrome auto-update manifest")].text).toContain(
      'node scripts/push-update-manifest.mjs updates.xml "$RELEASE_TAG"',
    );
    expect(list[indexOf(list, "Update Firefox auto-update manifest")].text).toContain(
      'node scripts/push-update-manifest.mjs updates.json "$RELEASE_TAG"',
    );
    expect(workflow).not.toContain("git push");
  });
});

describe("publish.yaml: Chrome Web Store", () => {
  const list = steps("build-and-sign");
  const publish = list[indexOf(list, "Publish to Chrome Web Store")];
  const build = list[indexOf(list, "Build Extension (Chrome Web Store)")];
  const keep = list[indexOf(list, "Keep the Chrome Web Store package")];
  const attach = list[indexOf(list, "Attach the Chrome Web Store package to the release")];
  const STORE_ZIP = "chrome-web-store-upload.zip";

  it("the upload needs all five secrets, the publisher id included, and stays skipped without them", () => {
    const hasCws = /HAS_CWS: \$\{\{(.+)\}\}/.exec(job("build-and-sign"))?.[1] ?? "";
    for (const secret of ["CWS_EXTENSION_ID", "CWS_PUBLISHER_ID", "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"]) {
      expect(hasCws).toContain(`secrets.${secret} != ''`);
    }
    expect(hasCws).not.toContain("||");
    expect(publish.text).toContain("env.HAS_CWS == 'true'");
  });

  it("builds the store package on every release, secrets or not, and keeps it twice", () => {
    // store uploads used to be built by hand from a working folder
    expect(build.text).not.toContain("HAS_CWS");
    // Linux zip: forward slashes (Compress-Archive wrote backslash paths)
    expect(build.text).toContain(`zip -qr ../${STORE_ZIP} .`);
    expect(keep.text).toContain("uses: actions/upload-artifact@");
    expect(keep.text).toContain(`path: ${STORE_ZIP}`);
    expect(keep.text).toContain("archive: false");
    expect(keep.text).toMatch(/retention-days: \d+/);
    // a rerun of the job keeps it again instead of failing on the taken name
    expect(keep.text).toContain("overwrite: true");
    expect(attach.text).toContain("uses: softprops/action-gh-release@");
    expect(attach.text).toContain(`files: ${STORE_ZIP}`);
    for (const s of [build, keep, attach]) expect(s.text, s.name).toContain("continue-on-error: true");
    for (const s of [keep, attach]) expect(s.text, s.name).toContain("steps.cws-build.outcome == 'success'");
  });

  it("attaches it under a name neither students nor the update check take for an installable file", () => {
    // RELEASE_ASSET_CHROME decides whether a GitHub Chrome install is told
    // about a release: the store build has no update check, so a release
    // carrying only it, or a student installing it, would never hear of the
    // next version.
    expect(RELEASE_ASSET_CHROME.test("better-intra-chrome.zip")).toBe(true);
    for (const re of [RELEASE_ASSET_CHROME, RELEASE_ASSET_ANY, RELEASE_ASSET_FIREFOX]) {
      expect(re.test(STORE_ZIP), String(re)).toBe(false);
    }
    // the file the finisher looks for is not the store package either
    expect(STORE_ZIP).not.toBe("better-intra-chrome.zip");
  });

  it("uploads and submits through chrome-webstore-upload-cli 4 (API v2), with no subcommand", () => {
    const run = /run: (.+)/.exec(publish.text)?.[1] ?? "";
    expect(run).toMatch(/^npx --yes chrome-webstore-upload-cli@4\.\d+\.\d+ --source chrome-web-store-upload\.zip$/);
    // v4: `upload` never publishes, --auto-publish is gone
    expect(run).not.toMatch(/\bupload --|--auto-publish/);
    expect(publish.text).toContain("PUBLISHER_ID: ${{ secrets.CWS_PUBLISHER_ID }}");
  });

  it("a store failure cannot hold back updates.json/updates.xml, and still leaves a warning", () => {
    const chromeManifest = indexOf(list, "Update Chrome auto-update manifest");
    const firefoxManifest = indexOf(list, "Update Firefox auto-update manifest");
    const buildAt = indexOf(list, "Build Extension (Chrome Web Store)");
    // built from the release tag, before any step checks out main
    expect(buildAt).toBeLessThan(chromeManifest);
    expect(indexOf(list, "Keep the Chrome Web Store package")).toBeLessThan(chromeManifest);
    expect(indexOf(list, "Publish to Chrome Web Store")).toBeGreaterThan(chromeManifest);
    expect(publish.text).toContain("continue-on-error: true");
    // Mozilla's approval (up to an hour) comes after everything Chrome needs
    const sign = indexOf(list, "web-ext sign (Firefox)");
    expect(sign).toBeGreaterThan(indexOf(list, "Upload Chrome files to GitHub Release"));
    expect(sign).toBeGreaterThan(chromeManifest);
    expect(sign).toBeGreaterThan(indexOf(list, "Publish to Chrome Web Store"));
    expect(firefoxManifest).toBeGreaterThan(indexOf(list, "Upload Firefox file to GitHub Release"));
    // sources are archived from the release tag, before main is checked out
    expect(indexOf(list, "Collect source code")).toBeLessThan(chromeManifest);
    const warn = list[indexOf(list, "Chrome Web Store step failed")];
    for (const id of ["cws-build", "cws-keep", "cws-attach", "cws"]) {
      expect(warn.text).toContain(`steps.${id}.outcome == 'failure'`);
    }
    expect(warn.text).toContain("::warning::");
    // it no longer claims updates.json went out: that waits for Mozilla
    expect(warn.text).not.toContain("updates.json/updates.xml were updated anyway");
  });
});

describe("publish.yaml: a submission Mozilla never accepted turns the run red", () => {
  const list = steps("build-and-sign");
  const last = list[list.length - 1];

  it("asks AMO last, only when web-ext sign did not end signed, and fails on 'missing', 'refused' or an error", () => {
    expect(last.name).toBe("Firefox submission reached Mozilla");
    expect(last.text).toContain("if: env.HAS_AMO == 'true' && steps.web-ext-sign.outcome != 'success'");
    expect(last.text).toContain('node scripts/amo-signed-xpi.mjs "$VERSION" /dev/null');
    // signed meanwhile (a rerun) or held for review: a notice each, never a failure
    expect(last.text).toMatch(/\n\s+0\) echo "::notice::Mozilla has signed/);
    expect(last.text).toMatch(/\n\s+3\) echo "::notice::/);
    expect(last.text).toMatch(/2\) echo "::error::[^\n]*exit 1/);
    expect(last.text).toMatch(/4\) echo "::error::[^\n]*exit 1/);
    expect(last.text).toMatch(/\*\) echo "::error::[^\n]*exit 1/);
    expect(last.text).not.toContain("continue-on-error");
  });

  it("no earlier step says the version is waiting for review before AMO was asked", () => {
    const before = list.slice(0, -1).map((s) => s.text).join("\n");
    expect(before).not.toContain("Mozilla has not approved this version yet");
  });
});
