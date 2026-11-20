/**
 * The cluster map redraws its seats every minute while it is open. It used
 * to throw every avatar away and create them all again: a cluster of 200
 * people decoded 200 pictures a minute. Someone still at the same seat keeps
 * their link and picture; only what changed is created or dropped.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { renderSeatOverlays, type OccupancyEntry } from "../src/features/clusters/map-dialog/render";

const SVG_NS = "http://www.w3.org/2000/svg";
let shadow: ShadowRoot;

const seat = (host: string, login: string, picture = `https://cdn.intra.42.fr/${login}.jpg`): OccupancyEntry => ({
  host,
  login,
  cdn_uri: picture,
  begin_at: "2026-11-19T08:00:00Z",
  end_at: null,
});
const POSITIONS = new Map(
  ["k1r1p1", "k1r1p2", "k1r1p3"].map((id, i) => [id, { x: i * 20, y: 0, w: 10, h: 10 }]),
);
const draw = (...seats: OccupancyEntry[]) =>
  renderSeatOverlays(shadow, new Map(seats.map((s) => [s.host, s])), POSITIONS as never, { w: 100, h: 100 });
const links = () => [...shadow.querySelectorAll<HTMLAnchorElement>("#seat-overlay a.seat-link")];
const linkOf = (login: string) => links().find((a) => a.dataset.login === login);

beforeAll(() => {
  // jsdom lays nothing out: every box is 0 x 0, and the map draws no seat on
  // a map that has no size
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0,
    toJSON: () => ({}),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: "open" });
  const area = document.createElement("div");
  area.id = "map-area";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  area.appendChild(svg);
  shadow.appendChild(area);
});
afterAll(() => vi.restoreAllMocks());

describe("the seats of the cluster map, from one poll to the next", () => {
  it("keeps the link and the picture of someone who has not moved", () => {
    draw(seat("k1r1p1", "alice"), seat("k1r1p2", "bob"));
    const alice = linkOf("alice")!;
    const picture = alice.querySelector("img")!;
    expect(links()).toHaveLength(2);

    draw(seat("k1r1p1", "alice"), seat("k1r1p2", "bob"));
    expect(linkOf("alice")).toBe(alice);
    expect(linkOf("alice")!.querySelector("img")).toBe(picture);
    expect(shadow.querySelectorAll("#seat-overlay")).toHaveLength(1);
  });

  it("drops who left, adds who arrived, and gives a seat's new occupant a new link", () => {
    draw(seat("k1r1p1", "alice"), seat("k1r1p2", "bob"));
    const alice = linkOf("alice")!;
    draw(seat("k1r1p1", "alice"), seat("k1r1p2", "carol"), seat("k1r1p3", "dave"));
    expect(links().map((a) => a.dataset.login).sort()).toEqual(["alice", "carol", "dave"]);
    expect(linkOf("alice")).toBe(alice);
    expect(linkOf("carol")!.getAttribute("href")).toMatch(/\/users\/carol$/);
    expect(linkOf("carol")!.querySelector("img")!.getAttribute("src")).toContain("carol.jpg");
  });

  it("loads a picture again only when its address changed", () => {
    draw(seat("k1r1p1", "alice"));
    const picture = linkOf("alice")!.querySelector("img")!;
    draw(seat("k1r1p1", "alice", "https://cdn.intra.42.fr/alice-new.jpg"));
    expect(linkOf("alice")!.querySelector("img")).toBe(picture);
    expect(picture.getAttribute("src")).toBe("https://cdn.intra.42.fr/alice-new.jpg");
  });
});
