// S37: the body sanitizer (app/static/js/sanitize.js) against hostile fixtures.
//
// The URL rules run here in Node. The fixtures need the browser's own HTML parser, the
// one the reader will use, so they run in headless Chrome over the DevTools protocol:
// each fixture is sanitized, appended to a live page with no CSP (so anything that got
// through would run), serialized for the exact-output check, walked for the allowlist
// invariants, and after a wait window.__pwned must still be empty. Chrome is on the CI
// runner; without it locally this part is skipped, and on CI it fails instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { ATTRIBUTES, DROP, ELEMENTS, safeImageSrc, safeLink } from "../../app/static/js/sanitize.js";
import { BASE, BENIGN, HOSTILE, handlerFixtures } from "./hostile-bodies.js";
import { CHROME, launch, serve, sleep } from "../browser/cdp.mjs";

const STATIC = fileURLToPath(new URL("../../app/static/", import.meta.url));

test("only https links survive; http is upgraded; every other scheme is refused", () => {
  const refused = ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)",
    "\u0000javascript:alert(1)", " \u000e javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd",
    "blob:https://a.example/1", "ftp://a.example/", "mailto:a@example.com", "about:blank", "", "   ", null, undefined, 42];
  for (const value of refused) assert.equal(safeLink(value, BASE), null, String(value));
  assert.equal(safeLink("http://a.example/x", BASE), "https://a.example/x");
  assert.equal(safeLink("https://u:p@a.example/", BASE), "https://a.example/");
  assert.equal(safeLink("/x", BASE), "https://news.example/x");
  assert.equal(safeLink("/x"), null, "a relative link with no base is refused");
});

test("image sources are https only, never upgraded", () => {
  assert.equal(safeImageSrc("https://img.example/a.jpg"), "https://img.example/a.jpg");
  for (const value of ["http://img.example/a.jpg", "data:image/png;base64,AA==", "javascript:x", "//img.example/a.jpg"]) {
    assert.equal(safeImageSrc(value), null, value);
  }
  assert.equal(safeImageSrc("//img.example/a.jpg", BASE), "https://img.example/a.jpg");
});

test("the allowlist is the brief's set and nothing dangerous is on it", () => {
  assert.deepEqual([...ELEMENTS].sort(), ["a", "b", "blockquote", "br", "em", "figcaption", "figure", "h2", "h3", "h4", "h5", "h6", "i", "img", "li", "ol", "p", "strong", "ul"]);
  const attrs = new Set(Object.values(ATTRIBUTES).flat());
  assert.deepEqual([...attrs].sort(), ["alt", "height", "href", "src", "width"]);
  for (const tag of ["script", "style", "iframe", "svg", "math", "form", "object", "embed", "template"]) assert.ok(DROP.includes(tag), tag);
});

const PAGE_CHECK = `(async (fixtures, elements, attrs) => {
  const { sanitizeBody } = await import("/js/sanitize.js");
  const results = [];
  for (const f of fixtures) {
    const box = document.createElement("div");
    box.dataset.fixture = f.name;
    const out = sanitizeBody(f.html, { base: ${JSON.stringify(BASE)} });
    const isFragment = out instanceof DocumentFragment;
    box.append(out);
    document.body.append(box);
    const bad = [];
    for (const el of box.querySelectorAll("*")) {
      if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" || !elements.includes(el.localName)) bad.push("element " + el.localName);
      for (const a of el.attributes) {
        const ok = (attrs[el.localName] || []).includes(a.name) || (el.localName === "a" && (a.name === "target" || a.name === "rel"))
          || (el.localName === "img" && ["loading", "decoding", "referrerpolicy"].includes(a.name));
        if (!ok) bad.push("attribute " + el.localName + "." + a.name);
      }
      if (el.localName === "a" && (!el.getAttribute("href").startsWith("https://") || el.target !== "_blank" || el.rel !== "noopener noreferrer")) bad.push("link " + el.getAttribute("href"));
      if (el.localName === "img" && !el.getAttribute("src").startsWith("https://")) bad.push("img " + el.getAttribute("src"));
    }
    results.push({ name: f.name, isFragment, html: box.innerHTML, bad });
  }
  return results;
})`;

const HANDLER_NAMES = `(() => {
  const names = new Set();
  const sources = [window, document, document.body, document.createElement("video"), document.createElement("details"),
    document.createElement("img"), document.createElement("input"), document.createElement("iframe"), document.createElement("dialog"),
    document.createElementNS("http://www.w3.org/2000/svg", "svg")];
  for (const s of sources) for (const k in s) if (/^on[a-z]+$/.test(k)) names.add(k);
  return [...names].sort();
})()`;

test("hostile fixtures through the real parser: neutralized, benign markup kept, nothing runs",
  { skip: !CHROME && !process.env.CI ? "no Chrome on this machine" : false, timeout: 60000 }, async () => {
    // T3: site and chrome each get their own try/finally around the call that creates
    // them, not one shared block below both. launch() awaited a Chrome that never
    // becomes ready throws before its own close() exists; if that throw happened
    // inside a block that also owned site's cleanup, site.close() never ran and the
    // http server it holds open kept node --test (and the CI job) alive for the full
    // 5-minute job timeout after the test itself had already failed and reported.
    const site = await serve(STATIC, {}, { "/blank.html": "<!doctype html><title>s37</title><body></body>" });
    try {
      const chrome = await launch("s37-sanitize");
      try {
        await chrome.send("Page.enable");
        await chrome.send("Page.navigate", { url: `${site.origin}/blank.html` });
        await sleep(500);
        await chrome.evaluate("window.__pwned = []");
        const handlers = await chrome.evaluate(HANDLER_NAMES);
        assert.ok(handlers.length >= 80, `found only ${handlers.length} on* handler names`);
        const fixtures = [...HOSTILE, ...handlerFixtures(handlers), BENIGN];
        const results = await chrome.evaluate(`${PAGE_CHECK}(${JSON.stringify(fixtures)}, ${JSON.stringify(ELEMENTS)}, ${JSON.stringify(ATTRIBUTES)})`);
        // Give every error, load, focus and animation event its chance to fire.
        await chrome.evaluate("document.querySelectorAll('[data-fixture] *').forEach((el) => { el.focus?.(); el.dispatchEvent(new Event('mouseover')); })");
        await sleep(1500);
        const pwned = await chrome.evaluate("window.__pwned");
        assert.deepEqual(pwned, [], "a payload ran");
        const failures = [];
        for (const [i, r] of results.entries()) {
          const f = fixtures[i];
          if (!r.isFragment) failures.push(`${f.name}: sanitizeBody must return a DocumentFragment`);
          if (r.bad.length) failures.push(`${f.name}: ${r.bad.join(", ")} in ${r.html}`);
          if (/javascript:|vbscript:|data:|srcdoc|style=|\son[a-z]+=|<script|<svg|<math|<iframe|<form/i.test(r.html)) failures.push(`${f.name}: hostile text in ${r.html}`);
          if (f.out !== undefined && r.html !== f.out) failures.push(`${f.name}: got ${JSON.stringify(r.html)}, want ${JSON.stringify(f.out)}`);
        }
        assert.deepEqual(failures, []);
        console.log(`# sanitizer: ${HOSTILE.length} hostile fixtures + ${handlers.length} on* handler fixtures + 1 benign, 0 payloads ran`);
      } finally {
        chrome.close();
      }
    } finally {
      site.close();
    }
  });
