import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mountIdentity,
  showGreeting,
  unmountIdentity,
} from "../src/features/profile/extras/extras-identity";
import {
  EXTRAS_IDENTITY_ID,
  type ProfileExtras,
} from "../src/features/profile/extras/extras";

const TOAST_ID = "ft-egg-toast";

function makeExtras(over: Partial<ProfileExtras> = {}): ProfileExtras {
  return {
    bio: "",
    statusEmoji: "",
    statusText: "",
    pronouns: "",
    flair: [],
    greeting: "",
    links: [],
    nameStyle: "default",
    nameColor: "#00babc",
    nameColor2: "#7c3aed",
    nameFont: "default",
    frame: "none",
    frameColor: "#00babc",
    frameColor2: "#7c3aed",
    levelStyle: "default",
    levelColor: "#00babc",
    levelColor2: "#7c3aed",
    bannerGradient: "none",
    bannerDim: 0,
    bannerBlur: 0,
    cardGlow: false,
    effect: "none",
    effectIntensity: "medium",
    effectColor: "",
    ...over,
  };
}

/** Header of a v3 profile, as far as the identity block is concerned. */
function buildHeader(login = "bob"): HTMLParagraphElement {
  const card = document.createElement("div");
  card.className = "ft-profile-card";
  const column = document.createElement("div");
  const name = document.createElement("h2");
  name.className = "text-2xl";
  name.textContent = "Bob Martin";
  const loginLine = document.createElement("p");
  loginLine.className = "text-sm";
  loginLine.textContent = login;
  column.append(name, loginLine);
  card.append(column);
  document.body.append(card);
  return loginLine;
}

const block = () => document.getElementById(EXTRAS_IDENTITY_ID);
const blocks = () => document.querySelectorAll(`[id="${EXTRAS_IDENTITY_ID}"]`);
const visitor = { login: "bob", own: false };

