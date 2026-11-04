/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 */
/**
 * The two Cuter Intra entries in the Intra sidebar (settings gear, Clusters):
 * an accessible name for screen readers, and a way out when the script
 * outlived its extension (Chrome after an update) instead of a dead click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/features/hub/hubSettings.ui.ts", () => ({ openHubModal: vi.fn(async () => {}) }));
vi.mock("../src/features/clusters/map-dialog.ts", () => ({ openClusterDialog: vi.fn() }));
vi.mock("../src/features/eggs/eggs.ts", () => ({ gearClicked: vi.fn(async () => {}) }));

import { mountGearButton } from "../src/features/hub/hubSettings.ts";
import { openHubModal } from "../src/features/hub/hubSettings.ui.ts";
import { openClusterDialog } from "../src/features/clusters/map-dialog.ts";

type Runtime = { id?: string } | undefined;
const setRuntime = (runtime: Runtime) => {
  (chrome as unknown as { runtime: Runtime }).runtime = runtime;
};

const sidebar = () => {
  const group = document.createElement("div");
  group.className = "flex flex-col w-full";
  const profile = document.createElement("a");
  profile.href = "https://profile-v3.intra.42.fr";
  group.append(profile, document.createElement("a"));
  document.body.appendChild(group);
  return group;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Both buttons in place (Clusters waits for the campus read). */
const mountBoth = async () => {
  sidebar();
  mountGearButton();
  await vi.waitFor(() => {
    if (!document.getElementById("ft-clusters-btn")) throw new Error("not yet");
  });
  return {
    gear: document.getElementById("hub-gear-btn") as HTMLAnchorElement,
    clusters: document.getElementById("ft-clusters-btn") as HTMLAnchorElement,
  };
};

beforeEach(async () => {
  document.body.replaceChildren();
  await chrome.storage.local.set({ CLUSTERS_CAMPUS: "mulhouse" });
  setRuntime({ id: "better-intra@test" });
  vi.mocked(openHubModal).mockClear();
  vi.mocked(openClusterDialog).mockClear();
});

afterEach(() => {
  setRuntime(undefined);
  vi.restoreAllMocks();
});

describe("sidebar buttons are labelled", () => {
  it("the gear has a name, a hover label, and a decorative icon", async () => {
    const { gear } = await mountBoth();
    // Before: an <a> around an SVG with no title, announced as an unnamed link.
    expect(gear.getAttribute("aria-label")).toBe("Cuter Intra settings");
    expect(gear.dataset.tip).toBe("Cuter Intra settings");
    expect(gear.dataset.tipPos).toBe("right");
    expect(gear.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // A real link: reachable with Tab, activated by Enter.
    expect(gear.tagName).toBe("A");
    expect(gear.getAttribute("href")).toBe("#");
  });

  it("the Clusters button has a name and keeps its icon colour", async () => {
    const { clusters } = await mountBoth();
    expect(clusters.getAttribute("aria-label")).toBe("Cluster map");
    const svg = clusters.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("width")).toBe("25");
    expect(svg?.getAttribute("stroke")).toMatch(/^#(fff|1a1d24)$/);
  });
});

describe("clicks", () => {
  it("open the hub and the map while the extension is alive", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { gear, clusters } = await mountBoth();
    gear.click();
    await flush();
    await vi.waitFor(() => expect(openHubModal).toHaveBeenCalledTimes(1));
    clusters.click();
    expect(openClusterDialog).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("offer a reload once the extension is gone, instead of failing silently", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { gear, clusters } = await mountBoth();
    // Chrome clears runtime.id in a script orphaned by an update.
    setRuntime({});
    vi.mocked(chrome.storage.local.get).mockClear();

    gear.click();
    await flush();
    clusters.click();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0]).toMatch(/updated.*reload/i);
    expect(openHubModal).not.toHaveBeenCalled();
    expect(openClusterDialog).not.toHaveBeenCalled();
    // No storage call that would only throw "Extension context invalidated".
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });
});
