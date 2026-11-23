/**
 * Turn one of our bundled SVG icons (imported with `?raw`) into a DOM node.
 *
 * The project never injects HTML strings into the page (no innerHTML,
 * insertAdjacentHTML or outerHTML), even for our own trusted assets: parsing
 * the markup as an SVG document and importing the resulting element gives the
 * same icon without an HTML-injection sink anywhere in the code base, so a
 * future change cannot quietly route other data through the same call.
 */

/**
 * Parse `markup` (a single <svg> element) and return it ready to insert, with
 * optional attributes applied (e.g. width/height). Returns null when the
 * markup is not a valid SVG document, so a broken asset shows no icon instead
 * of throwing.
 */
export function svgFromMarkup(
  markup: string,
  attributes: Record<string, string> = {},
): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) {
    return null;
  }
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  return svg;
}

/** Append a bundled icon to `parent`; a no-op when the markup is invalid. */
export function appendSvg(
  parent: Element,
  markup: string,
  attributes?: Record<string, string>,
): SVGSVGElement | null {
  const svg = svgFromMarkup(markup, attributes);
  if (svg) parent.appendChild(svg);
  return svg;
}

// Elements that can embed active or remote content inside the Intra page once
// the SVG is imported into the document.
const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "form",
  "handler",
  "listener",
]);
/** SMIL elements: they can write an attribute (an href, a handler) after the scrub. */
const ANIMATION_TAGS = new Set(["animate", "set", "animatetransform", "animatemotion"]);
const HREF_ATTRS = new Set(["href", "xlink:href"]);

/** url(...) whose target is not a local fragment reference (#id). */
const hasRemoteUrl = (css: string): boolean => /url\s*\(\s*(?!['"]?#)[^)]*\)/i.test(css);
const withoutRemoteUrls = (css: string): string => css.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, "none");

/** True for hrefs that stay inside the document or the data itself. */
function isLocalHref(href: string): boolean {
  const v = href.trim();
  return v === "" || v.startsWith("#") || /^data:image\//i.test(v);
}

/**
 * Takes out of a parsed SVG that came from the network everything that could
 * run script or load a remote resource once it is imported into the page:
 * active elements (matched by local name, so `svg:script` does not slip by),
 * event handler attributes, hrefs that leave the document (links, <use>,
 * <image>, and the SMIL elements that could write one back), and remote
 * url() in styles. Local references (#gradient, data:image) are kept.
 */
export function scrubSvg(svgDoc: Document): void {
  for (const el of [...svgDoc.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (ANIMATION_TAGS.has(tag)) {
      const target = (el.getAttribute("attributeName") ?? "").trim().toLowerCase();
      if (HREF_ATTRS.has(target) || target.startsWith("on")) {
        el.remove();
        continue;
      }
    }
    if (tag === "style") {
      // keep local styling (url(#gradient) etc.) but strip remote loads
      const css = el.textContent || "";
      if (/@import|url\s*\(/i.test(css)) {
        el.textContent = withoutRemoteUrls(css.replace(/@import[^;]*;?/gi, ""));
      }
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (HREF_ATTRS.has(name)) {
        // <use> must point inside the document; a link or an <image> may
        // also carry inline image data. Nothing may leave the document:
        // that covers javascript: however it is spelled.
        const local = tag === "use" ? attr.value.trim().startsWith("#") : isLocalHref(attr.value);
        if (!local) {
          if (tag === "use") el.remove();
          else el.removeAttribute(attr.name);
        }
      } else if (name === "style" && (hasRemoteUrl(attr.value) || /expression\s*\(/i.test(attr.value))) {
        // fill:url(#grad) is fine; url(https://...) is not
        el.setAttribute(attr.name, withoutRemoteUrls(attr.value).replace(/expression\s*\(/gi, "none("));
      }
    }
  }
}

/**
 * An SVG fetched from the network, scrubbed and ready to insert; null when
 * it is not a valid SVG document.
 */
export function svgFromUntrustedMarkup(markup: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) {
    return null;
  }
  scrubSvg(doc);
  return document.importNode(root, true) as unknown as SVGSVGElement;
}
