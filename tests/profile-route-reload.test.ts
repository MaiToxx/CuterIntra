/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/users/alice" }
 *
 * The Intra moves from a profile to another without loading a page. The
 * profile features are written for one page (flags, per-login state, a
 * watcher that stops): the first profile's banner and look stayed on the
 * second, whose cards never loaded. The new page is loaded again instead.
 */
import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { watchProfileRoute } from "../src/features/profile/profile";

const reload = vi.fn();
const loc = { pathname: "/users/alice", origin: "https://profile-v3.intra.42.fr", reload };

/** What the page's router does, then the render that follows it. */
async function moveTo(path: string) {
  loc.pathname = path;
  document.body.appendChild(document.createElement("div"));
  await new Promise((r) => setTimeout(r, 0));
}

beforeAll(() => {
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true });
  Object.defineProperty(globalThis, "location", { value: loc, writable: true, configurable: true });
  watchProfileRoute();
});

// stops the watcher before the environment goes
afterAll(() => void window.dispatchEvent(new Event("pagehide")));

beforeEach(() => {
  reload.mockClear();
  sessionStorage.clear();
});

describe("in-app navigation on the profile site", () => {
  it("a render on the same page does nothing", async () => {
    await moveTo("/users/alice");
    expect(reload).not.toHaveBeenCalled();
  });

  it("another profile is loaded again", async () => {
    await moveTo("/users/bob");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("so is the dashboard, and back/forward without a render", async () => {
    await moveTo("/");
    expect(reload).toHaveBeenCalledTimes(1);
    loc.pathname = "/users/carol";
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("a page that is not a profile is left alone", async () => {
    await moveTo("/clusters");
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops after three in ten seconds: a page that keeps rewriting its address is not a loop", async () => {
    await moveTo("/users/dave");
    await moveTo("/users/erin");
    await moveTo("/users/dave");
    expect(reload).toHaveBeenCalledTimes(3);
    await moveTo("/users/erin");
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
