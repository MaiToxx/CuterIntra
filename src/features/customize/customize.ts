/**
 * "Customize" feature: user-level look & feel tweaks applied to every Intra
 * page (v2 and v3):
 *   - custom accent colour (overrides the theme preset's --primary), with an
 *     optional second colour for a gradient
 *   - font family, global font scale, density
 *   - full palette, page background (image or built-in gradient), card style
 *   - free-form custom CSS
 *
 * Everything is the user's own setting for their own browser (cloud-synced
 * for the same user only), so values are validated for robustness, not
 * against a hostile author. The one exception is the "visitor look": the
 * subset of these settings another user publishes on their profile (see
 * public-look.ts), which is validated key by key before reaching this file.
 */
import { CONFIG_DEFAULT, getConfigMany, type BetterIntraConfig } from "../../core/config.ts";
import { requestVisitorPreset } from "../../core/theme/theme-events.ts";
import { sanitizeCssUrl, sanitizeHexColor } from "../../core/security/css-sanitize.ts";
import { AVATAR_SELECTOR, DASHBOARD_CARD_SELECTOR } from "../../core/intra/selectors.ts";
import { msg } from "../../core/i18n/i18n.ts";

/** Elements the Intra v3 theme paints with the page background colour. */
const PAGE_SURFACES =
  "html, body, main, footer, header, #root, #root > div, [class*=\"min-h-screen\"]";
/** Selector used by the theme for dashboard/profile cards. */
const CARD_SURFACES = `div.bg-white, ${DASHBOARD_CARD_SELECTOR}`;
const AVATAR = AVATAR_SELECTOR;

/** "H S% L%" -> the same with the lightness shifted (clamped 0-100). */
export function shiftLightness(hsl: string, delta: number): string {
  const m = /^(\d+) (\d+)% (\d+)%$/.exec(hsl);
  if (!m) return hsl;
  const l = Math.min(100, Math.max(0, Number(m[3]) + delta));
  return `${m[1]} ${m[2]}% ${l}%`;
}

export const AVATAR_RADIUS: Record<string, string> = {
  circle: "",
  rounded: "1.25rem",
  square: "0",
};

export const CUSTOMIZE_KEYS = [
  // The theme preset (Profile tab) belongs to the look: presets and theme
  // codes carry it, and visitors of a profile see it (public-look.ts).
  "PROFILE_THEME_PRESET",
  "CUSTOM_ACCENT_ENABLED",
  "CUSTOM_ACCENT_COLOR",
  "CUSTOM_ACCENT_GRADIENT",
  "CUSTOM_ACCENT_COLOR_2",
  "CUSTOM_FONT",
  "CUSTOM_FONT_FAMILY",
  "CUSTOM_FONT_SCALE",
  "CUSTOM_RADIUS",
  "CUSTOM_DENSITY",
  "CUSTOM_HIDE_FOOTER",
  "CUSTOM_CSS",
  "CUSTOM_THEME_ENABLED",
  "CUSTOM_THEME_BG",
  "CUSTOM_THEME_CARD",
  "CUSTOM_THEME_TEXT",
  "CUSTOM_PAGE_BG_URL",
  "CUSTOM_PAGE_BG_DIM",
  "CUSTOM_PAGE_BG_PRESET",
  "CUSTOM_BG_ANIMATE",
  "CUSTOM_CARD_OPACITY",
  "CUSTOM_CARD_STYLE",
  "CUSTOM_AVATAR_SHAPE",
  "CUSTOM_SCROLLBAR",
  "CUSTOM_CARD_BORDER_MODE",
  "CUSTOM_CARD_BORDER_COLOR",
  "CUSTOM_CARD_BORDER_WIDTH",
  "CUSTOM_CARD_GLOW",
  "CUSTOM_CARD_TITLE_MODE",
  "CUSTOM_CARD_TITLE_COLOR",
  "CUSTOM_CARDS",
] as const;

