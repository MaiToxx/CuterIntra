/**
 * The footer of the settings hub: the cloud account entry (Sign in with 42
 * and what signing in is for when signed out, Signed in as + Sign out when
 * signed in), the push mode, and what the hub says about a change: "Reload
 * to apply" for a setting the page applies at the next load, one automatic
 * push per burst of changes when Auto push is on, a failed push reported
 * instead of swallowed by the reload and tried again, "Push now" in Manual.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("../src/features/hub/controls/context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/hub/controls/context.ts")>()),
  loadLiveOptions: vi.fn(async () => ({ campuses: [], eventTypes: [] })),
}));

const account = {
  PUSH_FAILURE_KEY: "CLOUD_PUSH_FAILURE",
  clearAuthFailed: vi.fn(async () => {}),
  loginWith42: vi.fn(async () => {}),
  logoutCloud: vi.fn(async () => true),
  syncToCloud: vi.fn(async () => true),
  // a string: the hub must cope with reasons it does not know yet
  pushSettings: vi.fn(async (_options?: { force?: boolean }): Promise<string> => "ok"),
  getPushFailure: vi.fn(async (): Promise<{ reason: string } | null> => null),
  describeCloudFailure: vi.fn((reason: string) => `failure: ${reason}`),
  pullSettings: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
};
vi.mock("../src/features/account/account.ts", () => account);

const publish = vi.hoisted(() => ({ flushLookPublish: vi.fn(async () => {}) }));
vi.mock("../src/features/customize/publish.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/customize/publish.ts")>()),
  flushLookPublish: publish.flushLookPublish,
}));

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const listeners: Listener[] = [];
const reload = vi.fn();

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal: () => void;
    close: () => void;
  };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  (window as unknown as { matchMedia: unknown }).matchMedia ??= vi.fn(() => ({ matches: true }));
  (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
    addListener: (fn: Listener) => listeners.push(fn),
    removeListener: vi.fn(),
  };
  const url = new URL("https://profile-v3.intra.42.fr/");
  const loc = {
    href: url.href,
    protocol: url.protocol,
    hostname: url.hostname,
    host: url.host,
    origin: url.origin,
    pathname: url.pathname,
    search: "",
    hash: "",
    reload,
  };
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true });
  Object.defineProperty(globalThis, "location", { value: loc, writable: true, configurable: true });
});

let AUTO_PUSH_DELAY_MS = 1000;
let AUTO_PUSH_RETRY_MS: readonly number[] = [];

// the first import of the hub pulls in every tab module: not on a test's clock
beforeAll(async () => {
  ({ AUTO_PUSH_DELAY_MS, AUTO_PUSH_RETRY_MS } = await import(
    "../src/features/hub/hubSettings.ui.ts"
  ));
}, 30000);

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A fresh hub for the stored state: the module builds it once per document. */
async function openHub(): Promise<{ dialog: HTMLDialogElement; shadow: ShadowRoot }> {
  document.getElementById("hub-dialog")?.remove();
  const { openHubModal } = await import("../src/features/hub/hubSettings.ui.ts");
  await openHubModal(["profile", "logtime"]);
  await settle();
  const dialog = document.getElementById("hub-dialog") as HTMLDialogElement;
  return { dialog, shadow: dialog.querySelector("#hub-shadow-wrapper")!.shadowRoot! };
}

/** What chrome.storage.onChanged would deliver for one write. */
function storageChanged(changes: Record<string, unknown>) {
  const payload = Object.fromEntries(
    Object.entries(changes).map(([k, v]) => [k, { newValue: v }]),
  );
  for (const fn of listeners) fn(payload, "local");
}

/** The buttons of the footer (the Calendar card has a Connect button of its own). */
const buttons = (shadow: ShadowRoot) =>
  [...shadow.querySelectorAll("#hub-footer button, .alert button")].map((b) =>
    b.textContent!.replace(/\s+/g, " ").trim(),
  );

