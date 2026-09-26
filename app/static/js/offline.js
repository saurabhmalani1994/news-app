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
    if (minutes < 60) return Math.max(minutes, 1) + " min ago";
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + "h ago";
    return Math.floor(minutes / (24 * 60)) + "d ago";
  }

  // T2: #rank-input is written compact (app/page_input.py); a byte-for-byte copy of
  // decodeInput in js/page-input.js, which tests/js/page-input.test.js diffs against it.
  function decodeInput(raw) {
    if (!raw || !Array.isArray(raw["~s"])) return raw;
    var table = raw["~s"];
    function string(text) {
      if (text.charCodeAt(0) !== 126) return text;
      if (text.charCodeAt(1) === 126) return text.slice(1);
      var caret = text.indexOf("^");
      if (caret < 0) return table[parseInt(text.slice(1), 36)];
      return table[parseInt(text.slice(1, caret), 36)].slice(0, parseInt(text.slice(caret + 1), 36)) + "\u2026";
    }
    function rows(keys, body) {
      var names = keys.map(string);
      return body.map(function (row) {
        var obj = {};
        for (var i = 0; i < names.length; i++) if (row[i] !== "~-") obj[names[i]] = value(row[i]);
        return obj;
      });
    }
    function value(v) {
      if (typeof v === "string") return string(v);
      if (Array.isArray(v)) return v.map(value);
      if (!v || typeof v !== "object") return v;
      var obj = {};
      if (v["~o"]) {
        var values = v["~k"] ? rows(v["~k"], v["~r"]) : v["~v"].map(value);
        v["~o"].forEach(function (k, i) { obj[string(k)] = values[i]; });
        return obj;
      }
      if (v["~k"]) return rows(v["~k"], v["~r"]);
      Object.keys(v).forEach(function (k) { obj[k] = value(v[k]); });
      return obj;
    }
    return value(raw.v);
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
      input = decodeInput(JSON.parse(template.content.textContent));
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
    // U3: the age is its own span on the meta's first line, and line 2 carries it as
    // data-age for the layout that leads line 2 with it (app/build.py _meta).
    var AGE_RE = /\d+(?: min|[hd]) ago$/;
    document.querySelectorAll("li.story[data-sid]").forEach(function (li) {
      var sid = li.dataset.sid;
      var article = articleById[li.dataset.face || leadOf[sid] || sid]; // B5: a row the device re-fronted
      if (!article) return;
      var fresh = relativeAge(article.published_at, now);
      if (!fresh) return;
      var meta = li.querySelector(".meta-age");
      if (meta && AGE_RE.test(meta.textContent)) {
        meta.textContent = meta.textContent.replace(AGE_RE, fresh);
      }
      var second = li.querySelector(".meta-line--2[data-age]");
      if (second) second.setAttribute("data-age", fresh);
    });
  });
})();
