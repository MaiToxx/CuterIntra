/**
 * "Public profile" section of the settings hub (Profile tab).
 *
 * The form is hand-written next to a contract (extras.ts) that the sanitizer,
 * the stylesheet and the effects are built on: an option the form offers and
 * the contract does not know would be saved, published, then silently dropped
 * on every visitor's side. These tests keep the two in step.
 */
import { describe, it, expect } from "vitest";
import {
  HUB_SETTING_DEFS,
  type HubSettingDef,
} from "../src/features/hub/hubSettings.data.ts";
import { CONFIG_DEFAULT, type ConfigKey } from "../src/core/config";
import { BG_PRESETS } from "../src/features/customize/customize";
import {
  EXTRAS_KEYS,
  NAME_STYLES,
  NAME_FONTS,
  FRAMES,
  LEVEL_STYLES,
  EFFECTS,
  INTENSITIES,
  LIMITS,
} from "../src/features/profile/extras/extras";

const SECTION_LABEL = "Public profile (visible to every Cuter Intra user)";
const VIEWER_KEY = "PROFILE_SHOW_OTHERS_EXTRAS";
const FORM_KEYS: readonly ConfigKey[] = [...EXTRAS_KEYS, VIEWER_KEY];

const profileDefs = HUB_SETTING_DEFS.profile;
const sectionStart = profileDefs.findIndex(
  (d) => d.kind === "divider" && d.label === SECTION_LABEL,
);
const sectionDefs = profileDefs.slice(sectionStart);

function defOf(key: ConfigKey): HubSettingDef {
  const def = profileDefs.find((d) => d.key === key);
  if (!def) throw new Error(`no def for ${key}`);
  return def;
}

const optionValues = (key: ConfigKey) =>
  (defOf(key).options ?? []).map((o) => o.value);

describe("public profile section: structure", () => {
  it("closes the Profile tab, behind its divider", () => {
    expect(sectionStart).toBeGreaterThan(0);
    for (const key of FORM_KEYS) {
      expect(
        sectionDefs.some((d) => d.key === key),
        `${key} is inside the section`,
      ).toBe(true);
    }
    // nothing of the older profile settings slipped under the divider
    for (const def of sectionDefs) {
      if (def.key) expect(FORM_KEYS).toContain(def.key);
    }
  });

  it("has exactly one def per published key and for the viewer switch", () => {
    for (const key of FORM_KEYS) {
      expect(
        profileDefs.filter((d) => d.key === key),
        key,
      ).toHaveLength(1);
    }
  });

  it("does not define those keys in another tab", () => {
    for (const [feature, defs] of Object.entries(HUB_SETTING_DEFS)) {
      if (feature === "profile") continue;
      for (const def of defs) {
        if (def.key) expect(FORM_KEYS).not.toContain(def.key);
      }
    }
  });

  it("groups the settings under the expected sub-dividers, in order", () => {
    const dividers = sectionDefs
      .filter((d) => d.kind === "divider")
      .map((d) => d.label);
    expect(dividers.slice(0, 8)).toEqual([
      SECTION_LABEL,
      "Identity",
      "Links",
      "Name",
      "Avatar frame",
      "Level bar",
      "Header & card",
      "Effect",
    ]);
  });

  it("starts with the publish switch and ends with the viewer switch", () => {
    expect(sectionDefs[1].key).toBe("PROFILE_PUB_ENABLED");
    expect(sectionDefs[1].kind).toBe("toggle");
    const last = sectionDefs[sectionDefs.length - 1];
    expect(last.key).toBe(VIEWER_KEY);
    expect(last.kind).toBe("toggle");
  });

  it("only uses setting kinds the hub already renders", () => {
    const allowed = [
      "toggle",
      "text",
      "select",
      "color",
      "number",
      "divider",
      "emoji",
    ];
    for (const def of sectionDefs) {
      expect(allowed, `${def.key ?? def.label}`).toContain(def.kind);
      expect(def.feature).toBe("profile");
    }
  });

  it("lays every control on the grid, full-width ones on their own row", () => {
    for (const def of sectionDefs) {
      if (def.kind === "divider" || def.key === "PROFILE_PUB_ENABLED") continue;
      if (def.fullWidth) {
        expect(def.colSpan, `${def.key}`).toBeUndefined();
      } else {
        expect(def.grid, `${def.key}`).toBe(true);
        expect(def.colSpan, `${def.key}`).toBe(1);
      }
    }
  });
});

