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
// H1: pages are precached at the URLs Cloudflare Pages serves ("/", "/profile"), never
// their file names, which Pages answers with a 308. Chrome refuses a redirected
// response for a navigation, so the S18 worker, which precached "/index.html", blanked
// every launch after the first. Nothing redirected is ever stored or served for a page
// now (withoutRedirect below), whatever the precache list says.
//
// Pages (navigations) are network-first with a short timeout: the HTML carries the
// build-time ranked news, so a cache-first page would show old news while online. The
// cached copy is the offline fallback. Everything else in the shell stays cache-first.
//
// Update flow: install calls skipWaiting() and activate claims every open page, so a
// fixed worker replaces a broken one at once instead of waiting for every tab to
// close. That is what lets a phone stuck on the S18 worker heal on its own.
//
// H2: a page and its scripts always come from one build. Every script, stylesheet and
// shell data file is named `?v=<build>` by the page that uses it and precached under
// that exact key, so a new page fetched over the network never finds an older build's
// file in an older cache (the You page crash: U2's page ran S10's cached script). A page
// is stored only when it is this worker's own build (its almanac-build meta), so the
// offline copy always matches this cache. Activate keeps the one previous build's cache
// next to this one, so a page from that build still open when this worker takes over
// keeps getting its own files; every older cache is deleted.
import { STRATEGY, strategyFor } from "./js/sw-routes.js";

const VERSION = "@@CACHE_VERSION@@";
const SHELL_CACHE = `almanac-shell-${VERSION}`;
const POOL_CACHE = "almanac-pool-v1";
const IMAGE_CACHE = "almanac-images-v1";
const IMAGE_INDEX_URL = new URL("/__sw-image-index__", self.location.origin).href;
const IMAGE_MAX_ENTRIES = 60;
const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRECACHE_URLS = @@PRECACHE_URLS@@;
const NAVIGATION_TIMEOUT_MS = 3000;
// H2: when this cache was filled, so activate can tell the previous build from older ones.
const INSTALLED_URL = new URL("/__sw-installed__", self.location.origin).href;
const BUILD_MARK = `<meta name="almanac-build" content="${VERSION}">`;

/** True when a page response is this worker's own build. */
async function isThisBuild(response) {
  try {
    return (await response.clone().text()).includes(BUILD_MARK);
  } catch {
    return false;
  }
}

/** A response Chrome will accept for a navigation. A fetch that followed a redirect
 * carries `redirected: true`, and Chrome fails a navigation answered with one
 * (net::ERR_FAILED, a blank page). Rebuilt from its own body, status and headers, the
 * copy is an ordinary response with no redirect in its history. */
async function withoutRedirect(response) {
  if (!response.redirected) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Precache every shell URL. Not cache.addAll: that stores whatever the fetch resolved
 * to, redirects included. Any failure fails the install, as addAll would. */
async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(PRECACHE_URLS.map(async (url) => {
    const response = await fetch(new Request(url, { cache: "no-cache" }));
    if (!response.ok) throw new Error(`precache ${url}: HTTP ${response.status}`);
    const page = !/[.?]/.test(url.split("/").pop()) || url.endsWith("/");
    // H2: a page from another deploy (one landed mid-install) fails this install; the
    // worker of that newer deploy installs instead.
    if (page && !(await isThisBuild(response))) throw new Error(`precache ${url}: not build ${VERSION}`);
    await cache.put(url, await withoutRedirect(response));
  }));
  await cache.put(INSTALLED_URL, new Response(String(Date.now())));
}

async function installedAt(key) {
  const stamp = await (await caches.open(key)).match(INSTALLED_URL);
  return stamp ? Number(await stamp.text()) || 0 : 0;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const others = keys.filter((key) => key.startsWith("almanac-shell-") && key !== SHELL_CACHE);
    // H2: keep the newest other stamped cache (the previous build, for a page of it that
    // is still open); an H1 or older cache carries no stamp and is always deleted.
    const dated = await Promise.all(others.map(async (key) => [key, await installedAt(key)]));
    const previous = dated.filter(([, at]) => at > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
    await Promise.all(others.filter((key) => key !== previous).map((key) => caches.delete(key)));
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

const HOME_URL = new URL("/", self.location.origin).href;

/** The key a page is cached under: the canonical pretty URL Pages serves it at, with
 * no query, so "/index.html" and "/?x=1" both find "/", and "/profile.html" finds
 * "/profile". */
function pageKey(url) {
  const u = new URL(url);
  let path = u.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  else if (path.endsWith(".html")) path = path.slice(0, -".html".length);
  return new URL(path, self.location.origin).href;
}

/** Only the app's own pages (the precached ones) are ever stored from a navigation, so
 * a login or error page some other same-origin URL answers with never lands in the cache. */
const PAGE_KEYS = new Set(PRECACHE_URLS.map((url) => new URL(url, self.location.origin).href));

async function cachedPage(cache, url) {
  const cached = (await cache.match(pageKey(url))) || (await cache.match(HOME_URL));
  return cached ? withoutRedirect(cached) : undefined;
}

/** Pages: the network first, for up to NAVIGATION_TIMEOUT_MS, then the cached copy.
 * A fresh page from the network also refreshes the cached copy. A redirect (an old
 * "/profile.html" link) passes straight through for the browser to follow, uncached. */
async function pageNetworkFirst(event) {
  const { request } = event;
  const key = pageKey(request.url);
  const network = fetch(request).then(async (response) => {
    if (response.type !== "basic" || !response.ok || !PAGE_KEYS.has(key)) return response;
    const page = await withoutRedirect(response);
    // H2: only this build's page is stored, so the offline copy always matches this
    // cache's scripts; a newer deploy's page is shown but its own worker caches it.
    if (!(await isThisBuild(page))) return page;
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(key, page.clone());
    return page;
  });
  event.waitUntil(network.catch(() => {}));
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS); });
  const first = await Promise.race([network.catch(() => undefined), timedOut]);
  clearTimeout(timer);
  if (first && (first.ok || first.type === "opaqueredirect")) return first;
  const cached = await cachedPage(await caches.open(SHELL_CACHE), request.url);
  if (cached) return cached;
  return first || network; // nothing cached: the network's own answer, or its error
}

/** Shell files by their exact versioned URL. H2: a URL of another build is looked for
 * in the previous build's cache before the network, so a page of that build still open
 * gets its own file. */
async function shellCacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const v = new URL(request.url).searchParams.get("v");
  if (v && v !== VERSION) {
    const older = await caches.match(request);
    if (older) return older;
  }
  return fetch(request);
}

/** pool.json: the network first, the cached copy when the network fails. H1: a
 * redirect counts as a network failure. pool.json never moves, so a redirected answer
 * is a login page (Cloudflare Access, should a later slice add it) or a captive
 * portal, never the pool: it is not cached, and the cached pool answers instead. */
async function poolNetworkFirst(request) {
  const cache = await caches.open(POOL_CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch {
    response = undefined;
  }
  const failed = !response || response.redirected || response.type === "opaqueredirect";
  if (!failed) {
    if (isCacheable(response) && response.ok) await cache.put(request, response.clone());
    return response;
  }
  return (await cache.match(request)) || Response.error();
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
  if (strategy === STRATEGY.PAGE) { event.respondWith(pageNetworkFirst(event)); return; }
  if (strategy === STRATEGY.SHELL) { event.respondWith(shellCacheFirst(request)); return; }
  if (strategy === STRATEGY.POOL) { event.respondWith(poolNetworkFirst(request)); return; }
  if (strategy === STRATEGY.IMAGE) { event.respondWith(imageCacheFirst(request)); return; }
});
