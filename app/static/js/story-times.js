// J22: each card's "Written ... · Pulled ..." line (app/build.py TIMES), written out in
// this phone's own time zone from the row's ISO times. A classic, blocking script right
// after Today's lists, so the rows it fills are not yet painted; the line's height is
// fixed in style.css either way, so nothing moves. Rows the other tabs clone later carry
// the text with them; a row the device re-fronts (tiers.js placeFace) calls
// window.almanacFillTimes on itself again.
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dayStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // "9:40 a.m." today, "yesterday 6:05 p.m.", else "Sep 26, 6:05 p.m.".
  function when(iso, now) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    var h = d.getHours();
    var time = (h % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0") + (h < 12 ? " a.m." : " p.m.");
    var days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
    if (days === 0) return time;
    if (days === 1) return "yesterday " + time;
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + time;
  }

  function fill(root) {
    var now = new Date();
    (root || document).querySelectorAll(".story-times").forEach(function (line) {
      var written = when(line.getAttribute("data-written"), now);
      var pulled = when(line.getAttribute("data-pulled"), now);
      line.textContent = [written && "Written " + written, pulled && "Pulled " + pulled].filter(Boolean).join(" \u00b7 ");
    });
  }

  window.almanacFillTimes = fill;
  fill(document);
})();
