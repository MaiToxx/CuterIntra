/**
 * The friends widget in the dormant "oauth" auth mode, where the list comes
 * from the worker's friends endpoint with the Cuter Intra session: signed
 * out it shows Connect, with that session expired it turns into a reconnect
 * button. Intra mode needs neither (friends-widget.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/worker.ts", () => ({
  WORKER_URL: "https://worker.test",
  WORKER_HOST: "worker.test",
  WORKER_ORIGIN_PATTERN: "https://worker.test/*",
  AUTH_MODE: "oauth",
}));
vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));
vi.mock("../src/features/account/account.ts", () => ({
  hashLogin: async (login: string) => `hashed-${login}`,
  loginWith42: () => {},
  clearAuthFailed: async () => {},
  syncToCloud: async () => true,
}));
vi.mock("../src/features/clusters/clusters.data.ts", () => ({
  CLUSTERS: [],
  getClusterData: async () => ({ clusters: [], screens: {} }),
}));

async function mount(): Promise<ShadowRoot> {
  vi.resetModules();
  const { injectFriendsWidget } = await import("../src/features/friends/friends.ui");
  await injectFriendsWidget();
  const host = document.getElementById("friends-widget-host");
  if (!host?.shadowRoot) throw new Error("widget not mounted");
  return host.shadowRoot;
}
const fab = (root: ShadowRoot) =>
  root.querySelector<HTMLButtonElement>(".friends-fab button")!;
const text = (root: ShadowRoot) => root.textContent ?? "";

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ friends: [] }),
}));

beforeEach(async () => {
  document.body.replaceChildren();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ FRIENDS_LIST: JSON.stringify(["alice"]) });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("friends widget, oauth mode", () => {
  it("signed out: offers Connect and asks the worker nothing", async () => {
    const root = await mount();
    fab(root).click();
    expect(text(root)).toContain("Connect with");
    expect(root.querySelector('button[aria-label="Add friend"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("session expired: the button becomes a reconnect prompt", async () => {
    await chrome.storage.local.set({
      CLOUD_TOKEN: "tok",
      CLOUD_LOGIN: "me",
      CLOUD_AUTH_FAILED: true,
    });
    const root = await mount();
    expect(fab(root).getAttribute("aria-label")).toBe(
      "Friends: session expired, reconnect",
    );
    expect(fab(root).hasAttribute("aria-expanded")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
