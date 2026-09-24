// S18 proof: which cache strategy the service worker picks for a request. sw.js (the
// real worker) imports this same module, so this test exercises the exact routing code
// the browser runs, not a copy of it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { STRATEGY, strategyFor } from "../../app/static/js/sw-routes.js";

const ORIGIN = "https://almanac-dt5.pages.dev";

function req(url, destination = "") {
  return { url, destination };
}

test("the app shell (html, css, js, fonts, manifest, icons) is the precached strategy", () => {
  for (const path of ["/", "/profile", "/health", "/tokens.css", "/style.css",
    "/js/tabs.js", "/js/sw-routes.js", "/fonts/Newsreader-Bold-latin.woff2",
    "/manifest.webmanifest", "/icons/icon-192.png"]) {
    assert.equal(strategyFor(req(ORIGIN + path), ORIGIN), STRATEGY.SHELL, path);
  }
});

test("H1: a navigation to any page of the app is the network-first page strategy", () => {
  for (const path of ["/", "/profile", "/health", "/index.html", "/profile.html", "/?x=1"]) {
    assert.equal(strategyFor({ url: ORIGIN + path, destination: "document", mode: "navigate" }, ORIGIN), STRATEGY.PAGE, path);
  }
  // A cross-origin navigation (a source link) is never intercepted.
  assert.equal(strategyFor({ url: "https://example.com/a", destination: "document", mode: "navigate" }, ORIGIN), STRATEGY.BYPASS);
  // bodies/* stays S25's even if something ever navigates to one.
  assert.equal(strategyFor({ url: ORIGIN + "/bodies/a1.json", mode: "navigate" }, ORIGIN), STRATEGY.BYPASS);
});

test("pool.json is the network-first strategy, at the root or nested", () => {
  assert.equal(strategyFor(req(ORIGIN + "/pool.json"), ORIGIN), STRATEGY.POOL);
});

test("bodies/* is never intercepted: S25's reader owns it in IndexedDB", () => {
  assert.equal(strategyFor(req(ORIGIN + "/bodies/a1.json"), ORIGIN), STRATEGY.BYPASS);
  assert.equal(strategyFor(req(ORIGIN + "/bodies/nested/a1.json"), ORIGIN), STRATEGY.BYPASS);
});

// H2: this test used to require IMAGE for a cross-origin photo too. That was wrong: the
// worker's fetch() of another origin is refused by the site's CSP (connect-src 'self'),
// so every photo under the worker failed. Cross-origin photos are bypassed now.
test("an <img> request is the image strategy same-origin, and bypassed cross-origin", () => {
  assert.equal(strategyFor(req("https://img.example/a.jpg", "image"), ORIGIN), STRATEGY.BYPASS);
  assert.equal(strategyFor(req(ORIGIN + "/icons/icon-192.png", "image"), ORIGIN), STRATEGY.IMAGE);
});

test("a cross-origin request that is not an image is bypassed, never cached", () => {
  assert.equal(strategyFor(req("https://openrouter.ai/api/v1/chat"), ORIGIN), STRATEGY.BYPASS);
});

test("pool.json still routes to POOL even where an image destination would otherwise win, since it is checked first", () => {
  assert.equal(strategyFor(req(ORIGIN + "/pool.json", "image"), ORIGIN), STRATEGY.POOL);
});
