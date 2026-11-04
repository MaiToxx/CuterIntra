/**
 * Cuter Intra's own widgets at phone widths (and, for some, narrow desktop
 * windows). jsdom does no layout, so these pin the rules that keep each one
 * inside its card, measured in Chrome on a copy of the real Intra page:
 *  - the friends panel header held the online filter, four sort buttons and
 *    refresh on one line, all shrink-0: below ~410 px refresh fell outside
 *    the panel;
 *  - the logtime carousel put two 34 px arrows beside the 280 px month card:
 *    below ~444 px the slider clipped them and the month could not change.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { html, render } from "lit-html";
import { renderWidget } from "../src/features/friends/friends-panel.ts";
import type { WidgetState } from "../src/features/friends/friends-widget-state.ts";
import type { FriendData } from "../src/features/friends/friends-types.ts";
import { renderCarouselView } from "../src/features/logtime/render.ts";

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function friend(login: string): FriendData {
  return {
    login,
    displayName: login,
    avatar: null,
    customAvatar: null,
    level: 7,
    grade: "Member",
    isOnline: true,
    lastSeen: "e1r1p1",
    poolLabel: null,
    wallet: 3,
    correctionPoints: 2,
    lastOnlineTimestamp: null,
  };
}

function widgetState(): WidgetState {
  const noop = () => {};
  return {
    open: true,
    loading: false,
    loadError: false,
    friends: [friend("alice"), friend("bob")],
    detailed: true,
    sortBy: "level",
    sortDir: "desc",
    onlineOnly: false,
    addInput: "",
    addLoading: false,
    addError: "",
    addPending: null,
    missingLogins: [],
    addOpen: false,
    lastFetch: null,
    theme: "dark",
    needsReconnect: false,
    notConnected: false,
    deleteMode: false,
    selected: [],
    showCustomAvatars: false,
    onToggle: noop,
    onRefresh: noop,
    onSortChange: noop,
    onToggleOnline: noop,
    onDeleteMode: noop,
    onToggleSelect: noop,
    onConfirmDelete: noop,
    onCancelDelete: noop,
    onInputChange: noop,
    onAdd: noop,
    onRetryAdd: noop,
    onCancelAdd: noop,
    onRemoveMissing: noop,
    onToggleAdd: noop,
    onConnect: noop,
    onAvatarToggle: noop,
  };
}

/** The rules of `css` as jsdom parses them. */
function parse(css: string): CSSRule[] {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return [...style.sheet!.cssRules];
}
const styleRule = (rules: CSSRule[], selector: string) =>
  rules.find((r) => (r as CSSStyleRule).selectorText === selector) as
    | CSSStyleRule
    | undefined;

describe("friends panel header", () => {
  it("wraps its controls instead of pushing refresh out of the panel", () => {
    const host = document.createElement("div");
    render(renderWidget(widgetState()), host);
    const header = host.querySelector<HTMLElement>(".friends-header")!;
    expect(header).not.toBeNull();
    expect(header.classList.contains("flex-wrap")).toBe(true);
    expect(header.querySelector('[aria-label="Refresh friends"]')).not.toBeNull();
    // The sort group keeps its width: squeezed, its hidden scrollbar hid
    // two or three of the four buttons without a sign they were there.
    const sortGroup = header.querySelector(".no-scrollbar")!;
    expect(sortGroup.classList.contains("shrink-0")).toBe(true);
    expect(sortGroup.querySelectorAll("button")).toHaveLength(4);
  });
});

describe("logtime carousel", () => {
  const css = readFileSync(
    path.resolve(__dirname, "../src/features/logtime/logtime.css"),
    "utf8",
  );

  it("puts the arrows under the month card below 480 px", () => {
    const rules = parse(css);
    const narrow = rules.filter(
      (r) => (r as CSSMediaRule).media?.mediaText === "(max-width: 479px)",
    ) as CSSMediaRule[];
    expect(narrow).toHaveLength(1);
    const inner = [...narrow[0].cssRules];
    expect(styleRule(inner, ".lt-carousel")?.style.flexWrap).toBe("wrap");
    const stage = styleRule(inner, ".lt-carousel-stage")!;
    expect(stage.style.order).toBe("-1");
    expect(stage.style.flexBasis).toBe("100%");
  });

  it("leaves wider layouts alone: the card stays 280 px, the arrows beside it", () => {
    const rules = parse(css);
    expect(styleRule(rules, ".month-card")?.style.width).toBe("280px");
    expect(styleRule(rules, ".lt-carousel")?.style.flexWrap).toBe("");
    expect(styleRule(rules, ".lt-carousel .month-card")?.style.width).toBe("");
  });

  it("keeps Previous first in the DOM, so Tab and the tests still meet it first", () => {
    const host = document.createElement("div");
    render(
      renderCarouselView(html`<div class="month-card"></div>`, {
        canPrev: true,
        canNext: true,
        prevLabel: "prev",
        nextLabel: "next",
        loading: false,
        onPrev: () => {},
        onNext: () => {},
      }),
      host,
    );
    const children = [...host.querySelector(".lt-carousel")!.children];
    expect(children.map((c) => c.getAttribute("aria-label") ?? c.className)).toEqual([
      "Previous month",
      "lt-carousel-stage",
      "Next month",
    ]);
  });
});
