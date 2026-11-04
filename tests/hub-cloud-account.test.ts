/**
 * The Cloud account block of the Advanced tab (worker contracts C2 and C4):
 * the browsers signed in to the account, "Sign out my other browsers", and
 * "Download my cloud data". Until then, ending a session left on a campus
 * computer took Wipe All Data, and seeing what the server keeps took a
 * request on the public issue tracker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { html, render } from "lit-html";

vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));

import {
  fetchCloudExport,
  listCloudSessions,
  signOutOtherBrowsers,
} from "../src/features/account/cloud-account.ts";
import { renderCloudAccountAction } from "../src/features/hub/controls/cloud-account.ts";
import { ADVANCED_SETTINGS } from "../src/features/hub/settings/advanced.ts";

type Call = { method: string; path: string; search: string; auth: string | null };
const calls: Call[] = [];
let reply: (call: Call) => Response = () => new Response("{}", { status: 200 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12);
const SESSIONS = {
  sessions: [
    { id: "aaaaaaaa", createdAt: NOW - 30 * DAY, current: false },
    { id: "bbbbbbbb", createdAt: NOW - 2 * DAY, current: true },
    { id: "cccccccc", createdAt: NOW - 5 * DAY, current: false },
  ],
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const text = (el: Element) => el.textContent!.replace(/\s+/g, " ").trim();

beforeEach(async () => {
  calls.length = 0;
  reply = () => json(SESSIONS);
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ CLOUD_TOKEN: "sess", CLOUD_LOGIN: "alice" });
  (globalThis as any).fetch = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    const call = {
      method: init.method ?? "GET",
      path: url.pathname,
      search: url.search,
      auth: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
    };
    calls.push(call);
    return reply(call);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the account calls", () => {
  it("lists the signed-in browsers in the worker's order, and keeps the count", async () => {
    const result = await listCloudSessions();
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/private/sessions",
      search: "?login=hashed-alice",
      auth: "Bearer sess",
    });
    expect(result.ok && result.sessions).toEqual(SESSIONS.sessions);
    expect((await chrome.storage.local.get("CLOUD_LAST_SESSIONS")).CLOUD_LAST_SESSIONS).toBe(3);
  });

  it("signs out the other browsers with DELETE ?others=true", async () => {
    reply = () => json({ revoked: 2 });
    await expect(signOutOtherBrowsers()).resolves.toEqual({ ok: true, revoked: 2 });
    expect(calls[0]).toMatchObject({ method: "DELETE", search: expect.stringContaining("others=true") });
    expect((await chrome.storage.local.get("CLOUD_LAST_SESSIONS")).CLOUD_LAST_SESSIONS).toBe(1);
  });

  it("fetches the export; a worker without the route is 'missing', not a lost session", async () => {
    reply = () => json({ exportedAt: 1, loginHash: "h", settings: {} });
    const ok = await fetchCloudExport();
    expect(ok).toEqual({ ok: true, data: { exportedAt: 1, loginHash: "h", settings: {} } });
    expect(calls[0].path).toBe("/api/v1/private/export");

    reply = () => new Response("Not found", { status: 404 });
    await expect(fetchCloudExport()).resolves.toEqual({ ok: false, reason: "missing" });
    expect((await chrome.storage.local.get("CLOUD_AUTH_FAILED")).CLOUD_AUTH_FAILED).toBeUndefined();

    reply = () => json({ error: "rate_limited", message: "Too many requests" }, 429);
    await expect(fetchCloudExport()).resolves.toEqual({ ok: false, reason: "busy" });
  });

  it("asks nothing signed out", async () => {
    await chrome.storage.local.remove("CLOUD_TOKEN");
    await expect(listCloudSessions()).resolves.toEqual({ ok: false, reason: "auth" });
    await expect(fetchCloudExport()).resolves.toEqual({ ok: false, reason: "auth" });
    expect(calls).toEqual([]);
  });
});

describe("the Advanced tab", () => {
  const def = (type: string) => ADVANCED_SETTINGS.find((d) => d.actionType === type)!;

  function mount(type: string): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(html`${renderCloudAccountAction(def(type))}`, host);
    return host;
  }

  it("has both cards, under a Cloud account title", () => {
    const labels = ADVANCED_SETTINGS.map((d) => d.label);
    const title = labels.indexOf("Cloud account");
    expect(title).toBeGreaterThan(-1);
    expect(labels.slice(title + 1, title + 3)).toEqual(["Signed-in browsers", "Download my cloud data"]);
  });

  it("asks the server only on a click, then lists the browsers with their day", async () => {
    const host = mount("cloud-sessions");
    await settle();
    expect(calls).toEqual([]);
    host.querySelector("button")!.click();
    await settle();
    const out = text(host);
    expect(out).toContain("Sign-ins 3/10");
    expect(out).toMatch(/This browser \([^)]*23[^)]*\)/);
    expect(out).toContain("Another browser");
    expect(out).toContain("Sign out my other browsers");
  });

  it("Sign out my other browsers asks first, then says how many and lists again", async () => {
    const host = mount("cloud-sessions");
    host.querySelector("button")!.click();
    await settle();
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    const signOut = () =>
      [...host.querySelectorAll("button")].find((b) => /other browsers/.test(b.textContent!))!;
    signOut().click();
    await settle();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    ask.mockReturnValueOnce(true);
    reply = (c) =>
      c.method === "DELETE"
        ? json({ revoked: 2 })
        : json({ sessions: [{ id: "bbbbbbbb", createdAt: NOW, current: true }] });
    signOut().click();
    await settle();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(text(host)).toContain("Sign-ins 1/10");
    // alone now: nothing left to sign out
    expect(text(host)).not.toContain("Sign out my other browsers");
    // the focused button went with the list: the focus is back on Show,
    // not lost to the top of the page
    expect(document.activeElement).toBe(host.querySelector("button"));
    expect(document.activeElement!.textContent!.trim()).toBe("Show");
  });

  it("a failure says why, in words for this card", async () => {
    reply = () => new Response("Not found", { status: 404 });
    const host = mount("cloud-sessions");
    host.querySelector("button")!.click();
    await settle();
    expect(text(host)).toContain("Not available on this server yet.");
  });

  it("Download saves the export as a dated JSON file", async () => {
    reply = () => json({ exportedAt: 1, settings: { CALENDAR_SYNC_TOKEN: "[redacted]" } });
    const created: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:x";
    });
    (URL as any).revokeObjectURL = vi.fn();
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    const host = mount("cloud-export");
    host.querySelector("button")!.click();
    await settle();
    expect(downloaded).toMatch(/^cuter-intra-cloud-data-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(await created[0].text())).toEqual({
      exportedAt: 1,
      settings: { CALENDAR_SYNC_TOKEN: "[redacted]" },
    });
  });

  it("a Download while signed out says to sign in first", async () => {
    await chrome.storage.local.remove("CLOUD_TOKEN");
    const host = mount("cloud-export");
    host.querySelector("button")!.click();
    await settle();
    expect(text(host)).toContain("Sign in with 42");
    expect(calls).toEqual([]);
  });
});
