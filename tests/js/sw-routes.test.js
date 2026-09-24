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
  for (const path of ["/", "/index.html", "/profile.html", "/tokens.css", "/style.css",
    "/js/tabs.js", "/js/sw-routes.js", "/fonts/Newsreader-Bold-latin.woff2",
    "/manifest.webmanifest", "/icons/icon-192.png"]) {
    assert.equal(strategyFor(req(ORIGIN + path), ORIGIN), STRATEGY.SHELL, path);
  }
});

test("pool.json is the network-first strategy, at the root or nested", () => {
  assert.equal(strategyFor(req(ORIGIN + "/pool.json"), ORIGIN), STRATEGY.POOL);
});

test("bodies/* is never intercepted: S25's reader owns it in IndexedDB", () => {
  assert.equal(strategyFor(req(ORIGIN + "/bodies/a1.json"), ORIGIN), STRATEGY.BYPASS);
  assert.equal(strategyFor(req(ORIGIN + "/bodies/nested/a1.json"), ORIGIN), STRATEGY.BYPASS);
});

test("an <img> request is the image strategy whether same-origin or cross-origin", () => {
  assert.equal(strategyFor(req("https://img.example/a.jpg", "image"), ORIGIN), STRATEGY.IMAGE);
  assert.equal(strategyFor(req(ORIGIN + "/icons/icon-192.png", "image"), ORIGIN), STRATEGY.IMAGE);
});

test("a cross-origin request that is not an image is bypassed, never cached", () => {
  assert.equal(strategyFor(req("https://openrouter.ai/api/v1/chat"), ORIGIN), STRATEGY.BYPASS);
});

test("pool.json still routes to POOL even where an image destination would otherwise win, since it is checked first", () => {
  assert.equal(strategyFor(req(ORIGIN + "/pool.json", "image"), ORIGIN), STRATEGY.POOL);
});