describe("public profile section: defaults", () => {
  it("takes every default value from CONFIG_DEFAULT", () => {
    for (const key of FORM_KEYS) {
      expect(defOf(key).defaultValue, key).toBe(CONFIG_DEFAULT[key]);
    }
  });

  it("selects default to one of their own options", () => {
    for (const def of sectionDefs) {
      if (def.kind !== "select") continue;
      expect(
        (def.options ?? []).map((o) => o.value),
        `${def.key}`,
      ).toContain(def.defaultValue);
    }
  });
});

describe("public profile section: option lists match the contract", () => {
  it.each([
    ["PROFILE_PUB_NAME_STYLE", NAME_STYLES],
    ["PROFILE_PUB_NAME_FONT", NAME_FONTS],
    ["PROFILE_PUB_FRAME", FRAMES],
    ["PROFILE_PUB_LEVEL_STYLE", LEVEL_STYLES],
    ["PROFILE_PUB_EFFECT", EFFECTS],
    ["PROFILE_PUB_EFFECT_INTENSITY", INTENSITIES],
  ] as const)("%s", (key, contract) => {
    expect(defOf(key).kind).toBe("select");
    expect(optionValues(key)).toEqual([...contract]);
  });

  it("header gradient offers none plus every BG_PRESETS gradient", () => {
    const expected = [
      "none",
      ...Object.keys(BG_PRESETS).filter((k) => k !== "none"),
    ];
    const values = optionValues("PROFILE_PUB_BANNER_GRADIENT");
    expect(defOf("PROFILE_PUB_BANNER_GRADIENT").kind).toBe("select");
    expect(values).toHaveLength(expected.length);
    expect(new Set(values)).toEqual(new Set(expected));
    expect(values[0]).toBe("none");
  });

  it("header gradient reuses the labels of the page background preset", () => {
    expect(defOf("PROFILE_PUB_BANNER_GRADIENT").options).toEqual(
      HUB_SETTING_DEFS.customize.find(
        (d) => d.key === "CUSTOM_PAGE_BG_PRESET",
      )?.options,
    );
  });

  it("gives every option a label", () => {
    for (const def of sectionDefs) {
      for (const o of def.options ?? []) {
        expect(o.label, `${def.key}: ${o.value}`).toBeTruthy();
      }
    }
  });
});

describe("public profile section: limits match the contract", () => {
  it.each([
    ["PROFILE_PUB_BIO", LIMITS.bio],
    ["PROFILE_PUB_STATUS_TEXT", LIMITS.statusText],
    ["PROFILE_PUB_PRONOUNS", LIMITS.pronouns],
    ["PROFILE_PUB_GREETING", LIMITS.greeting],
  ] as const)("%s stops at the sanitizer's length", (key, limit) => {
    expect(defOf(key).kind).toBe("text");
    expect(defOf(key).maxLength).toBe(limit);
  });

  it("flair has room for the emoji the sanitizer keeps", () => {
    const def = defOf("PROFILE_PUB_FLAIR");
    expect(def.kind).toBe("text");
    expect(def.maxLength).toBe(60);
    // one code point per emoji at the very least, plus the separators
    expect(def.maxLength!).toBeGreaterThanOrEqual(LIMITS.flairItems * 2 - 1);
  });

  it("the long texts take the full width", () => {
    expect(defOf("PROFILE_PUB_BIO").fullWidth).toBe(true);
    expect(defOf("PROFILE_PUB_GREETING").fullWidth).toBe(true);
  });

  it("number ranges are the ones the sanitizer clamps to", () => {
    const dim = defOf("PROFILE_PUB_BANNER_DIM");
    expect([dim.kind, dim.min, dim.max, dim.step]).toEqual([
      "number",
      0,
      LIMITS.bannerDimMax,
      5,
    ]);
    const blur = defOf("PROFILE_PUB_BANNER_BLUR");
    expect([blur.kind, blur.min, blur.max, blur.step]).toEqual([
      "number",
      0,
      LIMITS.bannerBlurMax,
      1,
    ]);
  });
});

