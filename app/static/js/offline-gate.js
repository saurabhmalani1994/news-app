// S18: runs in <head>, before anything in <body> is parsed or painted, so the offline
// line's visibility is decided before first paint and never causes a layout shift, the
// same idiom js/rank-gate.js uses for the re-rank hide/reveal.
//
// navigator.onLine is the signal, not "was this page served from cache": the app shell
// is cache-first by design (S18's own service worker), so a fast, freshly cached load
// while online is not "offline" and must not show the line. This also works unchanged
// inside a future TWA wrapper, which shares Chrome's own connectivity state.
(function () {
  try {
    if (navigator.onLine === false) {
      document.documentElement.classList.add("is-offline");
    }
  } catch (e) {
    // no navigator.onLine support: never claim to be offline
  }
})();
