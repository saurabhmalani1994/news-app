// S18: registers the service worker from an external file, since the CSP forbids
// inline script (worker-src 'self'). Deferred past load so it never competes with
// first paint. A module worker, so sw.js can import js/sw-routes.js unchanged from its
// own Node unit test.
//
// H1: an absolute "/sw.js" (pages now live at "/profile", "/health"), and
// updateViaCache "none", so neither sw.js nor the module it imports is ever read from
// the HTTP cache during an update check. The worker itself skips waiting and claims
// open pages, so a fixed deploy takes over on the next launch. No update prompt.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { type: "module", updateViaCache: "none" }).catch(() => {});
  });
}
