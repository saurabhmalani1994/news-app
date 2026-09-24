// S17: runs as a classic, blocking script placed right after the pool-age line in
// app/health.py, so its text is set before anything below it is parsed or painted, the
// same zero-layout-shift idiom js/offline.js uses for the front page's offline line
// (S18). A classic script cannot statically `import`, so relativeAge, isStale and
// poolAgeText below are kept byte-for-byte identical to js/health-format.js's own
// copies; tests/js/health-format.test.js diffs the two.
//
// The build writes an honest but frozen age (app/health.py, against the pool's own
// generated_at); once a stale cache is all there is, that number only grows more wrong.
// This recomputes it against the device's real clock, which keeps advancing offline.
(function () {
  var el = document.getElementById("pool-age");
  if (!el) return;

  // Keep in sync with relativeAge in js/offline-format.js.
  function relativeAge(publishedAt, now) {
    var then = Date.parse(publishedAt);
    if (Number.isNaN(then) || !now) return "";
    var minutes = Math.max(0, Math.floor((now - then) / 60000));
    if (minutes < 60) return Math.max(minutes, 1) + "m ago";
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + "h ago";
    return Math.floor(minutes / (24 * 60)) + "d ago";
  }

  // Keep in sync with STALE_THRESHOLD_MS and isStale in js/health-format.js.
  var STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
  function isStale(generatedAt, now) {
    var then = Date.parse(generatedAt);
    if (Number.isNaN(then) || !now) return false;
    return now - then > STALE_THRESHOLD_MS;
  }

  // Keep in sync with poolAgeText in js/health-format.js.
  function poolAgeText(generatedAt, now) {
    var age = relativeAge(generatedAt, now);
    if (!age) return "Pool age unknown.";
    return isStale(generatedAt, now) ? "Stale. Last updated " + age + "." : "Updated " + age + ".";
  }

  var generatedAt = el.dataset.generatedAt;
  var now = Date.now();
  el.textContent = poolAgeText(generatedAt, now);
  if (isStale(generatedAt, now)) {
    document.getElementById("pool-age-block").classList.add("is-stale");
  }
})();
