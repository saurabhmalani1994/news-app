// J22, J29: each card's "Published Sep 30, 5:15 a.m. · Added Sep 30, 6:17 a.m." line
// (app/build.py TIMES), written out with dates in this phone's own time zone from the
// row's ISO times: when the card's own article was published, and when Almanac first
// added it. An added time before the published one (an outlet's clock or time zone is
// off) is left out rather than shown backwards. The row's "5h ago" is recomputed from the
// same published time against this phone's clock, so the two always agree (the build
// wrote it against the edition's time). A classic, blocking script right after Today's
// lists, so the rows it fills are not yet painted; the line's height is fixed in
// style.css, so nothing moves. Rows the other tabs clone later carry the text with them;
// a row the device re-fronts (tiers.js placeFace) calls window.almanacFillTimes on itself.
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // "Sep 30, 5:15 a.m."
  function when(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + (h % 12 || 12) + ":" +
      String(d.getMinutes()).padStart(2, "0") + (h < 12 ? " a.m." : " p.m.");
  }

  // Keep in step with app/build.py relative_age.
  function ago(ms, now) {
    var minutes = Math.max(0, Math.floor((now - ms) / 60000));
    if (minutes < 60) return Math.max(minutes, 1) + " min ago";
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + "h ago";
    return Math.floor(minutes / (24 * 60)) + "d ago";
  }

  var AGE_RE = /\d+(?: min|[hd]) ago$/;

  function fill(root) {
    var now = Date.now();
    (root || document).querySelectorAll(".story-times").forEach(function (line) {
      var written = Date.parse(line.getAttribute("data-written") || "");
      var added = Date.parse(line.getAttribute("data-pulled") || "");
      if (isNaN(written)) {
        line.textContent = "";
        return;
      }
      var parts = ["Published " + when(written)];
      if (!isNaN(added) && added >= written) parts.push("Added " + when(added));
      line.textContent = parts.join(" \u00b7 ");
      var li = line.closest("li");
      var age = li && li.querySelector(".meta-age");
      if (age && AGE_RE.test(age.textContent)) age.textContent = age.textContent.replace(AGE_RE, ago(written, now));
      var second = li && li.querySelector(".meta-line--2[data-age]");
      if (second) second.setAttribute("data-age", ago(written, now));
    });
  }

  window.almanacFillTimes = fill;
  fill(document);
})();
