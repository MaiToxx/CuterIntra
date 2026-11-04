/**
 * The friends widget as mounted on a profile page (friends.ui.ts), in
 * "intra" auth mode: keyboard access, failures that must not look like an
 * empty list or an unknown login, and a campus lookup that must not keep the
 * widget off the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/worker.ts", () => ({
  WORKER_URL: "https://worker.test",
  WORKER_HOST: "worker.test",
  WORKER_ORIGIN_PATTERN: "https://worker.test/*",
  AUTH_MODE: "intra",
}));
vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));
const mocks = vi.hoisted(() => ({
  token: "Bearer t" as string | null,
  getClusterData: vi.fn(async (_campus: string) => ({ clusters: [], screens: {} })),
}));
vi.mock("../src/features/account/account.ts", () => ({
  hashLogin: async (login: string) => `hashed-${login}`,
  loginWith42: () => {},
  clearAuthFailed: async () => {},
  syncToCloud: async () => true,
}));
vi.mock("../src/core/intra/intrapy.ts", () => ({
  waitForIntrapyToken: async () => mocks.token,
}));
vi.mock("../src/features/clusters/clusters.data.ts", () => ({
  CLUSTERS: [],
  getClusterData: mocks.getClusterData,
}));

/** login -> HTTP status of its intrapy /users call (200 by default). */
const statusOf = new Map<string, number>();

async function mount(): Promise<ShadowRoot> {
  vi.resetModules();
  const { injectFriendsWidget } = await import(
    "../src/features/friends/friends.ui"
  );
  await injectFriendsWidget();
  const host = document.getElementById("friends-widget-host");
  if (!host?.shadowRoot) throw new Error("widget not mounted");
  return host.shadowRoot;
}

const fab = (root: ShadowRoot) =>
  root.querySelector<HTMLButtonElement>(".friends-fab button")!;
const dropdown = (root: ShadowRoot) =>
  root.querySelector<HTMLElement>(".friends-dropdown")!;
const rowLogins = (root: ShadowRoot) =>
  [...root.querySelectorAll(".list-row .text-primary")].map((e) => e.textContent);
const text = (root: ShadowRoot) => root.textContent ?? "";
/** Wait for the load the panel starts when it opens (refresh icon at rest). */
const settled = (root: ShadowRoot) =>
  vi.waitFor(() =>
    expect(
      root.querySelector('button[aria-label="Refresh friends"].loading'),
    ).toBeNull(),
  );
const escape = (target: Element) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
  );
const storedList = async () =>
  JSON.parse(
    ((await chrome.storage.local.get("FRIENDS_LIST")).FRIENDS_LIST as string) ??
      "[]",
  ) as string[];

async function typeLogin(root: ShadowRoot, login: string) {
  root.querySelector<HTMLButtonElement>('button[aria-label="Add friend"]')!.click();
  const input = root.querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = login;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
  );
}

beforeEach(async () => {
  document.body.replaceChildren();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    CLOUD_TOKEN: "tok",
    CLOUD_LOGIN: "me",
    FRIENDS_LIST: JSON.stringify(["alice", "bob"]),
    CLUSTERS_CAMPUS: "mulhouse",
  });
  mocks.token = "Bearer t";
  statusOf.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("https://worker.test")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      const m = url.match(/\/users\/([^/]+)(\/.*)?$/);
      const login = m ? decodeURIComponent(m[1]) : "";
      const status = statusOf.get(login) ?? 200;
      if (status !== 200) return { ok: false, status, json: async () => ({}) };
      const body =
        m?.[2] === "/cursus"
          ? []
          : { displayname: login, profile_picture: `https://cdn.intra.42.fr/${login}.jpg` };
      return { ok: true, status, json: async () => body };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("campus lookup", () => {
  it("mounts the widget with its rows when the campus data cannot be loaded", async () => {
    mocks.getClusterData.mockRejectedValueOnce(
      new Error("Failed to fetch campus list"),
    );
    const root = await mount();
    expect(rowLogins(root)).toEqual(["alice", "bob"]);
  });

  it("does not probe every campus file when the campus is unknown", async () => {
    await chrome.storage.local.set({ CLUSTERS_CAMPUS: "" });
    mocks.getClusterData.mockClear();
    await mount();
    expect(mocks.getClusterData).not.toHaveBeenCalled();
  });
});