/** Dashboard cards that can be styled one by one (id -> label). */
export const CARD_IDS = [
  "agenda",
  "evaluations",
  "achievements",
  "projects",
  "roulette",
  "logtime",
] as const;
export type CardId = (typeof CARD_IDS)[number];
/** English keys (msg): translate with t() where they are shown. */
export const CARD_LABELS: Record<CardId, string> = {
  agenda: msg("Agenda"),
  evaluations: msg("Pending evaluations"),
  achievements: msg("Last achievements"),
  projects: msg("Projects"),
  roulette: msg("Thursday roulette"),
  logtime: msg("Logtime"),
};
/** Intra card titles (upper-cased) -> card id, used to tag the cards. */
export const CARD_TITLES: Record<string, CardId> = {
  AGENDA: "agenda",
  "PENDING EVALUATIONS": "evaluations",
  "LAST ACHIEVEMENTS": "achievements",
  PROJECTS: "projects",
  "THURSDAY ROULETTE": "roulette",
  LOGTIME: "logtime",
};

export interface CardLook {
  bg?: string;
  border?: string;
  title?: string;
  glow?: boolean;
}
export type CardLookMap = Partial<Record<CardId, CardLook>>;


/** Keep known card ids with valid hex colours only; drops empty entries. */
export function sanitizeCardMap(raw: unknown): CardLookMap {
  const out: CardLookMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const id of CARD_IDS) {
    const v = src[id];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const c = v as Record<string, unknown>;
    const look: CardLook = {};
    for (const field of ["bg", "border", "title"] as const) {
      const val = c[field];
      const hex = sanitizeHexColor(val);
      if (hex) look[field] = hex;
    }
    if (c.glow === true) look.glow = true;
    if (Object.keys(look).length > 0) out[id] = look;
  }
  return out;
}

/** Selector for a tagged dashboard card (see cards.ts). */
const CARD = (id?: string) => (id ? `[data-ft-card="${id}"]` : "[data-ft-card]");
/** Card headings ("AGENDA", "PROJECTS"...). */
const CARD_TITLE = "[class*=\"uppercase\"]";

function cardRules(c: CustomizeConfig): string[] {
  const rules: string[] = [];
  const accent = "hsl(var(--primary))";
  const both = (sel: string) => `html.dark ${sel}, html:not(.dark) ${sel}`;
  const glowFor = (color: string) =>
    `box-shadow: 0 0 0 1px ${color}, 0 0 22px color-mix(in srgb, ${color} 45%, transparent) !important;`;

  const borderColor =
    c.CUSTOM_CARD_BORDER_MODE === "custom" && sanitizeHexColor(c.CUSTOM_CARD_BORDER_COLOR)
      ? sanitizeHexColor(c.CUSTOM_CARD_BORDER_COLOR)
      : c.CUSTOM_CARD_BORDER_MODE === "accent"
        ? accent
        : "";
  if (borderColor) {
    const width = Math.min(6, Math.max(1, Math.round(num(c.CUSTOM_CARD_BORDER_WIDTH, 2))));
    rules.push(`${both(CARD())} { border: ${width}px solid ${borderColor} !important; }`);
    if (c.CUSTOM_CARD_GLOW) rules.push(`${both(CARD())} { ${glowFor(borderColor)} }`);
  } else if (c.CUSTOM_CARD_GLOW) {
    rules.push(`${both(CARD())} { ${glowFor(accent)} }`);
  }

  const titleColor =
    c.CUSTOM_CARD_TITLE_MODE === "custom" && sanitizeHexColor(c.CUSTOM_CARD_TITLE_COLOR)
      ? sanitizeHexColor(c.CUSTOM_CARD_TITLE_COLOR)
      : c.CUSTOM_CARD_TITLE_MODE === "accent"
        ? accent
        : "";
  if (titleColor) {
    rules.push(`${CARD()} ${CARD_TITLE} { color: ${titleColor} !important; }`);
  }

  const cards = sanitizeCardMap(c.CUSTOM_CARDS);
  for (const id of CARD_IDS) {
    const look = cards[id];
    if (!look) continue;
    const decl: string[] = [];
    if (look.bg) decl.push(`background-color: ${look.bg} !important`);
    if (look.border) decl.push(`border: ${Math.min(6, Math.max(1, Math.round(num(c.CUSTOM_CARD_BORDER_WIDTH, 2))))}px solid ${look.border} !important`);
    if (look.glow) decl.push(glowFor(look.border || borderColor || accent).replace(/;$/, ""));
    if (decl.length) rules.push(`${both(CARD(id))} { ${decl.join("; ")}; }`);
    if (look.title) rules.push(`${CARD(id)} ${CARD_TITLE} { color: ${look.title} !important; }`);
  }
  return rules;
}

