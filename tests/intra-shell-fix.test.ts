/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The Intra shell fix: below 768 px the v3 shell leaves its transparent
 * sidebar column (80 px wide, full height, fixed) over the left edge of the
 * page, and it swallowed every click and tap there, Cuter Intra's controls
 * included. jsdom cannot hit-test, so these check the rule itself and that it
 * matches the shell as the Intra bundle builds it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  INTRA_SHELL_FIX_CSS,
  INTRA_SHELL_FIX_ID,
  injectIntraShellFix,
} from "../src/core/intra/shell-fix.ts";
import { INTRA_SIDEBAR_COLUMN_SELECTOR } from "../src/core/intra/selectors.ts";
import {
  injectAvatarPendingRule,
  injectCustomStyles,
} from "../src/features/profile/header/visuals-apply.ts";
import { isOwnId } from "../src/core/lifecycle/own-ids.ts";
import { removeStaleInstance } from "../src/core/lifecycle/stale-instance.ts";

/** The shell as the Intra's index bundle renders it (vP inside div.App). */
function mountShell() {
  const app = document.createElement("div");
  app.className = "App";
  const column = document.createElement("div");
  column.className = "fixed top-0 flex flex-col items-center w-20 z-50";
  const tile = document.createElement("a");
  tile.href = "https://profile-v3.intra.42.fr";
  tile.className = "bg-[#4E5566] h-16 w-full flex items-center justify-center";
  const menu = document.createElement("div");
  menu.className = "md:left-0 relative sidebar-animation w-full left-[-100%]";
  column.append(tile, menu);
  const topbar = document.createElement("div");
  topbar.className = "fixed top-0 pl-20 h-16";
  const content = document.createElement("div");
  content.className = "content md:pl-20 pt-16 content-animation";
  const card = document.createElement("div");
  card.className = "fixed top-0 w-20"; // not a child of .App: never matched
  content.appendChild(card);
  app.append(column, topbar, content);
  document.body.appendChild(app);
  return { column, tile, menu, topbar, content, card };
}

const sheets = () => document.querySelectorAll(`#${INTRA_SHELL_FIX_ID}`);

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  // the <head>-less case leaves its sheet on <html>
  sheets().forEach((s) => s.remove());
});

describe("injectIntraShellFix", () => {
  it("lets taps through the column below 768 px, and keeps its children clickable", () => {
    injectIntraShellFix();
    const style = sheets()[0] as HTMLStyleElement;
    expect(style).toBeTruthy();
    const rules = [...style.sheet!.cssRules];
    expect(rules).toHaveLength(1);
    const media = rules[0] as CSSMediaRule;
    expect(media.media.mediaText).toBe("(max-width: 767px)");
    const inner = [...media.cssRules] as CSSStyleRule[];
    expect(inner.map((r) => [r.selectorText, r.style.pointerEvents])).toEqual([
      [INTRA_SIDEBAR_COLUMN_SELECTOR, "none"],
      [`${INTRA_SIDEBAR_COLUMN_SELECTOR} > *`, "auto"],
    ]);
  });

  it("targets the shell's column and nothing else", () => {
    const { column, tile, menu } = mountShell();
    expect([...document.querySelectorAll(INTRA_SIDEBAR_COLUMN_SELECTOR)]).toEqual([column]);
    expect([...document.querySelectorAll(`${INTRA_SIDEBAR_COLUMN_SELECTOR} > *`)]).toEqual([
      tile,
      menu,
    ]);
  });

  it("is installed once, on <html> when <head> is not parsed yet", () => {
    const head = document.head;
    head.remove();
    injectIntraShellFix();
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].parentElement).toBe(document.documentElement);
    injectIntraShellFix();
    expect(sheets()).toHaveLength(1);
    document.documentElement.insertBefore(head, document.body);
  });

  it("carries only the rule, as plain text", () => {
    injectIntraShellFix();
    expect(sheets()[0].textContent).toBe(INTRA_SHELL_FIX_CSS);
  });
});

describe("start-up", () => {
  it("comes with the document_start avatar rule on the profile origin, whatever the toggles", () => {
    // main.ts calls injectAvatarPendingRule() at document_start on profile-v3
    // before any feature is known to be on.
    injectAvatarPendingRule();
    expect(sheets()).toHaveLength(1);
    injectCustomStyles();
    injectAvatarPendingRule();
    expect(sheets()).toHaveLength(1);
  });

  it("is removed with the rest of an earlier instance after an add-on update", () => {
    expect(isOwnId(INTRA_SHELL_FIX_ID)).toBe(true);
    injectIntraShellFix();
    removeStaleInstance(document);
    expect(sheets()).toHaveLength(0);
  });
});