beforeEach(async () => {
  await chrome.storage.local.clear();
  listeners.length = 0;
  reload.mockClear();
  account.syncToCloud.mockClear();
  account.syncToCloud.mockImplementation(async () => true);
  account.pushSettings.mockReset();
  account.pushSettings.mockImplementation(async () => "ok");
  account.loginWith42.mockClear();
  account.getPushFailure.mockReset();
  account.getPushFailure.mockImplementation(async () => null);
  account.pullSettings.mockReset();
  account.pullSettings.mockImplementation(async () => ({ ok: true }));
  publish.flushLookPublish.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud account entry", () => {
  it("signed out: the footer offers Sign in with 42, and it starts the login", async () => {
    const { dialog, shadow } = await openHub();
    expect(buttons(shadow)).toContain("Sign in with 42");
    expect(buttons(shadow)).not.toContain("Sign out");
    // nothing that is not a button looks like one any more
    expect(shadow.querySelector("#hub-footer span.btn")).toBeNull();

    const connect = [...shadow.querySelectorAll("#hub-footer button")].find(
      (b) => b.textContent!.trim() === "Sign in with 42",
    ) as HTMLButtonElement;
    connect.click();
    expect(dialog.open).toBe(false);
    expect(account.loginWith42).toHaveBeenCalledTimes(1);
  });

  it("signed out: says what signing in is for, where it goes, and links the privacy policy", async () => {
    const { shadow } = await openHub();
    const connect = [...shadow.querySelectorAll<HTMLButtonElement>("#hub-footer button")].find(
      (b) => b.textContent!.trim() === "Sign in with 42",
    )!;
    // an invitation, not the error colour
    expect(connect.classList.contains("btn-error")).toBe(false);
    expect(connect.classList.contains("btn-primary")).toBe(true);
    const about = shadow.getElementById(connect.getAttribute("aria-describedby")!)!;
    expect(about.textContent).toMatch(/Optional/);
    expect(about.textContent).toContain("api.betterintra.com");
    const privacy = about.querySelector("a")!;
    expect(privacy.textContent!.trim()).toBe("Privacy");
    expect(privacy.getAttribute("href")).toBe(
      "https://github.com/test/better-intra/blob/main/PRIVACY.md",
    );
    expect(privacy.getAttribute("rel")).toContain("noopener");
    // "Never synced" said nothing to someone who never wanted the cloud
    expect(shadow.querySelector("#hub-sync-status")).toBeNull();
    expect(shadow.querySelector("#hub-push-now")).toBeNull();
  });

  it("signed in: Signed in as <login>, a Sign out and the sync badge, no sign-in button", async () => {
    await chrome.storage.local.set({ CLOUD_TOKEN: "t", CLOUD_LOGIN: "xlogin" });
    const { shadow } = await openHub();
    expect(buttons(shadow)).not.toContain("Sign in with 42");
    expect(buttons(shadow)).toContain("Sign out");
    expect(shadow.textContent).toContain("Signed in as xlogin");
    expect(shadow.querySelector("#hub-sync-status")!.textContent).toBe("Never synced");
    expect(shadow.querySelector("#hub-cloud-about")).toBeNull();
  });

  it("expired sign-in: only the banner's Sign in again starts a login", async () => {
    await chrome.storage.local.set({ CLOUD_AUTH_FAILED: true });
    const { dialog, shadow } = await openHub();
    const banner = shadow.querySelector("[data-hub-auth-banner]")!;
    expect(banner.textContent).toMatch(/sign-in expired/);
    expect(buttons(shadow)).toContain("Sign in again");
    expect(buttons(shadow)).not.toContain("Sign in with 42");
    (banner.querySelector("button") as HTMLButtonElement).click();
    expect(dialog.open).toBe(false);
    expect(account.loginWith42).toHaveBeenCalledTimes(1);
  });

  it("the sync badge says when, with the day once it is not today", async () => {
    const { formatSyncStatus } = await import("../src/features/hub/hubSettings.ui.ts");
    const now = new Date(2026, 8, 22, 15, 0);
    expect(formatSyncStatus(null, now)).toBe("Never synced");
    expect(formatSyncStatus("garbage", now)).toBe("Never synced");
    // the time is in the viewer's locale: 14:03 here, 02:03 PM on a US runner
    const today = formatSyncStatus(new Date(2026, 8, 22, 14, 3).getTime(), now);
    expect(today).toMatch(/^Synced at /);
    expect(today).toContain("03");
    expect(today).not.toContain("22");
    const older = formatSyncStatus(new Date(2026, 8, 12, 14, 3).getTime(), now);
    expect(older).toMatch(/^Synced /);
    expect(older).toContain("12");
    expect(older).not.toMatch(/^Synced at/);
  });
});