/** Built-in page backgrounds (CSS gradients, no image hosting needed). */
export const BG_PRESETS: Record<string, string> = {
  none: "",
  aurora:
    "radial-gradient(at 20% 10%, #1a2a6c 0%, transparent 55%), radial-gradient(at 80% 20%, #b21f1f33 0%, transparent 50%), radial-gradient(at 50% 90%, #0f9b8e 0%, transparent 55%), #0b0f1a",
  sunset:
    "linear-gradient(160deg, #2b1055 0%, #7597de 45%, #ffb88c 100%)",
  ocean:
    "linear-gradient(180deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",
  forest:
    "linear-gradient(160deg, #0b3d2e 0%, #14532d 50%, #1a2e1a 100%)",
  mono: "linear-gradient(180deg, #111111 0%, #2a2a2a 100%)",
  midnight:
    "linear-gradient(180deg, #020617 0%, #0f172a 55%, #1e1b4b 100%)",
  candy:
    "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 40%, #a18cd1 100%)",
  lava: "linear-gradient(160deg, #1a0000 0%, #7a1010 50%, #ff6a00 100%)",
  nord: "linear-gradient(180deg, #2e3440 0%, #3b4252 50%, #434c5e 100%)",
  dracula:
    "linear-gradient(160deg, #282a36 0%, #44475a 55%, #6272a4 100%)",
  teal: "linear-gradient(160deg, #001b1b 0%, #004d4d 50%, #00babc 100%)",
  space:
    "radial-gradient(circle at 15% 20%, rgba(255,255,255,0.12) 0 1px, transparent 2px), radial-gradient(circle at 70% 60%, rgba(255,255,255,0.10) 0 1px, transparent 2px), radial-gradient(circle at 40% 85%, rgba(255,255,255,0.08) 0 1px, transparent 2px), radial-gradient(at 80% 0%, #1d0b3a 0%, transparent 60%), #05030f",
  mesh:
    "radial-gradient(at 0% 0%, #7c3aed66 0%, transparent 50%), radial-gradient(at 100% 0%, #06b6d466 0%, transparent 50%), radial-gradient(at 100% 100%, #f43f5e55 0%, transparent 50%), radial-gradient(at 0% 100%, #22c55e55 0%, transparent 50%), #0b0f1a",
};

export const CARD_STYLES: Record<string, string> = {
  default: "",
  flat: "box-shadow: none !important; border: none !important;",
  soft: "box-shadow: 0 8px 24px rgba(0,0,0,0.18) !important; border: none !important;",
  strong: "box-shadow: 0 16px 48px rgba(0,0,0,0.45) !important; border: none !important;",
  outlined:
    "box-shadow: none !important; border: 1px solid hsl(var(--primary) / 0.45) !important;",
  glass:
    "background-color: hsl(var(--card) / 0.55) !important; backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2); border: 1px solid rgba(255,255,255,0.08) !important; box-shadow: 0 8px 32px rgba(0,0,0,0.25) !important;",
  stripe:
    "border-left: 4px solid hsl(var(--primary)) !important; box-shadow: 0 4px 16px rgba(0,0,0,0.15) !important;",
};

/**
 * Spacing presets. The v3 pages are built with Tailwind utilities, so the
 * densities re-map the handful of gap/padding classes the layout uses.
 */
