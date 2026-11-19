/**
 * A student who moves from Phoenix to Pegasus kept the stored Phoenix phase:
 * the badge counted against Phoenix thresholds, and the list (Pegasus phases
 * only) showed none selected. A phase of the other programme is replaced by
 * the default of the badge's own.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/features/logtime/logtime.ts", () => ({ lastStats: {} }));

import { colorTrackerBadge } from "../src/features/logtime/tracker-card";

describe("the tracker badge and a phase of the other programme", () => {
  it("falls back to the first Pegasus phase under a Pegasus badge", async () => {
    await chrome.storage.local.set({ TRACKER_MODE: "phoenix-2" });
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Pegasus";
    document.body.appendChild(badge);
    await colorTrackerBadge();
    expect((await chrome.storage.local.get("TRACKER_MODE")).TRACKER_MODE).toBe("pegasus-bronze");
  });
});