describe("reload hint", () => {
  it("a setting the page does not apply live lights up 'Reload to apply'", async () => {
    const { shadow } = await openHub();
    const hint = shadow.querySelector<HTMLElement>("#hub-reload-hint")!;
    expect(hint.classList.contains("hidden")).toBe(true);
    storageChanged({ PROFILE_USE_MODERN_INFO_CARD: false });
    expect(hint.classList.contains("hidden")).toBe(false);
    expect(hint.textContent).toBe("Reload to apply");
    expect(shadow.querySelector("#hub-reload")!.classList.contains("btn-warning")).toBe(true);
  });

  it("a live setting (Customize) leaves it hidden", async () => {
    const { shadow } = await openHub();
    storageChanged({ CUSTOM_HIDE_FOOTER: true, BETTER_INTRA_THEME: "light" });
    expect(shadow.querySelector("#hub-reload-hint")!.classList.contains("hidden")).toBe(true);
  });

  it("the session and the caches are not settings: no hint", async () => {
    const { shadow } = await openHub();
    storageChanged({ LAST_CLOUD_SYNC: 1, CLOUD_SYNC_ENABLED: true, CAMPUS_DATA_1: {} });
    expect(shadow.querySelector("#hub-reload-hint")!.classList.contains("hidden")).toBe(true);
  });

  it("the cards say which settings need the reload", async () => {
    const { shadow } = await openHub();
    const tag = (key: string) =>
      shadow
        .querySelector(`[data-setting-key="${key}"]`)!
        .closest(".card")!
        .querySelector(".badge")?.textContent?.trim();
    expect(tag("PROFILE_USE_MODERN_INFO_CARD")).toBe("reload");
    expect(tag("CUSTOM_HIDE_FOOTER")).toBeUndefined();
    // the Logtime widget applies its settings live since 1.15
    expect(tag("LOGTIME_SHOW_AVERAGE")).toBeUndefined();
  });
});

