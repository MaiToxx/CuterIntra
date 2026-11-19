/**
 * An Intra link carrying ?token=&login= used to stop main.ts in the shipped
 * "intra" build: no sign-in is ever in progress there, so the callback was
 * refused and the function returned, every feature off and the avatar held
 * hidden for the whole tab. The callback block is for the OAuth build only,
 * and a refused callback lets the page start.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8").replace(/\r\n/g, "\n");
const GUARD = 'if (AUTH_MODE === "oauth" && oauthToken && oauthLogin) {';

describe("main.ts and a ?token=&login= link", () => {
  it("only reads it as a callback in the OAuth build", () => {
    expect(main).toContain(GUARD);
  });

  it("does not return when the callback is refused", () => {
    const start = main.indexOf(GUARD);
    const refused = main.slice(start, main.indexOf("if (trusted) {", start));
    expect(refused).toContain("ignoring unexpected auth callback");
    expect(refused).not.toMatch(/\breturn\b/);
  });
});