beforeEach(() => {
  unmountIdentity();
  document.body.replaceChildren();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mountIdentity", () => {
  it("inserts the block right after the login line, with every part as text", () => {
    const loginLine = buildHeader();
    mountIdentity(
      makeExtras({
        statusEmoji: "🚀",
        statusText: "Shipping minishell",
        pronouns: "they/them",
        bio: "C enjoyer, segfault collector.",
        flair: ["🦀", "🐧", "☕"],
      }),
      visitor,
    );

    const el = block()!;
    expect(el).not.toBeNull();
    expect(el.previousElementSibling).toBe(loginLine);
    expect(el.parentElement).toBe(loginLine.parentElement);
    expect(el.getAttribute("role")).toBe("note");
    expect(el.title).toBe("Added by bob with Cuter Intra");

    const status = el.querySelector(".ft-x-status")!;
    expect(status.textContent).toContain("🚀");
    expect(status.textContent).toContain("Shipping minishell");
    expect(el.querySelector(".ft-x-pronouns")!.textContent).toBe("they/them");
    expect(el.querySelector(".ft-x-bio")!.textContent).toBe(
      "C enjoyer, segfault collector.",
    );
    const flair = Array.from(el.querySelectorAll(".ft-x-flair > span")).map(
      (s) => s.textContent,
    );
    expect(flair).toEqual(["🦀", "🐧", "☕"]);
    expect(el.querySelector(".ft-x-links")).toBeNull();

    // the stylesheet is scoped to the block
    expect(el.querySelector("style")!.textContent).toContain(
      `#${EXTRAS_IDENTITY_ID}`,
    );
  });

  it("renders markup typed by a stranger as plain text", () => {
    buildHeader();
    const bio = "<img src=x onerror=alert(1)>";
    mountIdentity(
      makeExtras({
        bio,
        statusText: "<script>alert(2)</script>",
        pronouns: "<b>bold</b>",
        flair: ["<i>x</i>"],
        links: [
          { kind: "github", label: "<svg onload=alert(3)>", href: "https://github.com/bob" },
        ],
      }),
      visitor,
    );

    const el = block()!;
    expect(el.querySelector(".ft-x-bio")!.textContent).toBe(bio);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b, i")).toBeNull();
    expect(el.querySelector(".ft-x-label")!.textContent).toBe("<svg onload=alert(3)>");
    // the only svg elements are our own icons, none carries a handler
    for (const svg of el.querySelectorAll("svg")) {
      expect(svg.parentElement!.classList.contains("ft-x-ico")).toBe(true);
      expect(svg.getAttribute("onload")).toBeNull();
    }
  });

  it("renders links as safe anchors and a Discord handle as a copy button", () => {
    buildHeader();
    mountIdentity(
      makeExtras({
        links: [
          { kind: "github", label: "bob", href: "https://github.com/bob" },
          { kind: "website", label: "bob.dev", href: "https://bob.dev/" },
          { kind: "linkedin", label: "bob-martin", href: "https://www.linkedin.com/in/bob-martin" },
          { kind: "discord", label: "bob#0042", href: "" },
        ],
      }),
      visitor,
    );

    const el = block()!;
    const anchors = Array.from(el.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/bob",
      "https://bob.dev/",
      "https://www.linkedin.com/in/bob-martin",
    ]);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(a.getAttribute("title")).toBe(a.getAttribute("href"));
      expect(a.querySelector(".ft-x-ico svg")).not.toBeNull();
    }
    expect(anchors[0].querySelector(".ft-x-label")!.textContent).toBe("bob");
    // the stroke-only globe must not be filled like the solid icons
    expect(anchors[1].querySelector(".ft-x-ico")!.hasAttribute("data-outlined")).toBe(true);
    expect(anchors[0].querySelector(".ft-x-ico")!.hasAttribute("data-outlined")).toBe(false);

    const button = el.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-kind")).toBe("discord");
    expect(button.hasAttribute("href")).toBe(false);
    expect(button.querySelector(".ft-x-label")!.textContent).toBe("bob#0042");
    expect(el.querySelectorAll("a, button").length).toBe(4);
  });

  it("drops a link whose href is not a plain https URL", () => {
    buildHeader();
    mountIdentity(
      makeExtras({
        links: [
          { kind: "website", label: "js", href: "javascript:alert(1)" },
          { kind: "website", label: "plain", href: "http://bob.dev/" },
          { kind: "website", label: "data", href: "data:text/html,<script>alert(1)</script>" },
          { kind: "github", label: "creds", href: "https://github.com@evil.example/" },
          { kind: "gitlab", label: "", href: "https://gitlab.com/bob" },
          { kind: "gitlab", label: "ok", href: "https://gitlab.com/bob" },
        ],
      }),
      visitor,
    );

    const el = block()!;
    const anchors = Array.from(el.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://gitlab.com/bob"]);
    // a refused href must not come back as a "copy" pill either
    expect(el.querySelector("button")).toBeNull();
  });

  it("falls back to the generic icon for a kind it does not know", () => {
    buildHeader();
    mountIdentity(
      makeExtras({
        links: [{ kind: "constructor" as never, label: "x", href: "https://example.com/" }],
      }),
      visitor,
    );
    const a = block()!.querySelector("a")!;
    expect(a.getAttribute("data-kind")).toBe("link");
    expect(a.querySelector("svg")).not.toBeNull();
  });

  it("copies the Discord handle and says so for 1.5 s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      buildHeader();
      mountIdentity(
        makeExtras({ links: [{ kind: "discord", label: "bob#0042", href: "" }] }),
        visitor,
      );
      const label = () => block()!.querySelector("button .ft-x-label")!.textContent;

      block()!.querySelector("button")!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledWith("bob#0042");
      expect(label()).toBe("Copied");

      await vi.advanceTimersByTimeAsync(1499);
      expect(label()).toBe("Copied");
      await vi.advanceTimersByTimeAsync(1);
      expect(label()).toBe("bob#0042");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("does not claim a copy the clipboard refused", async () => {
    // jsdom has no navigator.clipboard: writeText throws inside the try
    buildHeader();
    mountIdentity(
      makeExtras({ links: [{ kind: "discord", label: "bob#0042", href: "" }] }),
      visitor,
    );
    block()!.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(block()!.querySelector("button .ft-x-label")!.textContent).toBe("bob#0042");
  });

  it("removes the block on null and when there is nothing to show", () => {
    buildHeader();
    mountIdentity(makeExtras({ bio: "hello" }), visitor);
    expect(block()).not.toBeNull();

    mountIdentity(null, visitor);
    expect(block()).toBeNull();

    mountIdentity(makeExtras({ bio: "hello" }), visitor);
    expect(block()).not.toBeNull();

    // style-only extras: the identity part is empty
    mountIdentity(
      makeExtras({ bio: "   ", flair: ["", " "], greeting: "hi", nameStyle: "rainbow" }),
      visitor,
    );
    expect(block()).toBeNull();
    // and it stays away on the following passes
    mountIdentity(
      makeExtras({ bio: "   ", flair: ["", " "], greeting: "hi", nameStyle: "rainbow" }),
      visitor,
    );
    expect(block()).toBeNull();
  });

  it("is idempotent: same data keeps the same node and never duplicates it", () => {
    buildHeader();
    const extras = makeExtras({ bio: "hello", flair: ["🦀"] });
    mountIdentity(extras, visitor);
    const first = block()!;
    const bioNode = first.querySelector(".ft-x-bio");

    mountIdentity(extras, visitor);
    // an equal copy (the orchestrator may rebuild the object) is the same data
    mountIdentity(makeExtras({ bio: "hello", flair: ["🦀"] }), visitor);

    expect(blocks().length).toBe(1);
    expect(block()).toBe(first);
    expect(first.querySelector(".ft-x-bio")).toBe(bioNode);
  });

  it("updates in place when the data changes", () => {
    buildHeader();
    mountIdentity(makeExtras({ bio: "hello" }), visitor);
    const first = block()!;
    mountIdentity(makeExtras({ bio: "bye", pronouns: "she/her" }), visitor);

    expect(blocks().length).toBe(1);
    expect(block()).toBe(first);
    expect(first.querySelector(".ft-x-bio")!.textContent).toBe("bye");
    expect(first.querySelector(".ft-x-pronouns")!.textContent).toBe("she/her");

    mountIdentity(makeExtras({ bio: "bye", pronouns: "she/her" }), { login: "alice", own: false });
    expect(block()!.title).toBe("Added by alice with Cuter Intra");
  });

  it("puts the block back when React dropped it or rebuilt the header", () => {
    const loginLine = buildHeader();
    const extras = makeExtras({ bio: "hello" });
    mountIdentity(extras, visitor);
    const first = block()!;

    first.remove();
    expect(block()).toBeNull();
    mountIdentity(extras, visitor);
    expect(block()).toBe(first);
    expect(first.previousElementSibling).toBe(loginLine);
    expect(first.querySelector(".ft-x-bio")!.textContent).toBe("hello");

    // React inserted a sibling between the login line and the block
    const intruder = document.createElement("span");
    loginLine.after(intruder);
    mountIdentity(extras, visitor);
    expect(first.previousElementSibling).toBe(loginLine);

    // the whole header was replaced
    document.body.replaceChildren();
    const newLoginLine = buildHeader();
    mountIdentity(extras, visitor);
    expect(blocks().length).toBe(1);
    expect(block()).toBe(first);
    expect(first.previousElementSibling).toBe(newLoginLine);
  });

  it("waits for the login line, and prefers the one of the profile card", () => {
    const extras = makeExtras({ bio: "hello" });
    expect(() => mountIdentity(extras, visitor)).not.toThrow();
    expect(block()).toBeNull();

    const decoy = document.createElement("p");
    decoy.className = "text-sm";
    decoy.textContent = "not the login";
    document.body.append(decoy);
    const loginLine = buildHeader();

    mountIdentity(extras, visitor);
    expect(block()!.previousElementSibling).toBe(loginLine);
    expect(decoy.nextElementSibling).not.toBe(block());
  });

  it("falls back to the first login-like line outside a profile card", () => {
    const loginLine = document.createElement("p");
    loginLine.className = "text-sm";
    loginLine.textContent = "bob";
    const wrapper = document.createElement("div");
    wrapper.append(loginLine);
    document.body.append(wrapper);

    mountIdentity(makeExtras({ bio: "hello" }), visitor);
    expect(block()!.previousElementSibling).toBe(loginLine);
  });

  it("replaces a block left behind by another instance of the extension", () => {
    const loginLine = buildHeader();
    const stale = document.createElement("div");
    stale.id = EXTRAS_IDENTITY_ID;
    stale.textContent = "stale";
    loginLine.after(stale);

    mountIdentity(makeExtras({ bio: "fresh" }), visitor);
    expect(blocks().length).toBe(1);
    expect(block()).not.toBe(stale);
    expect(block()!.textContent).toContain("fresh");
  });

  it("unmountIdentity removes the block and forgets the memo", () => {
    buildHeader();
    const extras = makeExtras({ bio: "hello" });
    mountIdentity(extras, visitor);
    const first = block()!;

    unmountIdentity();
    expect(block()).toBeNull();

    mountIdentity(extras, visitor);
    expect(block()).not.toBeNull();
    expect(block()).not.toBe(first);
    expect(block()!.querySelector(".ft-x-bio")!.textContent).toBe("hello");
  });
});