describe("auto push", () => {
  async function openAuto() {
    await chrome.storage.local.set({
      CLOUD_TOKEN: "t",
      CLOUD_LOGIN: "xlogin",
      CLOUD_SYNC_ENABLED: true,
    });
    return openHub();
  }

  it("pushes once, one second after the last of a burst of changes", async () => {
    const { shadow } = await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    storageChanged({ LOGTIME_GOAL_HOURS: 110 });
    storageChanged({ LOGTIME_GOAL_HOURS: 120 });
    await vi.advanceTimersByTimeAsync(900);
    expect(account.pushSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/Pushed/);
  });

  it("does nothing with Manual push, or for a key that never leaves the device", async () => {
    await chrome.storage.local.set({ CLOUD_TOKEN: "t", CLOUD_LOGIN: "x" });
    await openHub();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(account.pushSettings).not.toHaveBeenCalled();
  });

  it("reports a failed push in the footer", async () => {
    account.pushSettings.mockImplementation(async () => "rejected");
    const { shadow } = await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(1100);
    const status = shadow.querySelector("#hub-push-status")!;
    expect(status.textContent).toMatch(/Push failed/);
    expect(status.classList.contains("text-error")).toBe(true);
  });

  it("Reload with an unpushed change pushes first, and stays on a failure", async () => {
    account.pushSettings.mockImplementation(async () => "rejected");
    const { shadow } = await openAuto();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    (shadow.querySelector("#hub-reload") as HTMLButtonElement).click();
    await settle();
    expect(account.pushSettings).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/Push failed/);

    account.pushSettings.mockImplementation(async () => "ok");
    (shadow.querySelector("#hub-reload") as HTMLButtonElement).click();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("closing the hub flushes a pending push", async () => {
    const { dialog } = await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });

  it("a hub left open in a background tab leaves the push to the tab in use", async () => {
    // both tabs hear the change: two pushes raced, one came back a conflict
    const { dialog } = await openAuto();
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS * 3);
    expect(account.pushSettings).not.toHaveBeenCalled();
    hidden.mockRestore();
    // still counted as not pushed: it goes when this hub closes
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });

  it("text typed just before the hub closes is stored, then pushed", async () => {
    // the editor stores 300 ms after the last key: that write landed on a
    // closed hub, and stayed out of the cloud
    const { dialog } = await openAuto();
    const { renderShortcutsPanel } = await import("../src/features/hub/controls/shortcuts.ts");
    const panel = renderShortcutsPanel();
    document.body.appendChild(panel);
    await settle();
    panel.querySelector<HTMLButtonElement>("button.btn-success")!.click();
    const row = panel.querySelector(".link-group")!;
    row.querySelector<HTMLInputElement>("[data-shortcuts-name]")!.value = "Docs";
    const url = row.querySelector<HTMLInputElement>("[data-shortcuts-url]")!;
    url.value = "https://example.com/docs";
    vi.useFakeTimers();
    url.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    const stored = (await chrome.storage.local.get("SHORTCUTS_LINKS")).SHORTCUTS_LINKS as string;
    expect(stored).toContain("https://example.com/docs");
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    panel.remove();
  });

  it("Reload just after typing stores the text first", async () => {
    const { shadow } = await openAuto();
    const { renderShortcutsPanel } = await import("../src/features/hub/controls/shortcuts.ts");
    const panel = renderShortcutsPanel();
    document.body.appendChild(panel);
    await settle();
    panel.querySelector<HTMLButtonElement>("button.btn-success")!.click();
    const row = panel.querySelector(".link-group")!;
    row.querySelector<HTMLInputElement>("[data-shortcuts-name]")!.value = "Wiki";
    const url = row.querySelector<HTMLInputElement>("[data-shortcuts-url]")!;
    url.value = "https://example.com/wiki";
    url.dispatchEvent(new Event("input", { bubbles: true }));
    (shadow.querySelector("#hub-reload") as HTMLButtonElement).click();
    // well within the 300 ms: the reload must not have run before the write
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const stored = (await chrome.storage.local.get("SHORTCUTS_LINKS")).SHORTCUTS_LINKS as string;
    expect(stored).toContain("https://example.com/wiki");
    await settle();
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    panel.remove();
  });

  it("closing the hub after a failed push sends it again", async () => {
    account.pushSettings.mockImplementationOnce(async () => "network");
    const { dialog } = await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.pushSettings).toHaveBeenCalledTimes(2);
    // it went through: the retry that was waiting is gone with it
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[AUTO_PUSH_RETRY_MS.length - 1] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(2);
  });

  it("tries a failed push again later, waiting longer each time, and says why it failed", async () => {
    account.pushSettings.mockImplementation(async () => "busy");
    const { shadow } = await openAuto();
    const status = shadow.querySelector("#hub-push-status")!;
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    expect(status.textContent).toMatch(/too many pushes/);
    expect(status.textContent).toMatch(/kept locally/);
    expect(status.textContent).toMatch(/trying again in 1 min/);

    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] - 1000);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.pushSettings).toHaveBeenCalledTimes(2);

    account.pushSettings.mockImplementation(async () => "ok");
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[1]);
    expect(account.pushSettings).toHaveBeenCalledTimes(3);
    expect(status.textContent).toMatch(/Pushed/);
    // bounded: nothing more once it went through
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[2] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last wait instead of asking a dead server forever", async () => {
    account.pushSettings.mockImplementation(async () => "network");
    await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    for (const wait of AUTO_PUSH_RETRY_MS) await vi.advanceTimersByTimeAsync(wait);
    expect(account.pushSettings).toHaveBeenCalledTimes(1 + AUTO_PUSH_RETRY_MS.length);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(account.pushSettings).toHaveBeenCalledTimes(1 + AUTO_PUSH_RETRY_MS.length);
  });

  it("a new change during the wait replaces the retry with its own push", async () => {
    account.pushSettings.mockImplementationOnce(async () => "network");
    await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    storageChanged({ LOGTIME_GOAL_HOURS: 110 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(2);
  });

  it("an expired sign-in is not retried: it offers Sign in again, and closing sends nothing", async () => {
    account.pushSettings.mockImplementation(async () => "auth");
    const { dialog, shadow } = await openAuto();
    const again = shadow.querySelector<HTMLButtonElement>("#hub-push-reconnect")!;
    expect(again.classList.contains("hidden")).toBe(true);
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/sign-in expired/);
    expect(again.classList.contains("hidden")).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    again.click();
    expect(account.loginWith42).toHaveBeenCalledTimes(1);
  });

  it("a value too large for the cloud is not retried either", async () => {
    account.pushSettings.mockImplementation(async () => "too-large");
    const { shadow } = await openAuto();
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/too large/);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });
});

