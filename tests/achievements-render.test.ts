/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The achievements list while its icons arrive: it used to redraw the whole
 * list once per icon, formatting every date again each time ((N+1) x N
 * formatter builds) and re-stripping every icon already there. Now the dates
 * are formatted once, icons that land in the same frame share one redraw,
 * each distinct icon is fetched once, and a lost icon stops pulsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/config.ts", () => ({
  getConfig: vi.fn(async (key: string) => key === "PROFILE_SHOW_ACHIEVEMENTS"),
}));
vi.mock("../src/features/account/account.ts", () => ({
  getCloudLogin: vi.fn(async () => "me"),
}));

const b64url = (s: string) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = `Bearer ${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
)}.c2ln`;

function mountCard() {
  const card = document.createElement("div");
  card.className = "bg-white md:h-96";
  const title = document.createElement("span");
  title.className = "font-bold uppercase text-sm";
  title.textContent = "Last achievements";
  const area = document.createElement("div");
  area.className = "h-full";
  area.appendChild(document.createElement("div")).className = "grid";
  card.append(title, area);
  document.body.replaceChildren(card);
}

const ACHIEVEMENTS = [
  { name: "A", achieved_at: "2026-08-20T10:00:00Z", description: "", svg: "https://cdn.intra.42.fr/1.svg" },
  { name: "B", achieved_at: "2026-08-19T10:00:00Z", description: "", svg: "https://cdn.intra.42.fr/1.svg" },
  { name: "C", achieved_at: "2026-08-18T10:00:00Z", description: "", svg: "https://cdn.intra.42.fr/2.svg" },
  { name: "D", achieved_at: "2026-08-17T10:00:00Z", description: "", svg: "https://cdn.intra.42.fr/lost.svg" },
];

beforeEach(() => {
  mountCard();
  sessionStorage.clear();
  sessionStorage.setItem("ft_intrapy_token", token);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("achievements list", () => {
  it("fetches each icon once, formats each date once and redraws once per frame", async () => {
    const icons = new Map<string, (r: unknown) => void>();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/achievements")) {
        return Promise.resolve({ ok: true, json: async () => ACHIEVEMENTS });
      }
      return new Promise((resolve) => icons.set(url, resolve));
    });
    vi.stubGlobal("fetch", fetchMock);
    const toLocale = vi.spyOn(Date.prototype, "toLocaleDateString");
    const { initAchievements } = await import("../src/features/profile/cards/achievements.ts");

    await initAchievements();
    const list = await vi.waitFor(() => {
      const el = document.getElementById("ft-achievements-injected");
      expect(el).not.toBeNull();
      return el!;
    });
    // one request per distinct icon, not per achievement
    expect([...icons.keys()].sort()).toEqual([
      "https://cdn.intra.42.fr/1.svg",
      "https://cdn.intra.42.fr/2.svg",
      "https://cdn.intra.42.fr/lost.svg",
    ]);
    expect(list.querySelectorAll(".animate-pulse")).toHaveLength(4);
    expect(list.textContent).toContain("Aug 20, 2026");

    // All three answers land before the next frame: a single redraw for them.
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    icons.get("https://cdn.intra.42.fr/1.svg")!({
      ok: true,
      text: async () => '<svg width="80" height="80" id="one"></svg>',
    });
    icons.get("https://cdn.intra.42.fr/2.svg")!({
      ok: true,
      text: async () => '<svg width="80" height="80" id="two"></svg>',
    });
    icons.get("https://cdn.intra.42.fr/lost.svg")!({ ok: false, text: async () => "" });
    await new Promise((r) => setTimeout(r, 20));
    expect(frames).toHaveLength(1);
    frames[0](performance.now());

    expect(list.querySelectorAll("svg#one")).toHaveLength(2);
    expect(list.querySelector("svg#two")!.hasAttribute("width")).toBe(false);
    // the lost icon's tile is left empty instead of pulsing for the visit
    expect(list.querySelectorAll(".animate-pulse")).toHaveLength(0);
    // one formatter for the list instead of one per date per redraw
    expect(toLocale).not.toHaveBeenCalled();
    expect(list.textContent).toContain("Aug 17, 2026");
  });
});