describe("keyboard and screen readers", () => {
  it("keeps the closed panel out of the Tab order and names the button", async () => {
    const root = await mount();
    expect(dropdown(root).hasAttribute("inert")).toBe(true);
    expect(dropdown(root).id).toBe("friends-dropdown");
    expect(fab(root).getAttribute("aria-expanded")).toBe("false");
    expect(fab(root).getAttribute("aria-controls")).toBe("friends-dropdown");
    expect(fab(root).getAttribute("aria-label")).toBe("Friends");
    expect(fab(root).querySelector(".swap")?.getAttribute("aria-hidden")).toBe("true");

    fab(root).click();
    expect(dropdown(root).hasAttribute("inert")).toBe(false);
    expect(fab(root).getAttribute("aria-expanded")).toBe("true");
    expect(fab(root).getAttribute("aria-label")).toBe("Close friends");
  });

  it("closes on Escape and gives focus back to the button", async () => {
    const root = await mount();
    fab(root).click();
    const refresh = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh friends"]',
    )!;
    refresh.focus();
    escape(refresh);
    expect(dropdown(root).hasAttribute("inert")).toBe(true);
    expect(root.activeElement).toBe(fab(root));
  });

  it("Escape in the add input closes the form first, then the panel", async () => {
    const root = await mount();
    fab(root).click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Add friend"]')!.click();
    const input = root.querySelector<HTMLInputElement>('input[type="text"]')!;
    escape(input);
    expect(root.querySelector('input[type="text"]')).toBeNull();
    expect(dropdown(root).hasAttribute("inert")).toBe(false);
    expect(root.activeElement).toBe(
      root.querySelector('button[aria-label="Add friend"]'),
    );
    escape(root.activeElement!);
    expect(dropdown(root).hasAttribute("inert")).toBe(true);
  });

  // The reconnect prompt itself is oauth mode's (friends-widget-oauth.test.ts).
  it("keeps the normal button when the Cuter Intra session expired", async () => {
    await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
    const root = await mount();
    expect(fab(root).getAttribute("aria-label")).toBe("Friends");
    expect(fab(root).getAttribute("aria-expanded")).toBe("false");
    expect(fab(root).classList.contains("btn-error")).toBe(false);
  });
});

describe("without a Cuter Intra sign-in", () => {
  // Nothing the widget loads in intra mode uses that session: the Intra is
  // read with the page's own session, the visuals route is public.
  it("loads the rows and offers Add when the session expired", async () => {
    await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
    const root = await mount();
    expect(rowLogins(root)).toEqual(["alice", "bob"]);
    fab(root).click();
    await settled(root);
    expect(text(root)).not.toContain("Session expired");
    expect(root.querySelector('button[aria-label="Add friend"]')).not.toBeNull();
  });

  it("loads the rows, and adds a friend, when never signed in", async () => {
    await chrome.storage.local.remove(["CLOUD_TOKEN", "CLOUD_LOGIN"]);
    const root = await mount();
    expect(rowLogins(root)).toEqual(["alice", "bob"]);
    fab(root).click();
    await settled(root);
    expect(text(root)).not.toContain("Connect with");
    await typeLogin(root, "carol");
    await vi.waitFor(() => expect(rowLogins(root)).toContain("carol"), { timeout: 8_000 });
    expect(await storedList()).toEqual(["alice", "bob", "carol"]);
  });
});

