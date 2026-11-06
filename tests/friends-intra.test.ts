import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/crypto.ts", () => ({
  hashLogin: vi.fn(async (login: string) => `hashed-${login}`),
}));

import {
  applyIntraVisuals,
  buildFriendFromIntra,
  fetchFriendsDataViaIntra,
  hasProfilePicture,
  pickMainCursus,
} from "../src/features/friends/friends-intra";
import { FRIENDS_CACHE_TTL } from "../src/features/friends/friends";

describe("pickMainCursus", () => {
  it("prefers the main cursus, then the highest level", () => {
    const list = [
      { slug: "c-piscine", grade: "Pisciner", level: 4.2 },
      { slug: "42cursus", grade: "Learner", level: 1.5 },
    ];
    expect(pickMainCursus(list)?.slug).toBe("42cursus");
    expect(pickMainCursus([list[0], { slug: "other", level: 6 }])?.level).toBe(6);
    expect(pickMainCursus([])).toBeNull();
    expect(pickMainCursus("garbage")).toBeNull();
  });
});

describe("buildFriendFromIntra", () => {
  it("maps intrapy payloads to the widget shape", () => {
    const f = buildFriendFromIntra(
      "alepayen",
      {
        first_name: "Alexis",
        last_name: "Payen",
        wallet: 12,
        evaluation_points: 7,
        location: "k0r4p1",
        pool_month: "september",
        pool_year: 2026,
      },
      { profile_picture: "https://cdn.intra.42.fr/users/x/alepayen.jpg" },
      [{ slug: "c-piscine", grade: "Pisciner", level: 3.75 }],
      null,
    );
    expect(f).toMatchObject({
      login: "alepayen",
      displayName: "Alexis Payen",
      avatar: "https://cdn.intra.42.fr/users/x/alepayen.jpg",
      level: 3.75,
      grade: "Pisciner",
      isOnline: true,
      lastSeen: "k0r4p1",
      poolLabel: "09/2026",
      wallet: 12,
      correctionPoints: 7,
      customAvatar: null,
    });
  });

  it("degrades gracefully when payloads are missing", () => {
    const f = buildFriendFromIntra("bob", null, null, null, 123);
    expect(f).toMatchObject({
      login: "bob",
      displayName: "bob",
      avatar: null,
      level: 0,
      grade: null,
      isOnline: false,
      lastSeen: null,
      poolLabel: null,
      wallet: 0,
      correctionPoints: 0,
      lastOnlineTimestamp: 123,
    });
  });

  it("ignores non-URL pictures and falls back to correction_point", () => {
    const f = buildFriendFromIntra(
      "eve",
      { displayname: "Eve", correction_point: 3 },
      { profile_picture: "eve.jpg" },
      [],
      null,
    );
    expect(f.avatar).toBeNull();
    expect(f.displayName).toBe("Eve");
    expect(f.correctionPoints).toBe(3);
  });
});

