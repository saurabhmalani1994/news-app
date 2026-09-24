// S18: the front page's offline state. Runs as a classic, blocking script placed right
// after the nameplate and the offline line in the HTML (app/build.py), so setting its
// text happens before the hero below is parsed or painted: no layout shift either way,
// since js/offline-gate.js already decided in <head> whether the line's box is shown
// at all. A classic script cannot statically `import`, so relativeAge below is kept
// byte-for-byte identical to js/offline-format.js's own copy, which is what
// tests/js/offline-format.test.js unit-tests (and diffs against this file).
//
// D1 noted the meta age on every row is computed once, at build time, against the
// pool's own generated_at; that is honest online (the pool is minutes old), but once a
// stale cache is all there is, "12m ago" can be hours wrong. Offline only, this
// recomputes every row's age against the device's real clock, from the same compact
// pool already embedded in #rank-input for the ranker (no extra fetch).
(function () {
  var root = document.documentElement;
  var line = document.getElementById("offline-line");
  if (!root.classList.contains("is-offline") || !line) return;

  // Keep in sync with relativeAge in js/offline-format.js.
  function relativeAge(publishedAt, now) {
    var then = Date.parse(publishedAt);
    if (Number.isNaN(then) || !now) return "";
    var minutes = Math.max(0, Math.floor((now - then) / 60000));
    if (minutes < 60) return Math.max(minutes, 1) + "m ago";
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + "h ago";
    return Math.floor(minutes / (24 * 60)) + "d ago";
  }

  var generatedAt = line.dataset.generatedAt;
  var age = relativeAge(generatedAt, Date.now());
  line.textContent = age ? "Offline. Showing news from " + age : "Offline. Showing cached news.";
  line.hidden = false;

  document.addEventListener("DOMContentLoaded", function () {
    var template = document.getElementById("rank-input");
    if (!template) return;
    var input;
    try {
      input = JSON.parse(template.content.textContent);
    } catch (e) {
      return;
    }
    var pool = input.pool || {};
    var leadOf = {};
    (pool.clusters || []).forEach(function (c) {
      if (c.lead) leadOf[c.id] = c.lead;
    });
    var articleById = {};
    (pool.articles || []).forEach(function (a) {
      articleById[a.id] = a;
    });
    var now = Date.now();
    var AGE_RE = /\d+[mhd] ago$/;
    document.querySelectorAll("li.story[data-sid]").forEach(function (li) {
      var sid = li.dataset.sid;
      var article = articleById[leadOf[sid] || sid];
      if (!article) return;
      var fresh = relativeAge(article.published_at, now);
      if (!fresh) return;
      var meta = li.querySelector(".meta-rest");
      if (meta && AGE_RE.test(meta.textContent)) {
        meta.textContent = meta.textContent.replace(AGE_RE, fresh);
      }
    });
  });
})();