describe("manual push", () => {
  it("Push now pushes in Manual mode, stands out while a change is unpushed, and hides in Auto", async () => {
    await chrome.storage.local.set({ CLOUD_TOKEN: "t", CLOUD_LOGIN: "xlogin" });
    const { shadow } = await openHub();
    const pushNow = shadow.querySelector<HTMLButtonElement>("#hub-push-now")!;
    expect(pushNow.classList.contains("hidden")).toBe(false);
    expect(pushNow.classList.contains("btn-primary")).toBe(false);

    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    expect(pushNow.classList.contains("btn-primary")).toBe(true);
    pushNow.click();
    await vi.waitFor(() => expect(account.pushSettings).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/Pushed/),
    );
    expect(pushNow.classList.contains("btn-primary")).toBe(false);

    const auto = shadow.querySelector<HTMLInputElement>(
      'input[name="hub-auto-push"][value="auto"]',
    )!;
    auto.checked = true;
    auto.dispatchEvent(new Event("change"));
    expect(pushNow.classList.contains("hidden")).toBe(true);
  });

  it("a failed Push now is reported, and Manual schedules no retry", async () => {
    account.pushSettings.mockImplementation(async () => "network");
    await chrome.storage.local.set({ CLOUD_TOKEN: "t", CLOUD_LOGIN: "xlogin" });
    const { shadow } = await openHub();
    vi.useFakeTimers();
    shadow.querySelector<HTMLButtonElement>("#hub-push-now")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const status = shadow.querySelector("#hub-push-status")!;
    expect(status.textContent).toMatch(/did not answer/);
    expect(status.textContent).not.toMatch(/trying again/);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });
});

describe("pushFailureText", () => {
  it("names each reason, and still says something for one it does not know", async () => {
    const { pushFailureText } = await import("../src/features/hub/hubSettings.ui.ts");
    expect(pushFailureText("network")).toMatch(/did not answer/);
    expect(pushFailureText("busy")).toMatch(/too many/);
    expect(pushFailureText("auth")).toMatch(/sign-in expired/);
    expect(pushFailureText("something-new")).toMatch(/^Push failed/);
  });
});