describe("applyIntraVisuals", () => {
  const base = () => buildFriendFromIntra("bob", null, null, null, null);

  it("keeps plain URLs and colours from the worker", () => {
    const f = applyIntraVisuals(base(), {
      avatar: "https://cdn.intra.42.fr/users/bob.png",
      avatarBg: "#ff0000",
      avatarPosX: 10,
      avatarPosY: "20",
      avatarScale: 150,
    });
    expect(f.customAvatar).toBe("https://cdn.intra.42.fr/users/bob.png");
    expect(f.avatarBg).toBe("#ff0000");
    expect(f).toMatchObject({ avatarPosX: 10, avatarPosY: 20, avatarScale: 150 });
  });

  it("accepts the transparent keyword and rgba()", () => {
    expect(applyIntraVisuals(base(), { avatarBg: "Transparent" }).avatarBg).toBe("transparent");
    expect(applyIntraVisuals(base(), { avatarBg: "rgba(0, 0, 0, 0.5)" }).avatarBg).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("drops CSS injection attempts in the avatar URL and background", () => {
    const f = applyIntraVisuals(base(), {
      avatar: 'x") } * { display:none } .a { background:url("',
      avatarBg: "red; } body { display:none",
    });
    expect(f.customAvatar).toBeNull();
    expect(f.avatarBg).toBe("transparent");
    expect(applyIntraVisuals(base(), { avatar: "javascript:alert(1)" }).customAvatar).toBeNull();
    expect(applyIntraVisuals(base(), { avatar: "data:image/png;base64,AAAA" }).customAvatar).toBeNull();
    expect(applyIntraVisuals(base(), { avatarBg: "url(https://evil/x)" }).avatarBg).toBe("transparent");
  });

  it("leaves the friend untouched without visuals", () => {
    const f = base();
    expect(applyIntraVisuals(f, null)).toBe(f);
    expect(f.customAvatar).toBeNull();
    expect(f.avatarBg).toBe("transparent");
  });
});

describe("hasProfilePicture", () => {
  it("only counts absolute http(s) URLs", () => {
    expect(hasProfilePicture({ profile_picture: "https://cdn.intra.42.fr/u/a.jpg" })).toBe(true);
    expect(hasProfilePicture({ profile_picture: "a.jpg" })).toBe(false);
    expect(hasProfilePicture({})).toBe(false);
    expect(hasProfilePicture(null)).toBe(false);
  });
});

describe("fetchFriendsDataViaIntra", () => {
  const calls: string[] = [];
  const responses = new Map<string, unknown>();

  beforeEach(async () => {
    await chrome.storage.local.clear();
    sessionStorage.setItem("ft_intrapy_token", "Bearer opaque-intra-token");
    calls.length = 0;
    responses.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const key = [...responses.keys()].find((k) => url.includes(k));
        if (key === undefined) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => responses.get(key) };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("skips /summary when /users already carries the picture", async () => {
    responses.set("/users/alice/cursus", [{ slug: "42cursus", level: 2 }]);
    responses.set("/users/alice", {
      displayname: "Alice",
      profile_picture: "https://cdn.intra.42.fr/users/alice.jpg",
    });
    responses.set("/public/visuals?login=hashed-alice", { avatar: "https://i.imgur.com/a.png" });

    const [alice] = await fetchFriendsDataViaIntra(["alice"]);
    expect(alice.avatar).toBe("https://cdn.intra.42.fr/users/alice.jpg");
    expect(alice.customAvatar).toBe("https://i.imgur.com/a.png");
    expect(calls.some((u) => u.endsWith("/users/alice/summary"))).toBe(false);
    expect(calls.some((u) => u.endsWith("/users/alice"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/users/alice/cursus"))).toBe(true);
  });

  it("falls back to /summary when /users has no picture, and sanitizes the visuals", async () => {
    responses.set("/users/bob/summary", { profile_picture: "https://cdn.intra.42.fr/users/bob.jpg" });
    responses.set("/users/bob", { displayname: "Bob" });
    responses.set("/public/visuals?login=hashed-bob", {
      avatar: 'x") } * { display:none } .a { url("',
      avatarBg: "red; } body { display:none",
    });

    const [bob] = await fetchFriendsDataViaIntra(["bob"]);
    expect(calls.some((u) => u.endsWith("/users/bob/summary"))).toBe(true);
    expect(bob.avatar).toBe("https://cdn.intra.42.fr/users/bob.jpg");
    expect(bob.customAvatar).toBeNull();
    expect(bob.avatarBg).toBe("transparent");
  });

  it("returns nothing for an unknown login", async () => {
    expect(await fetchFriendsDataViaIntra(["nobody"])).toEqual([]);
    expect(calls.some((u) => u.endsWith("/users/nobody/summary"))).toBe(true);
  });
});

describe("friends cache TTL", () => {
  it("is 5 minutes in the shipped intra mode (the tests' default)", () => {
    expect(FRIENDS_CACHE_TTL).toBe(5 * 60_000);
  });
});
