// S11: runs in <head>, before first paint. The page arrives ranked for the default
// profile; only a stored profile whose ranking fields differ hides the headlines and
// loads rerank.js, which re-ranks with the same ranker.js and shows them again, so no
// row ever visibly moves. `canonical` is a byte-identical copy of ranker.js's.
(function () {
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  var root = document.documentElement;
  try {
    var raw = localStorage.getItem("almanac.profile.store.v1");
    if (!raw) return;
    var history = JSON.parse(raw).history;
    var p = history[history.length - 1].profile;
    if (canonical([p.topics, p.trust, p.boosts, p.mutes, p.seen_penalty, p.passes]) === root.getAttribute("data-rank-key")) return;
    window.almanacProfile = p;
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
