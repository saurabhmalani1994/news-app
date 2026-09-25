// S18: registers the service worker from an external file, since the CSP forbids
// inline script (worker-src 'self'). Deferred past load so it never competes with
// first paint.
//
// H1: an absolute "/sw.js" (pages now live at "/profile", "/health"), and
// updateViaCache "none", so sw.js is never read from the HTTP cache during an update
// check. The worker itself skips waiting and claims open pages, so a fixed deploy takes
// over on the next launch. No update prompt.
//
// H3: a classic worker (no `type`). Chrome fetches a module worker's script without
// cookies, so behind Cloudflare Access every install and update of the module worker
// met a login redirect and failed, and a phone kept its pre-Access worker, the one
// that had every article photo refused. Registering as classic makes this register()
// an update even where the stored worker's script is unchanged, and its fetch carries
// the Access cookie. When the new worker takes the page over, every photo that had
// failed under the old one is asked for again, so photos show on this same launch.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    for (const img of document.images) {
      const src = img.getAttribute("src");
      if (src && img.complete && img.naturalWidth === 0) img.setAttribute("src", src);
    }
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  });
}
