/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/users/bob" }
 *
 * Small guards added after the audit of 2026-11-22: what a viewer loads from
 * another student's profile, which tooltips may carry HTML, where an
 * achievement icon may come from, and three sanitizers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setPeerExternalImages, shownPeerVisuals } from "../src/features/profile/header/visuals";
import { WORKER_URL } from "../src/core/worker";
import { hasFaviconHost } from "../src/features/shortcuts/shortcuts.ui";
import { sanitizeFontFamily } from "../src/features/customize/customize";
import { sanitizePublicLook } from "../src/features/customize/public-look";
import { achievementIconUrl } from "../src/features/profile/cards/achievements";
import { bindTooltips, TOOLTIP_SHOW_DELAY } from "../src/core/dom/tooltip";
import type { VisualUrls } from "../src/features/profile/header/visuals-types";

describe("shownPeerVisuals", () => {
  const upload = `${WORKER_URL}/img/${"a".repeat(64)}/avatar?v=1`;
  const urls = {
    avatar: "https://tracker.example/a.png",
    banner: upload,
    background: "https://cdn.intra.42.fr/x.jpg",
    bannerColor: "#112233",
  } as VisualUrls;

  it("shows everything while the switch is on", () => {
    setPeerExternalImages(true);
    expect(shownPeerVisuals(urls)).toBe(urls);
  });

  it("with the switch off, keeps uploads and Intra images, drops images hosted elsewhere, leaves colours", () => {
    setPeerExternalImages(false);
    const shown = shownPeerVisuals(urls);
    expect(shown.avatar).toBe("");
    expect(shown.banner).toBe(upload);
    expect(shown.background).toBe("https://cdn.intra.42.fr/x.jpg");
    expect(shown.bannerColor).toBe("#112233");
    // a host that only looks like ours
    expect(shownPeerVisuals({ ...urls, avatar: "https://intra.42.fr.evil.example/a.png" }).avatar).toBe("");
    setPeerExternalImages(true);
  });
});

describe("hasFaviconHost", () => {
  it("is true for a full web address only", () => {
    expect(hasFaviconHost("https://github.com/x")).toBe(true);
    for (const no of ["", "https://", "github", "https://git", "javascript:alert(1)", "ftp://a.b/"]) {
      expect(hasFaviconHost(no), no).toBe(false);
    }
  });
});

describe("sanitizeFontFamily", () => {
  it("keeps a font list and takes out what could open a comment or a function", () => {
    expect(sanitizeFontFamily('"Fira Code", monospace')).toBe('"Fira Code", monospace');
    expect(sanitizeFontFamily("Arial /* x */; } body { color: red")).toBe("Arial  x   body  color: red");
    expect(sanitizeFontFamily("url(https://evil.example/f)")).not.toContain("(");
  });
});

describe("sanitizePublicLook", () => {
  it("refuses an enum value that is only an inherited property name", () => {
    const look = sanitizePublicLook({ CUSTOM_PAGE_BG_PRESET: "constructor", CUSTOM_ACCENT: "#ff0000" });
    expect(look && "CUSTOM_PAGE_BG_PRESET" in look).toBeFalsy();
  });
});

describe("achievementIconUrl", () => {
  it("accepts an https Intra host, a relative path included, and nothing else", () => {
    expect(achievementIconUrl("https://cdn.intra.42.fr/achievement/1.svg")).toBe(
      "https://cdn.intra.42.fr/achievement/1.svg",
    );
    expect(achievementIconUrl("/uploads/achievement/1.svg")).toBe(
      "https://profile-v3.intra.42.fr/uploads/achievement/1.svg",
    );
    for (const no of ["https://evil.example/1.svg", "http://cdn.intra.42.fr/1.svg", "javascript:alert(1)", "", null]) {
      expect(achievementIconUrl(no), String(no)).toBeNull();
    }
  });
});

describe("data-tip-html", () => {
  const hover = async (el: Element) => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, TOOLTIP_SHOW_DELAY + 80));
  };
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById("ft-floating-tooltip")?.remove();
  });

  it("is rendered for our own nodes and ignored on the Intra's", async () => {
    bindTooltips(document, () => true);
    const theirs = document.createElement("div");
    theirs.dataset.tipHtml = '<b id="injected">x</b>';
    const ours = document.createElement("div");
    ours.id = "ft-something";
    const inner = document.createElement("span");
    inner.dataset.tipHtml = '<b id="wanted">y</b>';
    ours.appendChild(inner);
    document.body.append(theirs, ours);

    await hover(theirs);
    expect(document.querySelector("#injected")).toBeNull();
    await hover(inner);
    expect(document.querySelector("#wanted")).not.toBeNull();
  });
});
