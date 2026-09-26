// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26). S39: a row's
// photo follows its tier by the build's own rule (app/images.py): the story's chosen
// hero photo in the hero, the lead's thumbnail in the river, none elsewhere; only an
// https url reaches src. S13: the order is Today after the post-passes (passes.js), the
// same code the build ran; a row the passes removed (a mute) leaves the page, and each
// row's other-side link follows the passes. S28: the standing-story floor is one of those
// passes, and the silence notices are redrawn for the stored profile's standing stories.
// B5: a stored profile whose trust or mutes pick another best version for a story
// fronts its row with that version (tiers.js placeFace) before the rows are re-tiered.
// S15: also runs when the device has read history and the build did not (rank-gate.js),
// even with the default profile, so the seen penalty (R17) always reaches the page
// before first paint; window.almanacHistorySummary is the compact localStorage summary
// rank-gate.js already read synchronously.
import { rankPages, pageOptions } from "./passes.js";
import { retier, placeFace, placeReadChoice, placeOtherSide, visibleSourceCount, placeSourceCount } from "./tiers.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { summaryToHistory } from "./history/summary.js";
import { seenPenaltyTerm } from "./history/penalty.js";
import { pageInput } from "./page-input.js";

const root = document.documentElement;

/** S28: the silence alarm for this profile, the same markup app/build.py writes, every
 * string set as text only (R26). Runs while the page is hidden, so nothing moves. */
function drawNotices(box, notices) {
  if (!box) return;
  box.replaceChildren(...notices.map((n) => {
    const card = document.createElement("div");
    card.className = "notice";
    card.dataset.standing = n.id;
    card.dataset.kind = n.kind;
    for (const [cls, text] of [["notice-kicker", n.kicker], ["notice-head", n.head], ["notice-text", n.text]]) {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      card.append(p);
    }
    return card;
  }));
}

function run() {
  try {
    const input = pageInput();
    const profile = window.almanacProfile || buildDefaultProfile(input.now);
    const history = summaryToHistory(window.almanacHistorySummary || {});
    const pages = rankPages(input.pool, profile, input.now, pageOptions(input, { terms: [seenPenaltyTerm(history)] }));
    if (root.classList.contains("rerank")) {
      const today = document.getElementById("section-today") || document;
      const rows = new Map([...today.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
      const order = pages.today.map((s) => s.id);
      const onPage = new Set(order);
      for (const [sid, li] of rows) if (!onPage.has(sid)) li.remove();
      const lists = ["headlines", "more-list", "rest-list"].map((id) => document.getElementById(id));
      const leads = new Map((input.pool?.clusters || []).map((c) => [c.id, c.lead]));
      for (const [sid, li] of rows) placeFace(li, pages.faces[sid], leads.get(sid), input);
      retier(lists, order, rows, input.deks, input.images || {}, input.fronts || {});
      placeReadChoice(rows, input, profile.trust, pages.faces);
      const clusters = new Map((input.pool?.clusters || []).map((c) => [c.id, c]));
      const articleById = new Map((input.pool?.articles || []).map((a) => [a.id, a]));
      const muted = (profile.mutes && profile.mutes.sources) || [];
      for (const story of pages.today) {
        placeOtherSide(rows.get(story.id), story.other_side || null, input);
        placeSourceCount(rows.get(story.id), visibleSourceCount(clusters.get(story.id), articleById, muted));
      }
      drawNotices(document.getElementById("standing-notices"), pages.notices);
      const toggle = today.querySelector(".more-toggle");
      if (toggle) toggle.textContent = `Show ${Math.max(0, order.length - 35)} more headlines`;
    }
  } finally {
    root.classList.remove("rerank");
  }
}

// rank-gate.js inserts this module from <head>, and an inserted module runs as soon as
// it arrives, which can be before the parser has reached #rank-input at the end of the
// body: its text is then cut short and the re-rank fails (U3 caught it, 3 loads in its
// proof). While the page is still parsing, wait for the whole document; the headlines
// stay hidden until then, and tabs.js already waits for the re-rank either way.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
else run();