export const DENSITY: Record<string, string> = {
  default: "",
  compact:
    ".gap-6 { gap: 1rem !important; } .gap-4 { gap: 0.625rem !important; } .gap-3 { gap: 0.5rem !important; } .p-6 { padding: 1rem !important; } .p-4 { padding: 0.75rem !important; } .px-6 { padding-left: 1rem !important; padding-right: 1rem !important; } .py-4 { padding-top: 0.5rem !important; padding-bottom: 0.5rem !important; } .mb-6 { margin-bottom: 1rem !important; } .mb-4 { margin-bottom: 0.75rem !important; } .space-y-4 > * + * { margin-top: 0.625rem !important; }",
  comfortable:
    ".gap-6 { gap: 2rem !important; } .gap-4 { gap: 1.5rem !important; } .p-6 { padding: 2rem !important; } .p-4 { padding: 1.5rem !important; } .mb-6 { margin-bottom: 2rem !important; } .mb-4 { margin-bottom: 1.5rem !important; }",
};

export type CustomizeConfig = Pick<BetterIntraConfig, (typeof CUSTOMIZE_KEYS)[number]>;

const STYLE_ID = "better-intra-customize";
const CSS_ID = "better-intra-custom-css";
/** Look published by the profile being visited (see applyVisitorLook). */
export const VISITOR_STYLE_ID = "better-intra-visitor-look";

/** Built-in font choices (system fonts only: no external requests). */
export const FONT_PRESETS: Record<string, string> = {
  default: "",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif",
  humanist: "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  rounded:
    "'Nunito', 'Varela Round', 'Segoe UI Rounded', 'Arial Rounded MT Bold', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace",
};

/** #rrggbb -> "H S% L%" (the format the theme variables use). */
export function hexToHslTriplet(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** WCAG relative luminance of #rrggbb (0 = black, 1 = white), or null. */
export function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lum = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * lum((n >> 16) & 255) +
    0.7152 * lum((n >> 8) & 255) +
    0.0722 * lum(n & 255)
  );
}

