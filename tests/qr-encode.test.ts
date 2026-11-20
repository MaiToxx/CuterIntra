/**
 * Our QR encoder against qrcode-generator, the library it replaced in the
 * bundle (20 KB of content.js for one picture in the hub): the same modules,
 * one for one, on every version from 1 to 40 and at the edges between them.
 */
import { describe, it, expect } from "vitest";
import qrcode from "qrcode-generator";
import { qrModules } from "../src/features/calendar/qr-encode";

// The library keeps one byte per UTF-16 unit by default; a link with an
// accent needs UTF-8, which is what we encode.
qrcode.stringToBytes = (s: string) => [...new TextEncoder().encode(s)];

function reference(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col)),
  );
}

const picture = (grid: boolean[][]) =>
  grid.map((row) => row.map((dark) => (dark ? "#" : ".")).join("")).join("\n");

/** Repeatable "random" link text of a given length. */
function text(length: number, seed: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&'()*+,;=%";
  let out = "";
  let x = seed * 2654435761 + 1;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += chars[(x >>> 16) % chars.length];
  }
  return out;
}

/** Bytes a version holds in byte mode at level M (ISO/IEC 18004, table 7). */
const CAPACITY = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989,
  2099, 2213, 2331,
];

describe("qrModules", () => {
  it("draws what the library draws for a calendar link", () => {
    const link =
      "https://betterintra-remake.maitox.workers.dev/api/v1/public/calendar?token=0123456789abcdef0123456789abcdef";
    expect(picture(qrModules(link))).toBe(picture(reference(link)));
  });

  it("matches it on every version, at the last length that fits and the first of the next", () => {
    CAPACITY.forEach((bytes, i) => {
      const version = i + 1;
      for (const length of [bytes, bytes - 1, (CAPACITY[i - 1] ?? 0) + 1]) {
        const sample = text(length, version * 7 + length);
        const ours = qrModules(sample);
        expect(ours.length, `version ${version}, ${length} bytes`).toBe(version * 4 + 17);
        expect(picture(ours) === picture(reference(sample)), `version ${version}, ${length} bytes`).toBe(true);
      }
    });
  });

  it("matches it on short texts of every length, and on text that is not ASCII", () => {
    for (let length = 1; length <= 120; length++) {
      const sample = text(length, length);
      expect(picture(qrModules(sample)) === picture(reference(sample)), `${length} bytes`).toBe(true);
    }
    const accents = "https://example.com/événement?nom=Zoé&lieu=Mulhouse 🎰";
    expect(picture(qrModules(accents))).toBe(picture(reference(accents)));
  });

  it("refuses a text too long for the largest code", () => {
    expect(() => qrModules("a".repeat(2332))).toThrow(/too long/);
    expect(qrModules("a".repeat(2331)).length).toBe(177);
  });
});
