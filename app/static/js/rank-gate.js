// S11: runs in <head>, before first paint. The page arrives ranked for the default
// profile; only a stored profile whose ranking fields differ, or a device with any
// read history at all (S15: opened or shown, since the build never has history to
// score with), hides the headlines and loads rerank.js, which re-ranks with the same
// ranker.js and shows them again, so no row ever visibly moves. `canonical` is a
// byte-identical copy of ranker.js's.
//
// S15's seen penalty needs the read history synchronously, before that first paint,
// the same way this gate already reads the stored profile synchronously; IndexedDB
// (history/store.js, the record of truth) is async and cannot supply that. A compact
// summary in localStorage (history/summary.js: story id -> event time, nothing else)
// is kept in step with every write and read here instead.
(function () {
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  var root = document.documentElement;
  try {
    var raw = localStorage.getItem("almanac.profile.store.v1");
    var p = null;
    if (raw) {
      var stored = JSON.parse(raw).history;
      p = stored[stored.length - 1].profile;
    }
    var sameProfile = !p || canonical([p.topics, p.trust, p.boosts, p.mutes, p.seen_penalty, p.passes, p.standing_stories]) === root.getAttribute("data-rank-key");

    var summary = null;
    try {
      var sraw = localStorage.getItem("almanac.history.summary.v1");
      summary = sraw ? JSON.parse(sraw) : null;
    } catch (e) {
      summary = null;
    }
    var hasHistory = !!(summary && ((summary.opened && Object.keys(summary.opened).length) || (summary.shown && Object.keys(summary.shown).length)));

    if (sameProfile && !hasHistory) return;
    window.almanacProfile = p;
    window.almanacHistorySummary = summary;
    root.classList.add("rerank");
    var reveal = function () { root.classList.remove("rerank"); };
    setTimeout(reveal, 1500); // never leave the page hidden if the module fails
    var s = document.createElement("script");
    s.type = "module";
    s.src = "js/rerank.js";
    s.onerror = reveal;
    document.head.appendChild(s);
  } catch (e) {
    root.classList.remove("rerank");
  }
})();
