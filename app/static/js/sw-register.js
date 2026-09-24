// S18: registers the service worker from an external file, since the CSP forbids
// inline script (worker-src 'self'). Deferred past load so it never competes with
// first paint. A module worker, so sw.js can import js/sw-routes.js unchanged from its
// own Node unit test.
//
// No update prompt: sw.js never calls skipWaiting(), so a newly installed worker only
// takes over once no page is still controlled by the previous one, the browser's own
// lifecycle. Nothing here polls for an update or nags the reader to reload.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { type: "module" }).catch(() => {});
  });
}
