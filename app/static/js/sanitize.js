// S37: the allowlist sanitizer for article bodies (R26). Feed HTML is hostile input.
//
// The raw body_html from bodies/<id>.json (S22) is parsed by the browser's own inert
// parser (DOMParser: no browsing context, so nothing in it runs or loads), then walked.
// Nothing from that tree is ever moved into the page and no string is ever handed to
// innerHTML: every kept element is created fresh in the page's document, and each of its
// few attributes is set from a value this module checked. Everything else goes:
//
// - an element not on ELEMENTS is unwrapped, its sanitized children kept as text and
//   markup (div, span, section, table and the like), unless it is on DROP, whose
//   whole subtree goes (script, style, iframe, object, form, svg, math and the like);
// - an element outside the HTML namespace (SVG, MathML) goes with its subtree;
// - an attribute not on ATTRIBUTES is never read, so every on* handler, style, srcdoc,
//   class, id and srcset is gone by construction;
// - a link is kept only if it resolves to https (http is upgraded), and always gets
//   target="_blank" and rel="noopener noreferrer"; any other scheme (javascript:,
//   data:, vbscript:, file:, blob:) leaves the link's text as plain text;
// - an image is kept only with an https src; it loads lazily with no referrer.
//
// Only the body goes through here; titles, deks and every other feed field render as
// text only (R26). The reader (S25) calls sanitizeBody and appends the fragment.

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Kept elements and the attributes each may carry (values checked below). */
export const ATTRIBUTES = Object.freeze({
  p: [], br: [],
  h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: [], li: [],
  blockquote: [],
  em: [], strong: [], i: [], b: [],
  a: ["href"],
  figure: [], figcaption: [],
  img: ["src", "alt", "width", "height"],
});
export const ELEMENTS = Object.freeze(Object.keys(ATTRIBUTES));

/** A feed h1 would compete with the reader's own headline, so it becomes an h2. */
const RENAME = Object.freeze({ h1: "h2" });

/** Dropped with everything inside them, never unwrapped. */
export const DROP = Object.freeze([
  "script", "style", "template", "noscript", "noembed", "noframes", "xmp", "plaintext",
  "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "fencedframe",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output",
  "label", "fieldset", "legend",
  "svg", "math", "canvas", "video", "audio", "source", "track",
  "map", "area", "link", "meta", "base", "title", "head", "dialog", "slot",
]);

const KEEP = new Set(ELEMENTS);
const GONE = new Set(DROP);
const MAX_DIMENSION = 10000;

function parseUrl(value, base) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

/**
 * The href a body link may carry: the WHATWG URL parser (the browser's own) resolves it
 * against the article's url, which strips the tabs, newlines and control characters a
 * hostile scheme hides behind and lowercases the scheme. Only https survives; http is
 * upgraded. Credentials are dropped. Returns the canonical href, or null.
 */
export function safeLink(value, base) {
  const url = parseUrl(value, base);
  if (!url) return null;
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || !url.hostname) return null;
  url.username = "";
  url.password = "";
  return url.href;
}

/** An image src: https only, never upgraded (the S38/S39 rule), else null. */
export function safeImageSrc(value, base) {
  const url = parseUrl(value, base);
  if (!url || url.protocol !== "https:" || !url.hostname) return null;
  url.username = "";
  url.password = "";
  return url.href;
}

function dimension(value) {
  if (typeof value !== "string" || !/^\s*[0-9]{1,5}\s*$/.test(value)) return null;
  const n = Number(value);
  return n > 0 && n <= MAX_DIMENSION ? String(n) : null;
}

function copyElement(node, tag, doc, base) {
  if (tag === "a") {
    const href = safeLink(node.getAttribute("href"), base);
    if (href === null) return null; // unwrapped: its text stays, the link does not
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    return a;
  }
  if (tag === "img") {
    const src = safeImageSrc(node.getAttribute("src"), base);
    if (src === null) return undefined; // dropped outright: an img has no children
    const img = doc.createElement("img");
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
    const alt = node.getAttribute("alt");
    img.setAttribute("alt", typeof alt === "string" ? alt : "");
    const width = dimension(node.getAttribute("width"));
    const height = dimension(node.getAttribute("height"));
    if (width && height) {
      img.setAttribute("width", width);
      img.setAttribute("height", height);
    }
    img.setAttribute("src", src); // last, so lazy loading and no-referrer already apply
    return img;
  }
  return doc.createElement(tag);
}

function walk(parent, out, doc, base) {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3) {
      out.appendChild(doc.createTextNode(node.data));
      continue;
    }
    if (node.nodeType !== 1) continue; // comments, processing instructions, doctypes
    if (node.namespaceURI !== HTML_NS) continue; // SVG and MathML, with their subtrees
    const name = String(node.localName).toLowerCase();
    if (GONE.has(name)) continue;
    const tag = RENAME[name] || name;
    if (!KEEP.has(tag)) {
      walk(node, out, doc, base); // unknown container: keep what is inside it
      continue;
    }
    const copy = copyElement(node, tag, doc, base);
    if (copy === undefined) continue;
    if (copy === null) {
      walk(node, out, doc, base);
      continue;
    }
    if (tag !== "img" && tag !== "br") walk(node, copy, doc, base);
    out.appendChild(copy);
  }
}

/**
 * Sanitize an already parsed tree: every child of `root` is copied into a new
 * DocumentFragment of `doc` by the rules above. Exposed for tests; the reader calls
 * sanitizeBody.
 */
export function sanitizeTree(root, doc, base) {
  const fragment = doc.createDocumentFragment();
  if (root) walk(root, fragment, doc, base);
  return fragment;
}

/**
 * The one entry point for body HTML. Returns a DocumentFragment of the page's document,
 * never a string: append it, do not serialize it into innerHTML.
 *
 * @param {string} html - body_html from bodies/<id>.json, untrusted
 * @param {{base?: string, doc?: Document}} options - base is the article's own url, so
 *   relative links resolve to the source; doc defaults to the page's document
 */
export function sanitizeBody(html, { base, doc = globalThis.document } = {}) {
  const parsed = new doc.defaultView.DOMParser().parseFromString(String(html ?? ""), "text/html");
  return sanitizeTree(parsed.body, doc, base);
}