describe("public profile section: dependencies", () => {
  it("every dependsOn points at a key that has a def", () => {
    for (const def of sectionDefs) {
      if (!def.dependsOn) continue;
      expect(
        profileDefs.filter((d) => d.key === def.dependsOn),
        `${def.key} -> ${def.dependsOn}`,
      ).toHaveLength(1);
    }
  });

  it("wires the colours and effect options to their parent", () => {
    const deps = Object.fromEntries(
      sectionDefs
        .filter((d) => d.key && d.dependsOn)
        .map((d) => [d.key, d.dependsOn]),
    );
    expect(deps).toEqual({
      PROFILE_PUB_NAME_COLOR: "PROFILE_PUB_NAME_STYLE",
      PROFILE_PUB_NAME_COLOR_2: "PROFILE_PUB_NAME_STYLE",
      PROFILE_PUB_FRAME_COLOR: "PROFILE_PUB_FRAME",
      PROFILE_PUB_FRAME_COLOR_2: "PROFILE_PUB_FRAME",
      PROFILE_PUB_LEVEL_COLOR: "PROFILE_PUB_LEVEL_STYLE",
      PROFILE_PUB_LEVEL_COLOR_2: "PROFILE_PUB_LEVEL_STYLE",
      PROFILE_PUB_EFFECT_INTENSITY: "PROFILE_PUB_EFFECT",
      PROFILE_PUB_EFFECT_TINT: "PROFILE_PUB_EFFECT",
      PROFILE_PUB_EFFECT_COLOR: "PROFILE_PUB_EFFECT_TINT",
    });
  });

  it("a parent is a toggle, or a select whose off value the hub knows", () => {
    // The hub treats a select as off for "", "none" and "default" only
    // (parentIsOn and the hidden-at-open loop of hub/dependents.ts): a
    // parent whose default is anything else would show its dependants on a
    // fresh install, before the student chose anything.
    for (const def of sectionDefs) {
      if (!def.dependsOn) continue;
      const parent = defOf(def.dependsOn);
      expect(["toggle", "select"], `${parent.key}`).toContain(parent.kind);
      if (parent.kind === "toggle") {
        expect(parent.defaultValue, `${parent.key}`).toBe(false);
      } else {
        expect(["none", "default"], `${parent.key}`).toContain(
          parent.defaultValue,
        );
      }
    }
  });
});

describe("colour pickers follow the styles that use them", () => {
  const defs = HUB_SETTING_DEFS.profile;
  const byKey = (key: string) => defs.find((d) => d.key === key);

  it("names the exact parent values for every dependent colour", () => {
    const expected: Record<string, string[]> = {
      // extras-style.ts: which branch reads which colour
      PROFILE_PUB_NAME_COLOR: ["custom", "gradient", "glow", "neon"],
      PROFILE_PUB_NAME_COLOR_2: ["gradient", "neon"],
      PROFILE_PUB_FRAME_COLOR: ["solid", "double", "dashed", "gradient", "glow", "neon"],
      PROFILE_PUB_FRAME_COLOR_2: ["double", "gradient", "neon"],
      PROFILE_PUB_LEVEL_COLOR: ["custom", "gradient", "striped"],
      PROFILE_PUB_LEVEL_COLOR_2: ["gradient"],
    };
    for (const [key, values] of Object.entries(expected)) {
      const def = byKey(key);
      expect(def, key).toBeDefined();
      expect([...(def!.dependsOnValues ?? [])], key).toEqual(values);
      // every named value must exist in the parent select
      const parent = byKey(def!.dependsOn!);
      const options = (parent?.options ?? []).map((o) => o.value);
      for (const v of values) expect(options, `${key} -> ${v}`).toContain(v);
    }
  });

  it("gives every link field its kind, so the hub can validate it", () => {
    const kinds: Record<string, string> = {
      PROFILE_PUB_LINK_GITHUB: "github",
      PROFILE_PUB_LINK_GITLAB: "gitlab",
      PROFILE_PUB_LINK_LINKEDIN: "linkedin",
      PROFILE_PUB_LINK_WEBSITE: "website",
      PROFILE_PUB_LINK_DISCORD: "discord",
    };
    for (const [key, kind] of Object.entries(kinds)) {
      expect(byKey(key)?.linkKind, key).toBe(kind);
    }
  });
});