describe("conflicts and the day's limit", () => {
  async function openSignedIn(auto = false) {
    await chrome.storage.local.set({
      CLOUD_TOKEN: "t",
      CLOUD_LOGIN: "xlogin",
      CLOUD_SYNC_ENABLED: auto,
    });
    return openHub();
  }
  const conflictBox = (shadow: ShadowRoot) => shadow.querySelector<HTMLElement>("#hub-conflict")!;

  it("a conflict shows Pull and Push anyway, is not retried, and stops Auto", async () => {
    account.pushSettings.mockImplementation(async () => "conflict");
    const { dialog, shadow } = await openSignedIn(true);
    expect(conflictBox(shadow).classList.contains("hidden")).toBe(true);
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
    expect(conflictBox(shadow).classList.contains("hidden")).toBe(false);
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/^Not pushed.*another browser/);
    // neither a retry nor a push per change: each would be refused the same way
    storageChanged({ LOGTIME_GOAL_HOURS: 110 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[0] * 2);
    dialog.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });

  it("Push anyway pushes without the check and puts the buttons away", async () => {
    account.pushSettings.mockImplementationOnce(async () => "conflict");
    const { shadow } = await openSignedIn();
    shadow.querySelector<HTMLButtonElement>("#hub-push-now")!.click();
    await vi.waitFor(() => expect(conflictBox(shadow).classList.contains("hidden")).toBe(false));
    expect(account.pushSettings).toHaveBeenLastCalledWith({ force: false });
    shadow.querySelector<HTMLButtonElement>("#hub-conflict-push")!.click();
    await vi.waitFor(() => expect(account.pushSettings).toHaveBeenCalledTimes(2));
    expect(account.pushSettings).toHaveBeenLastCalledWith({ force: true });
    await vi.waitFor(() => expect(conflictBox(shadow).classList.contains("hidden")).toBe(true));
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/Pushed/);
  });

  it("a conflict recorded before the hub opened (a friend added) shows at once; Push now asks first", async () => {
    account.getPushFailure.mockImplementation(async () => ({ reason: "conflict" }));
    const { shadow } = await openSignedIn();
    expect(conflictBox(shadow).classList.contains("hidden")).toBe(false);
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    shadow.querySelector<HTMLButtonElement>("#hub-push-now")!.click();
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(account.pushSettings).not.toHaveBeenCalled();
    ask.mockReturnValueOnce(true);
    shadow.querySelector<HTMLButtonElement>("#hub-push-now")!.click();
    await vi.waitFor(() => expect(account.pushSettings).toHaveBeenCalledWith({ force: true }));
    ask.mockRestore();
  });

  it("a conflict another push records while the hub is open shows too, and goes once settled", async () => {
    const { shadow } = await openSignedIn();
    storageChanged({ CLOUD_PUSH_FAILURE: { reason: "conflict", detail: "", at: 1 } });
    expect(conflictBox(shadow).classList.contains("hidden")).toBe(false);
    const payload = { CLOUD_PUSH_FAILURE: { newValue: undefined } };
    for (const fn of listeners) fn(payload, "local");
    expect(conflictBox(shadow).classList.contains("hidden")).toBe(true);
  });

  it("Pull asks, pulls and reloads; a failed pull says why and stays", async () => {
    account.getPushFailure.mockImplementation(async () => ({ reason: "conflict" }));
    const { shadow } = await openSignedIn();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    account.pullSettings.mockImplementationOnce(async () => ({ ok: false, reason: "network" }));
    shadow.querySelector<HTMLButtonElement>("#hub-conflict-pull")!.click();
    await vi.waitFor(() =>
      expect(shadow.querySelector("#hub-push-status")!.textContent).toBe("failure: network"),
    );
    expect(reload).not.toHaveBeenCalled();
    shadow.querySelector<HTMLButtonElement>("#hub-conflict-pull")!.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(account.pullSettings).toHaveBeenCalledTimes(2);
    ask.mockRestore();
  });

  it("the day's limit is not retried and stops Auto", async () => {
    account.pushSettings.mockImplementation(async () => "daily-limit");
    const { shadow } = await openSignedIn(true);
    vi.useFakeTimers();
    storageChanged({ LOGTIME_GOAL_HOURS: 100 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DELAY_MS + 100);
    expect(shadow.querySelector("#hub-push-status")!.textContent).toMatch(/daily limit/);
    expect(shadow.querySelector("#hub-push-status")!.textContent).not.toMatch(/trying again/);
    storageChanged({ LOGTIME_GOAL_HOURS: 110 });
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_RETRY_MS[2] * 2);
    expect(account.pushSettings).toHaveBeenCalledTimes(1);
  });

  it("closing in Manual publishes the waiting look changes; in Auto the hub's push carries them", async () => {
    const manual = await openSignedIn(false);
    manual.dialog.close();
    await settle();
    expect(publish.flushLookPublish).toHaveBeenCalledTimes(1);
    publish.flushLookPublish.mockClear();
    const auto = await openSignedIn(true);
    auto.dialog.close();
    await settle();
    expect(publish.flushLookPublish).not.toHaveBeenCalled();
  });

  it("names the new reasons", async () => {
    const { pushFailureText } = await import("../src/features/hub/hubSettings.ui.ts");
    expect(pushFailureText("conflict")).toMatch(/another browser/);
    expect(pushFailureText("daily-limit")).toMatch(/daily limit/);
    // a KV write refused within its second: the footer's "too many pushes"
    expect(pushFailureText("kv-busy")).toBe(pushFailureText("busy"));
  });
});
