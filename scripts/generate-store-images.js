/**
 * Chrome Web Store images, written to images-store/ (gitignored):
 *
 *   npm run generate:store-images
 *
 * - promo-small.png (440x280, required by the store) and promo-marquee.png
 *   (1400x560, optional): the extension icon and its name on a gradient,
 *   drawn from src/assets/svg/icon.svg. No screenshot and no photo: the
 *   store guide asks for a tile that still reads at a quarter of its size,
 *   and a screenshot of the Intra shows whoever was on it.
 * - <name>-screenshot.png (1280x800, at most 5): the captures you put in
 *   store-screenshots/, cropped to 16:10 (fit "cover": the store wants full
 *   bleed, and "contain" used to letterbox them on white). Take them fresh
 *   from dist-chrome-store with no other student visible; see
 *   docs/CHROME-WEB-STORE.md, "Store images".
 *
 * images/ is not read: it holds upstream's 1.8.6 screenshots for the README,
 * with the upstream author's own profile and film characters as avatars.
 */
import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { resolve, dirname, extname, basename, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

export const ICON_SVG = resolve(root, "src/assets/svg/icon.svg");
export const SCREENSHOTS_DIR = resolve(root, "store-screenshots");
export const OUT_DIR = resolve(root, "images-store");

export const NAME = "Cuter Intra";
export const TAGLINE = "Your Intra, improved";

export const SCREENSHOT = { width: 1280, height: 800 };
export const PROMO_SMALL = { width: 440, height: 280 };
export const PROMO_MARQUEE = { width: 1400, height: 560 };
/** The store shows at most five screenshots and refuses a sixth. */
export const MAX_SCREENSHOTS = 5;
/** A capture further than this from 16:10 loses a visible part to the crop. */
const RATIO_TOLERANCE = 0.05;

const SCREENSHOT_EXT = /\.(png|jpe?g|webp)$/i;
const FONT = "'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif";

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * One promo tile as a PNG buffer: 24-bit, no alpha, as the store asks.
 * `layout` places the icon and the text; the two tiles only differ by it.
 */
async function renderTile({ width, height }, layout, iconSvg) {
  const lines = layout.lines
    .map(
      (l) =>
        `<text x="${l.x}" y="${l.y}" font-family="${FONT}" font-size="${l.size}" font-weight="${l.weight}" fill="${l.fill}">${escapeXml(l.text)}</text>`,
    )
    .join("");
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="promo-bg" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#12c9cb"/><stop offset="1" stop-color="#024e54"/>` +
      `</linearGradient></defs>` +
      `<rect width="${width}" height="${height}" fill="url(#promo-bg)"/>${lines}</svg>`,
  );
  // Rasterised at its final size (the SVG is 100 units wide) rather than
  // scaled up from 100 px, which would blur the glyph.
  const icon = await sharp(iconSvg, { density: (72 * layout.icon.size) / 100 })
    .resize(layout.icon.size, layout.icon.size)
    .png()
    .toBuffer();
  const composed = await sharp(background)
    .composite([{ input: icon, left: layout.icon.x, top: layout.icon.y }])
    .png()
    .toBuffer();
  // A second pass: sharp composites last in a pipeline, so a flatten in the
  // same one would run before the icon is added and leave an alpha channel.
  return sharp(composed).flatten({ background: "#024e54" }).png().toBuffer();
}

/** The 440x280 small promo tile: icon on the left, the name on two lines. */
export function renderPromoSmall(iconSvg = readFileSync(ICON_SVG)) {
  const [first, ...rest] = NAME.split(" ");
  return renderTile(
    PROMO_SMALL,
    {
      icon: { size: 136, x: 36, y: 72 },
      lines: [
        { text: first, x: 200, y: 132, size: 54, weight: 700, fill: "#ffffff" },
        { text: rest.join(" "), x: 200, y: 192, size: 54, weight: 700, fill: "#ffffff" },
      ],
    },
    iconSvg,
  );
}

/** The 1400x560 marquee: icon, name and one short tagline. */
export function renderPromoMarquee(iconSvg = readFileSync(ICON_SVG)) {
  return renderTile(
    PROMO_MARQUEE,
    {
      icon: { size: 300, x: 170, y: 130 },
      lines: [
        { text: NAME, x: 540, y: 290, size: 120, weight: 700, fill: "#ffffff" },
        { text: TAGLINE, x: 546, y: 370, size: 48, weight: 400, fill: "#dff9f9" },
      ],
    },
    iconSvg,
  );
}

/**
 * The captures to convert, sorted by name (the store keeps upload order).
 * @throws when there are more than MAX_SCREENSHOTS: which five to drop is
 * the author's choice, not this script's.
 */
export function listScreenshots(dir = SCREENSHOTS_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => SCREENSHOT_EXT.test(f))
    .sort();
  if (files.length > MAX_SCREENSHOTS) {
    throw new Error(
      `${files.length} screenshots in ${dir}; the Chrome Web Store takes at most ${MAX_SCREENSHOTS}. Keep five:\n  ${files.join("\n  ")}`,
    );
  }
  return files.map((f) => join(dir, f));
}

/**
 * One capture cropped to 1280x800 without letterboxing. Returns a warning
 * when the source is far from 16:10, since the crop then cuts part of it.
 */
export async function convertScreenshot(src, dst) {
  const { width = 0, height = 0 } = await sharp(src).metadata();
  const ratio = height ? width / height : 0;
  const target = SCREENSHOT.width / SCREENSHOT.height;
  await sharp(src)
    .resize(SCREENSHOT.width, SCREENSHOT.height, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(dst);
  return Math.abs(ratio / target - 1) > RATIO_TOLERANCE
    ? `${basename(src)} is ${width}x${height}, not 16:10: the crop cut part of it. Capture at 1280x800 (or 2560x1600).`
    : null;
}

/** Earlier outputs, so a removed capture or an old upstream promo is not uploaded by mistake. */
function removeOldOutputs(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (/-screenshot\.png$|promo-(small|marquee)\.png$/.test(f)) rmSync(join(dir, f));
  }
}

async function main() {
  const screenshots = listScreenshots();
  mkdirSync(OUT_DIR, { recursive: true });
  removeOldOutputs(OUT_DIR);
  console.log("Generating store images...\n");

  await sharp(await renderPromoSmall()).toFile(join(OUT_DIR, "promo-small.png"));
  console.log("  promo small   -> promo-small.png (440x280)");
  await sharp(await renderPromoMarquee()).toFile(join(OUT_DIR, "promo-marquee.png"));
  console.log("  promo marquee -> promo-marquee.png (1400x560)");

  if (screenshots.length === 0) {
    console.log(
      `\nNo screenshots: put up to ${MAX_SCREENSHOTS} captures of dist-chrome-store in ${SCREENSHOTS_DIR} and run this again.`,
    );
  }
  for (const src of screenshots) {
    const name = `${basename(src, extname(src))}-screenshot.png`;
    const warning = await convertScreenshot(src, join(OUT_DIR, name));
    console.log(`  screenshot    -> ${name}`);
    if (warning) console.warn(`  warning: ${warning}`);
  }

  console.log(`\nDone: ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