describe("showGreeting", () => {
  const toastEl = () => document.getElementById(TOAST_ID);

  it("greets a visitor once per session and per login", () => {
    const extras = makeExtras({ greeting: "Welcome to my page" });
    showGreeting(extras, { login: "greeter-a", own: false });
    expect(toastEl()).not.toBeNull();
    expect(toastEl()!.textContent).toContain("greeter-a wrote on their profile: “Welcome to my page”");
    expect(sessionStorage.getItem("ft-greeted-greeter-a")).toBe("1");

    toastEl()!.remove();
    showGreeting(extras, { login: "greeter-a", own: false });
    expect(toastEl()).toBeNull();

    // another profile still greets
    showGreeting(extras, { login: "greeter-b", own: false });
    expect(toastEl()!.textContent).toContain("greeter-b wrote on their profile: “Welcome to my page”");
  });

  it("honours the session flag left by an earlier page load", () => {
    sessionStorage.setItem("ft-greeted-greeter-c", "1");
    showGreeting(makeExtras({ greeting: "hi" }), { login: "greeter-c", own: false });
    expect(toastEl()).toBeNull();
  });

  it("never greets on one's own profile, nor without a greeting", () => {
    showGreeting(makeExtras({ greeting: "hi me" }), { login: "greeter-d", own: true });
    expect(toastEl()).toBeNull();
    expect(sessionStorage.getItem("ft-greeted-greeter-d")).toBeNull();

    showGreeting(makeExtras({ greeting: "  " }), { login: "greeter-e", own: false });
    showGreeting(null, { login: "greeter-e", own: false });
    expect(toastEl()).toBeNull();
    // an empty greeting must not use up the visitor's one greeting
    showGreeting(makeExtras({ greeting: "now there is one" }), { login: "greeter-e", own: false });
    expect(toastEl()).not.toBeNull();
  });

  it("renders the greeting as text", () => {
    showGreeting(makeExtras({ greeting: "<img src=x onerror=alert(1)>" }), {
      login: "greeter-f",
      own: false,
    });
    expect(toastEl()!.querySelector("img")).toBeNull();
    expect(toastEl()!.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("still greets once when sessionStorage is blocked", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const extras = makeExtras({ greeting: "hi" });
      showGreeting(extras, { login: "greeter-g", own: false });
      expect(toastEl()).not.toBeNull();
      toastEl()!.remove();
      showGreeting(extras, { login: "greeter-g", own: false });
      expect(toastEl()).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });
});
