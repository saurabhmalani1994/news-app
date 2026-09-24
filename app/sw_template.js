// S18: Almanac's service worker. Registered from the external js/sw-register.js (the
// CSP forbids inline script). A module worker, so it can import the same routing
// decision sw-routes.js uses in its Node unit test (tests/js/sw-routes.test.js).
//
// The cache version and the precache URL list below are filled in by
// app/serviceworker.py at build time: the version is a hash of every precached file's
// own bytes, so a deploy that changes so much as one byte of the shell gets a new
// cache name, and `activate` deletes every shell cache that is not this one. A deploy
// that changes nothing in the shell reuses the same cache name and installs nothing
// new, which is correct too.
//
// Update flow: install never fast-forwards activation. A newly installed worker sits
// waiting until no page is still controlled by the previous one, the standard browser
// lifecycle, so an open tab is never swapped under the reader mid-session; the new
// version takes over the next time the app is launched with no other tab open. No
// update prompt, nothing polling for a new version.
import { STRATEGY, strategyFor } from "./js/sw-routes.js";

const VERSION = "@@CACHE_VERSION@@";
const SHELL_CACHE = `almanac-shell-${VERSION}`;
const POOL_CACHE = "almanac-pool-v1";
const IMAGE_CACHE = "almanac-images-v1";
const IMAGE_INDEX_URL = new URL("/__sw-image-index__", self.location.origin).href;
const IMAGE_MAX_ENTRIES = 60;
const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRECACHE_URLS = @@PRECACHE_URLS@@;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith("almanac-shell-") && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

/** A response is safe to cache only when the fetch did not resolve to a network-error
 * response. An opaque cross-origin response always reads back status 0, so this is the
 * one signal available for it; a same-origin response also gets its ok/status checked
 * by the caller. Never cache a `type: "error"` response (an opaque error). */
function isCacheable(response) {
  return Boolean(response) && response.type !== "error";
}

const SHELL_INDEX_URL = new URL("/index.html", self.location.origin).href;

async function shellCacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  // A navigation to "/" never matches the precached "/index.html" key by exact URL, so
  // it gets the same fallback a real offline navigation to any other path gets below.
  let cached = await cache.match(request);
  if (!cached && request.mode === "navigate") cached = await cache.match(SHELL_INDEX_URL);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (err) {
    if (request.mode === "navigate") {
      const shell = await cache.match(SHELL_INDEX_URL);
      if (shell) return shell;
    }
    throw err;
  }
}

async function poolNetworkFirst(request) {
  const cache = await caches.open(POOL_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response) && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function readImageIndex(cache) {
  const stored = await cache.match(IMAGE_INDEX_URL);
  if (!stored) return {};
  try {
    return await stored.json();
  } catch {
    return {};
  }
}

async function writeImageIndex(cache, index) {
  await cache.put(IMAGE_INDEX_URL, new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } }));
}

/** Enforces the image cache's size cap and expiry (no Cache Storage API does this on
 * its own): a small index of {url: cachedAtMs} kept as one JSON entry in the same
 * cache, pruned by age first, then by count, oldest first. */
async function touchImageIndex(cache, url) {
  const index = await readImageIndex(cache);
  index[url] = Date.now();
  const now = Date.now();
  for (const [key, ts] of Object.entries(index)) {
    if (now - ts > IMAGE_MAX_AGE_MS) {
      delete index[key];
      await cache.delete(key);
    }
  }
  const entries = Object.entries(index).sort((a, b) => a[1] - b[1]);
  while (entries.length > IMAGE_MAX_ENTRIES) {
    const [oldestUrl] = entries.shift();
    delete index[oldestUrl];
    await cache.delete(oldestUrl);
  }
  await writeImageIndex(cache, index);
}

async function imageCacheFirst(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    await cache.put(request, response.clone());
    await touchImageIndex(cache, request.url);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const strategy = strategyFor(request, self.location.origin);
  if (strategy === STRATEGY.BYPASS) return; // bodies/* (S25's IndexedDB cache) and anything else: untouched
  if (strategy === STRATEGY.SHELL) { event.respondWith(shellCacheFirst(request)); return; }
  if (strategy === STRATEGY.POOL) { event.respondWith(poolNetworkFirst(request)); return; }
  if (strategy === STRATEGY.IMAGE) { event.respondWith(imageCacheFirst(request)); return; }
});