describe("adding a friend", () => {
  it("keeps the friend and offers Retry when the check fails", async () => {
    const root = await mount();
    fab(root).click();
    statusOf.set("newbie", 401); // expired Intra session
    await typeLogin(root, "newbie");

    await vi.waitFor(() => expect(text(root)).toContain("Could not check newbie"));
    expect(text(root)).not.toContain("User not found");
    expect(await storedList()).toEqual(["alice", "bob", "newbie"]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not check newbie",
    );

    statusOf.delete("newbie");
    const retry = [...root.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Retry",
    )!;
    retry.click();
    await vi.waitFor(() => expect(rowLogins(root)).toContain("newbie"));
    expect(text(root)).not.toContain("Could not check");
  });

  it("refuses a login only on a real 404, and keeps what was typed", async () => {
    const root = await mount();
    fab(root).click();
    statusOf.set("ghost", 404);
    await typeLogin(root, "ghost");

    await vi.waitFor(() => expect(text(root)).toContain("User not found."));
    expect(await storedList()).toEqual(["alice", "bob"]);
    expect(root.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "ghost",
    );
  });

  it("drops the pending login when a later check says it does not exist", async () => {
    const root = await mount();
    fab(root).click();
    await settled(root);
    mocks.token = null;
    await typeLogin(root, "typo");
    await vi.waitFor(() => expect(text(root)).toContain("Could not check typo"));

    mocks.token = "Bearer t";
    statusOf.set("typo", 404);
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Retry")!
      .click();
    await vi.waitFor(() => expect(text(root)).toContain("User not found."));
    expect(await storedList()).toEqual(["alice", "bob"]);
  });
});

describe("loading failures", () => {
  it("shows an error with Retry, not 'No friends yet', when nothing loads", async () => {
    mocks.token = null;
    const root = await mount();
    // the CI runner takes seconds for this first load: wait, do not assume
    await vi.waitFor(() => expect(text(root)).toContain("Could not load your friends"), {
      timeout: 8_000,
    });
    expect(text(root)).not.toContain("No friends yet");

    mocks.token = "Bearer t";
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Retry")!
      .click();
    await vi.waitFor(() => expect(rowLogins(root)).toEqual(["alice", "bob"]));
    expect(text(root)).not.toContain("Could not load");
  });

  it("a failed refresh keeps the rows and does not claim an update", async () => {
    const root = await mount();
    fab(root).click();
    const refresh = () =>
      root.querySelector<HTMLButtonElement>('button[aria-label="Refresh friends"]')!;
    const tipBefore = refresh().dataset.tip;

    mocks.token = null;
    refresh().click();
    await vi.waitFor(() =>
      expect(text(root)).toContain("Could not refresh everything"),
    );
    expect(rowLogins(root)).toEqual(["alice", "bob"]);
    expect(refresh().dataset.tip).toBe("Refresh failed (click to retry)");
    expect(tipBefore).toMatch(/^Updated /);
  });
});

describe("logins that cannot be shown can still be removed", () => {
  const button = (root: ShadowRoot, label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("offers Remove next to Retry when the check fails", async () => {
    const root = await mount();
    fab(root).click();
    statusOf.set("typo", 503);
    await typeLogin(root, "typo");
    await vi.waitFor(() => expect(text(root)).toContain("Could not check typo"));
    expect(await storedList()).toEqual(["alice", "bob", "typo"]);

    button(root, "Remove typo from my friends")!.click();
    await vi.waitFor(async () => expect(await storedList()).toEqual(["alice", "bob"]));
    expect(text(root)).not.toContain("Could not check");
  });

  it("lists a saved login the Intra does not know, with Remove", async () => {
    await chrome.storage.local.set({ FRIENDS_LIST: JSON.stringify(["alice", "typo", "bob"]) });
    statusOf.set("typo", 404);
    const root = await mount();
    fab(root).click();
    await vi.waitFor(() => expect(rowLogins(root)).toEqual(expect.arrayContaining(["alice", "bob"])));
    expect(text(root)).toContain("Not found on the Intra:");
    // nothing is deleted without asking
    expect(await storedList()).toEqual(["alice", "typo", "bob"]);

    button(root, "Remove typo from my friends")!.click();
    await vi.waitFor(async () => expect(await storedList()).toEqual(["alice", "bob"]));
    await vi.waitFor(() => expect(text(root)).not.toContain("Not found on the Intra"));
  });

  it("says nothing about logins a failed load could not reach", async () => {
    statusOf.set("bob", 503);
    const root = await mount();
    fab(root).click();
    await vi.waitFor(() => expect(text(root)).toContain("Could not refresh everything"));
    expect(text(root)).not.toContain("Not found on the Intra");
  });
});
