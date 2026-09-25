// S18: the service worker's routing decision, kept pure and separate from the cache
// side effects in sw.js, so it is unit-testable under Node (tests/js/sw-routes.test.js)
// and, H3, written into the classic service worker by the build (app/serviceworker.py
// inline_routes) with its `export` words removed, so it stays plain declarations only.
//
// `bodies/*` is S25's: the reader fetches article bodies lazily and caches them in
// IndexedDB. This module always returns BYPASS for them, so the service worker never
// intercepts or double-caches a body file.

export const STRATEGY = Object.freeze({
  PAGE: "page", // H1: a navigation to one of this app's pages: network-first, cached copy offline
  SHELL: "shell", // precached app shell: CSS, JS, fonts, manifest, icons (and pages, as data)
  POOL: "pool", // pool.json: network-first, cached copy as the offline fallback
  IMAGE: "image", // this app's own images: cache-first, size-capped, expiring
  BYPASS: "bypass", // not intercepted: bodies/*, /api/*, and anything else off this app's CSP
});

/**
 * `request` is `{url, destination, mode}` (a real FetchEvent's `request` duck-types this).
 * `origin` is the app's own origin (`self.location.origin` in the worker).
 */
export function strategyFor(request, origin) {
  const url = new URL(request.url, origin);
  const sameOrigin = url.origin === origin;
  if (sameOrigin && /(?:^|\/)bodies\//.test(url.pathname)) return STRATEGY.BYPASS;
  // W1: the interests sync's own endpoint (a Pages Function) is never cached: its GET is
  // the caller's live value, and a PUT never reaches the worker's GET-only handler.
  if (sameOrigin && url.pathname.startsWith("/api/")) return STRATEGY.BYPASS;
  if (sameOrigin && /(?:^|\/)pool\.json$/.test(url.pathname)) return STRATEGY.POOL;
  if (sameOrigin && request.mode === "navigate") return STRATEGY.PAGE;
  // H2: article photos (cross-origin) are never intercepted. The worker runs under the
  // site's own CSP, whose connect-src is 'self', so its fetch() of another origin's photo
  // was refused and every photo on a page the worker controlled failed to load. The page
  // loads them itself, under img-src https:, and the CSP stays as strict as it is.
  if (request.destination === "image") return sameOrigin ? STRATEGY.IMAGE : STRATEGY.BYPASS;
  if (sameOrigin) return STRATEGY.SHELL;
  return STRATEGY.BYPASS; // no other cross-origin request is expected under this app's CSP
}