/** WCAG contrast ratio of two relative luminances (1 to 21). */
function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Black or white text, whichever has the higher WCAG contrast ratio with the
 * given colour. With a second colour (a two-stop accent gradient) the text
 * sits on both, so the pick is the one whose WORSE ratio of the two is best.
 *
 * It used to cut at a luminance of 0.4, but black and white are equally
 * readable at about 0.18: every accent in between got the worse one, the 42
 * teal (#00babc) included, white at 2.4:1 where black gives 8.7:1.
 */
export function contrastForeground(
  hex: string,
  hex2?: string,
): "0 0% 0%" | "0 0% 100%" {
  const stops = [hex, hex2]
    .map((h) => (h === undefined ? null : relativeLuminance(h)))
    .filter((l): l is number => l !== null);
  if (stops.length === 0) return "0 0% 100%";
  const worst = (text: number) => Math.min(...stops.map((l) => contrastRatio(l, text)));
  // Ties keep white, as the old cut-off did for the colours it got right.
  return worst(0) > worst(1) ? "0 0% 0%" : "0 0% 100%";
}

/** A font-family value safe to interpolate into a declaration. */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // no comment opener and no function call either: a font list has neither
  const v = value.trim().replace(/\/\*|\*\//g, "").replace(/[;{}<>\\()]/g, "").slice(0, 200);
  return v;
}

/** Clamp the font scale to a sane range (percent). */
export function clampFontScale(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(140, Math.max(70, Math.round(n)));
}

export const RADIUS: Record<string, string> = {
  default: "",
  none: "0px",
  small: "0.375rem",
  large: "1rem",
  full: "1.5rem",
};

const TRANSPARENT_SURFACES = PAGE_SURFACES.split(", ")
  .filter((s) => s !== "html")
  .map((s) => `html.dark ${s}, html:not(.dark) ${s}`)
  .join(", ");

/** What the stylesheet needs to know beyond the look itself. */
export type CustomizeCssOptions = {
  /**
   * The viewer turned "Disable animations" on: no looping page animation,
   * whatever the look asks for (their own, or a visited profile's).
   */
  disableAnimations?: boolean;
};

/** Build the stylesheet for the current customisation settings. */
export function buildCustomizeCss(
  c: CustomizeConfig,
  options: CustomizeCssOptions = {},
): string {
  const rules: string[] = [];

  if (c.CUSTOM_ACCENT_ENABLED) {
    const hsl = hexToHslTriplet(c.CUSTOM_ACCENT_COLOR);
    if (hsl) {
      // The text sits on the gradient when there is one, so both stops count.
      const fg = contrastForeground(
        c.CUSTOM_ACCENT_COLOR,
        c.CUSTOM_ACCENT_GRADIENT && hexToHslTriplet(c.CUSTOM_ACCENT_COLOR_2)
          ? c.CUSTOM_ACCENT_COLOR_2
          : undefined,
      );
      // v3 theme variables; --legacy-main is used by a few components
      rules.push(
        `html, html.dark, html:not(.dark) { --primary: ${hsl} !important; --ring: ${hsl} !important; --primary-foreground: ${fg} !important; --legacy-main: hsl(${hsl}) !important; }`,
      );
      // v2 intra: the accent is a plain hex in a few places
      rules.push(
        `:root { --better-intra-accent: ${c.CUSTOM_ACCENT_COLOR}; --theme-color: ${c.CUSTOM_ACCENT_COLOR}; }`,
      );
      // Two-colour accent: buttons, progress fills and other solid accent
      // surfaces get a gradient (translucent "bg-primary/20" variants are
      // left alone so they stay see-through).
      const hex2 = c.CUSTOM_ACCENT_GRADIENT ? hexToHslTriplet(c.CUSTOM_ACCENT_COLOR_2) : null;
      if (hex2) {
        rules.push(
          `.bg-primary, .btn-primary, progress::-webkit-progress-value { background-image: linear-gradient(135deg, ${c.CUSTOM_ACCENT_COLOR}, ${c.CUSTOM_ACCENT_COLOR_2}) !important; }`,
        );
      }
    }
  }

  const family =
    c.CUSTOM_FONT === "custom"
      ? sanitizeFontFamily(c.CUSTOM_FONT_FAMILY)
      : (FONT_PRESETS[c.CUSTOM_FONT] ?? "");
  if (family) {
    // icon fonts keep their family: only text elements are targeted
    rules.push(
      `html, body, button, input, select, textarea, .font-sans { font-family: ${family} !important; }`,
    );
  }

  const scale = clampFontScale(c.CUSTOM_FONT_SCALE);
  if (scale !== 100) {
    rules.push(`html { font-size: ${scale}% !important; }`);
  }

  const radius = RADIUS[c.CUSTOM_RADIUS] ?? "";
  if (radius) {
    rules.push(
      `html { --radius: ${radius} !important; } .rounded-xl, .rounded-lg, .rounded-md, .rounded-2xl, .card, .btn, .input, .select { border-radius: ${radius} !important; }`,
    );
  }

  const density = DENSITY[c.CUSTOM_DENSITY] ?? "";
  if (density) rules.push(density);

  if (c.CUSTOM_HIDE_FOOTER) {
    rules.push(`footer { display: none !important; }`);
  }

  // Full custom palette: the v3 theme paints everything through these
  // variables, so overriding them recolours the whole interface. Secondary
  // tones (muted, border, input, popover, accent) derive from the two
  // surfaces so a single pair of colours stays coherent.
  if (c.CUSTOM_THEME_ENABLED) {
    const bg = hexToHslTriplet(c.CUSTOM_THEME_BG);
    const card = hexToHslTriplet(c.CUSTOM_THEME_CARD);
    const text = hexToHslTriplet(c.CUSTOM_THEME_TEXT);
    if (bg && card && text) {
      const dark = Number(/(\d+)%$/.exec(bg)?.[1] ?? 50) < 50;
      const step = dark ? 6 : -6;
      const vars = [
        `--background: ${bg}`,
        `--card: ${card}`,
        `--popover: ${card}`,
        `--foreground: ${text}`,
        `--card-foreground: ${text}`,
        `--popover-foreground: ${text}`,
        `--accent-foreground: ${text}`,
        `--muted: ${shiftLightness(bg, step)}`,
        `--muted-foreground: ${shiftLightness(text, dark ? -25 : 25)}`,
        `--accent: ${shiftLightness(card, step * 1.5)}`,
        `--border: ${shiftLightness(card, step * 1.5)}`,
        `--input: ${shiftLightness(card, step / 2)}`,
      ].map((v) => `${v} !important`);
      rules.push(`html, html.dark, html:not(.dark) { ${vars.join("; ")}; }`);
    }
  }

  // Page background image with a dim overlay; page surfaces become
  // transparent so the picture shows through, cards keep their colour at the
  // chosen opacity.
  const pageBg = sanitizeCssUrl(c.CUSTOM_PAGE_BG_URL);
  if (pageBg) {
    const dim = Math.min(90, Math.max(0, Math.round(num(c.CUSTOM_PAGE_BG_DIM, 40)))) / 100;
    rules.push(
      `html, html.dark, html:not(.dark) { background: linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${pageBg}") center / cover fixed no-repeat !important; }`,
    );
    rules.push(
      `${TRANSPARENT_SURFACES} { background-color: transparent !important; background-image: none !important; }`,
    );
  }

  const cardOpacity = Math.min(100, Math.max(30, Math.round(num(c.CUSTOM_CARD_OPACITY, 100))));
  if (cardOpacity !== 100 || pageBg) {
    const alpha = (cardOpacity / 100).toFixed(2);
    rules.push(
      `html.dark ${CARD_SURFACES.split(", ").join(", html.dark ")} { background-color: hsl(var(--card) / ${alpha}) !important; backdrop-filter: blur(8px); }`,
    );
  }

  const avatarRadius = AVATAR_RADIUS[c.CUSTOM_AVATAR_SHAPE] ?? "";
  if (avatarRadius !== "" && c.CUSTOM_AVATAR_SHAPE !== "circle") {
    rules.push(`${AVATAR} { border-radius: ${avatarRadius} !important; }`);
  }

  // Built-in gradient background (only when no image is set; same surface
  // handling as the image).
  const gradient = BG_PRESETS[c.CUSTOM_PAGE_BG_PRESET] ?? "";
  if (!pageBg && gradient) {
    rules.push(
      `html, html.dark, html:not(.dark) { background: ${gradient} fixed !important; }`,
    );
    rules.push(
      `${TRANSPARENT_SURFACES} { background-color: transparent !important; background-image: none !important; }`,
    );
    if (cardOpacity === 100) {
      rules.push(
        `html.dark ${CARD_SURFACES.split(", ").join(", html.dark ")} { background-color: hsl(var(--card) / 0.92) !important; }`,
      );
    }
    if (c.CUSTOM_BG_ANIMATE && !options.disableAnimations) {
      // Slow drift of the gradient; off for people who asked their OS for
      // less motion, and for those who switched animations off here.
      rules.push(
        `@keyframes bi-bg-drift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }`,
      );
      rules.push(
        `html, html.dark, html:not(.dark) { background-size: 200% 200% !important; animation: bi-bg-drift 45s ease-in-out infinite; }`,
      );
      rules.push(
        `@media (prefers-reduced-motion: reduce) { html { animation: none !important; } }`,
      );
    }
  }

  const cardStyle = CARD_STYLES[c.CUSTOM_CARD_STYLE] ?? "";
  if (cardStyle) {
    rules.push(`${CARD_SURFACES}, .card { ${cardStyle} }`);
  }

  // Dashboard cards last: their per-card colours must win over the generic
  // card opacity / style rules above.
  rules.push(...cardRules(c));

  if (c.CUSTOM_SCROLLBAR && c.CUSTOM_SCROLLBAR !== "default") {
    if (c.CUSTOM_SCROLLBAR === "hidden") {
      rules.push(
        `html { scrollbar-width: none !important; } html::-webkit-scrollbar { width: 0 !important; height: 0 !important; }`,
      );
    } else {
      const thumb =
        c.CUSTOM_SCROLLBAR === "accent" ? "hsl(var(--primary))" : "rgba(128,128,128,0.55)";
      rules.push(
        `html { scrollbar-width: thin !important; scrollbar-color: ${thumb} transparent !important; } ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-thumb { background: ${thumb}; border-radius: 8px; } ::-webkit-scrollbar-track { background: transparent; }`,
      );
    }
  }

  return rules.join("\n");
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Every Customize setting at its default value. */
export function defaultCustomization(): CustomizeConfig {
  const out = {} as Record<string, unknown>;
  for (const key of CUSTOMIZE_KEYS) out[key] = CONFIG_DEFAULT[key];
  return out as CustomizeConfig;
}

/** Stylesheet for a partial look (missing keys at their defaults). */
export function buildLookCss(
  look: Partial<CustomizeConfig>,
  options: CustomizeCssOptions = {},
): string {
  return buildCustomizeCss({ ...defaultCustomization(), ...look }, options);
}

function setStyle(id: string, css: string) {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    (document.head || document.documentElement).appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/**
 * Read with the look but kept out of CUSTOMIZE_KEYS: it is the viewer's own
 * preference, not part of a look that presets save or profiles publish.
 */
const VIEWER_KEYS = ["DISABLE_ANIMATIONS"] as const;

export async function applyCustomizations(): Promise<void> {
  const c = await getConfigMany([...CUSTOMIZE_KEYS, ...VIEWER_KEYS]);
  setStyle(
    STYLE_ID,
    buildCustomizeCss(c, { disableAnimations: c.DISABLE_ANIMATIONS === true }),
  );
  // custom CSS last so it wins over everything above
  setStyle(CSS_ID, typeof c.CUSTOM_CSS === "string" ? c.CUSTOM_CSS : "");
}

let visitorLook: Partial<CustomizeConfig> | null = null;
let visitorLookKey = "";

/**
 * Apply (or clear, with null) the look published by the profile being
 * visited. It is rendered after the viewer's own customisation so that it
 * wins on the shared declarations, but the viewer's custom CSS stays last.
 * Honours the viewer's CUSTOM_SHOW_OTHERS_LOOK setting.
 */
export async function applyVisitorLook(look: Partial<CustomizeConfig> | null): Promise<void> {
  visitorLook = look && Object.keys(look).length > 0 ? look : null;
  if (!visitorLook) {
    visitorLookKey = "";
    setStyle(VISITOR_STYLE_ID, "");
    requestVisitorPreset(null);
    return;
  }
  // Called on every mutation pass of the profile page: skip the storage
  // round-trip when the same look is already on screen.
  const key = JSON.stringify(visitorLook);
  if (key === visitorLookKey && document.getElementById(VISITOR_STYLE_ID)) return;
  visitorLookKey = key;
  const { CUSTOM_SHOW_OTHERS_LOOK, DISABLE_ANIMATIONS } = await getConfigMany([
    "CUSTOM_SHOW_OTHERS_LOOK",
    ...VIEWER_KEYS,
  ]);
  if (CUSTOM_SHOW_OTHERS_LOOK === false) {
    visitorLookKey = "";
    setStyle(VISITOR_STYLE_ID, "");
    requestVisitorPreset(null);
    return;
  }
  // their theme preset first (it may switch the page to its mode), then
  // their colours on top
  requestVisitorPreset(
    typeof visitorLook.PROFILE_THEME_PRESET === "string" ? visitorLook.PROFILE_THEME_PRESET : null,
  );
  setStyle(
    VISITOR_STYLE_ID,
    buildLookCss(visitorLook, { disableAnimations: DISABLE_ANIMATIONS === true }),
  );
  const own = document.getElementById(CSS_ID);
  if (own && own.nextElementSibling) own.parentElement?.appendChild(own);
}

/** True while a visitor look is displayed. */
export function hasVisitorLook(): boolean {
  return !!document.getElementById(VISITOR_STYLE_ID);
}

let initialised = false;

export async function initCustomize(): Promise<void> {
  await applyCustomizations();
  if (initialised) return;
  initialised = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const viewer = VIEWER_KEYS.some((k) => k in changes);
    if (viewer || CUSTOMIZE_KEYS.some((k) => k in changes)) void applyCustomizations();
    if (viewer || "CUSTOM_SHOW_OTHERS_LOOK" in changes) {
      visitorLookKey = "";
      void applyVisitorLook(visitorLook);
    }
  });
}
