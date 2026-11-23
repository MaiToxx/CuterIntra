/**
 * The Firefox build in a real Firefox, as a step of `npm run release:check`.
 *
 * The .xpi is the build most users update to by themselves, and the gate
 * only ever loaded dist-chrome in Chrome: a Firefox-only break shipped
 * signed. This runs scripts/firefox-smoke.mjs on dist-firefox with the
 * Firefox it finds: FIREFOX_BIN, then a browser under .browsers/ (the
 * harness's own lookup), then the usual install path on Windows and macOS.
 *
 * Where there is no Firefox (the GitHub runner: its /usr/bin/firefox is a
 * snap launcher the harness was never run against) the step says so and
 * passes, so a release is not blocked by the runner's image. Every other
 * outcome is the harness's own: a failed check fails the gate.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FIREFOX_DEFAULTS = {
  win32: [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  ],
  darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
};

/** The installed Firefox to pass to the harness, or null to let it look under .browsers/. */
export function installedFirefox(
  env = process.env,
  candidates = FIREFOX_DEFAULTS[process.platform] ?? [],
  exists = fs.existsSync,
) {
  if (env.FIREFOX_BIN) return null; // the harness reads it itself
  if (exists(path.join(ROOT, ".browsers", "firefox"))) return null;
  return candidates.find((p) => exists(p)) ?? null;
}

/** Exit code of this step for the harness's: 3 is "nothing to run on". */
export function stepExitCode(harnessCode) {
  return harnessCode === 3 ? 0 : (harnessCode ?? 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = [path.join(ROOT, "scripts", "firefox-smoke.mjs"), "dist-firefox", "--runs", "3", "--cold", "1"];
  const firefox = installedFirefox();
  if (firefox) args.push("--firefox", firefox);
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (run.status === 3) {
    console.log(
      "smoke-firefox: no Firefox on this machine, the Firefox build was NOT loaded in a browser (set FIREFOX_BIN to run it).",
    );
  }
  process.exit(stepExitCode(run.status));
}
