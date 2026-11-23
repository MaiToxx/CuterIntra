/**
 * @vitest-environment jsdom
 *
 * scrubSvg (core/dom/svg.ts): what is taken out of an SVG that came from the
 * network before it is imported into the Intra page. Used for the cluster
 * maps (map-dialog/seats.ts) and the achievement icons.
 */
import { describe, it, expect } from "vitest";
import { scrubSvg, svgFromUntrustedMarkup } from "../src/core/dom/svg";
import { sanitizeAndParseSeats } from "../src/features/clusters/map-dialog/seats";

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="http://www.w3.org/2000/svg"';
const parse = (inner: string) =>
  new DOMParser().parseFromString(`<svg ${NS}>${inner}</svg>`, "image/svg+xml");
const scrubbed = (inner: string) => {
  const doc = parse(inner);
  scrubSvg(doc);
  return doc.documentElement;
};

describe("scrubSvg", () => {
  it("removes active elements, prefixed ones included", () => {
    const svg = scrubbed(
      '<script>alert(1)</script><svg:script>alert(2)</svg:script><foreignObject><p>x</p></foreignObject><rect id="kept"/>',
    );
    expect(svg.querySelectorAll("*")).toHaveLength(1);
    expect(svg.querySelector("#kept")).not.toBeNull();
  });

  it("removes event handlers whatever their case", () => {
    const svg = scrubbed('<rect id="r" onclick="x()" ONLOAD="y()" fill="red"/>');
    const rect = svg.querySelector("#r")!;
    expect(rect.getAttributeNames()).toEqual(["id", "fill"]);
  });

  it("keeps local hrefs and drops every href that leaves the document", () => {
    const svg = scrubbed(
      [
        '<a id="js" href="java&#9;script:alert(1)"><rect/></a>',
        '<a id="out" xlink:href="https://evil.example/"><rect/></a>',
        '<a id="local" href="#top"><rect/></a>',
        '<image id="remote" href="https://evil.example/x.png"/>',
        '<image id="inline" href="data:image/png;base64,AAAA"/>',
        '<use id="far" href="https://evil.example/s.svg#a"/>',
        '<use id="near" href="#a"/>',
      ].join(""),
    );
    expect(svg.querySelector("#js")!.hasAttribute("href")).toBe(false);
    expect(svg.querySelector("#out")!.hasAttribute("xlink:href")).toBe(false);
    expect(svg.querySelector("#local")!.getAttribute("href")).toBe("#top");
    expect(svg.querySelector("#remote")!.hasAttribute("href")).toBe(false);
    expect(svg.querySelector("#inline")!.getAttribute("href")).toContain("data:image/png");
    expect(svg.querySelector("#far")).toBeNull();
    expect(svg.querySelector("#near")).not.toBeNull();
  });

  it("removes the animations that could write an href or a handler back", () => {
    const svg = scrubbed(
      '<a href="#x"><animate id="bad" attributeName="href" to="javascript:alert(1)"/><set id="bad2" attributeName="onclick" to="x()"/><animate id="fine" attributeName="opacity" to="0"/></a>',
    );
    expect(svg.querySelector("#bad")).toBeNull();
    expect(svg.querySelector("#bad2")).toBeNull();
    expect(svg.querySelector("#fine")).not.toBeNull();
  });

  it("strips remote url() and @import from styles, every time, and keeps local references", () => {
    const svg = scrubbed(
      [
        '<style>@import "https://evil.example/a.css"; .a{fill:url(#g)} .b{background:url(https://evil.example/b.png)}</style>',
        '<rect id="one" style="fill:url(https://evil.example/1.png)"/>',
        '<rect id="two" style="fill:url(https://evil.example/2.png)"/>',
        '<rect id="three" style="fill:url(#g)"/>',
      ].join(""),
    );
    const css = svg.querySelector("style")!.textContent!;
    expect(css).not.toContain("evil.example");
    expect(css).toContain("url(#g)");
    // a shared /g regex used with .test() skipped every other element
    expect(svg.querySelector("#one")!.getAttribute("style")).toBe("fill:none");
    expect(svg.querySelector("#two")!.getAttribute("style")).toBe("fill:none");
    expect(svg.querySelector("#three")!.getAttribute("style")).toBe("fill:url(#g)");
  });
});

describe("svgFromUntrustedMarkup", () => {
  it("answers a scrubbed element, or null for what is not an SVG", () => {
    const svg = svgFromUntrustedMarkup(`<svg ${NS} onload="x()"><script>1</script><path d="M0 0"/></svg>`);
    expect(svg?.localName).toBe("svg");
    expect(svg!.hasAttribute("onload")).toBe(false);
    expect(svg!.querySelector("script")).toBeNull();
    expect(svg!.querySelector("path")).not.toBeNull();
    expect(svgFromUntrustedMarkup("<html><body>no</body></html>")).toBeNull();
    expect(svgFromUntrustedMarkup("<svg")).toBeNull();
  });
});

describe("sanitizeAndParseSeats", () => {
  it("scrubs the map and still finds its seats", () => {
    const doc = parse(
      '<script>1</script><image id="k0r1p2" x="10" y="20" width="5" height="5" href="https://evil.example/t.png" onclick="x()"/>',
    );
    const seats = sanitizeAndParseSeats(doc);
    expect(doc.querySelector("script")).toBeNull();
    const seat = doc.querySelector("image")!;
    expect(seat.hasAttribute("href")).toBe(false);
    expect(seat.hasAttribute("onclick")).toBe(false);
    expect(seats.size).toBeGreaterThan(0);
  });
});
