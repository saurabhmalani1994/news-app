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
// S15: also runs when the device has read history and the build did not (rank-gate.js),
// even with the default profile, so the seen penalty (R17) always reaches the page
// before first paint; window.almanacHistorySummary is the compact localStorage summary
// rank-gate.js already read synchronously.
import { rankPages } from "./passes.js";
import { retier, placeOtherSide } from "./tiers.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { summaryToHistory } from "./history/summary.js";
import { seenPenaltyTerm } from "./history/penalty.js";
import { readChoice } from "./reader/core.js";

const root = document.documentElement;

/** R43: each "Read here" row re-picks, for this profile's trust, the member whose full
 * text it opens (reader/core.js readChoice, the build's own rule) and names its outlet
 * the way app/build.py does: nothing more when it is the row's own source, else the
 * name after the mark. The row's data-body is what the reader opens, as is, so the row
 * and the reader agree. Runs while the page is hidden, inside one nowrap meta line
 * whose height never changes, so nothing moves. */
function placeReadChoice(rows, input, trust) {
  const leads = new Map((input.pool?.clusters || []).map((c) => [c.id, c.lead]));
  const sourceOf = new Map((input.pool?.articles || []).map((a) => [a.id, a.source_id]));
  for (const [sid, li] of rows) {
    const link = li.querySelector("a.story-link[data-body]");
    if (!link) continue;
    const lead = leads.get(sid) || sid;
    const choice = readChoice(input.bodies?.[sid], lead, trust || {});
    if (!choice || choice.id === link.dataset.body) continue;
    link.dataset.body = choice.id;
    const name = choice.source_id === sourceOf.get(lead) ? "" : (input.names || {})[choice.source_id] || "";
    let label = li.querySelector(".meta-read-source");
    if (!name) {
      label?.remove();
    } else {
      if (!label) {
        label = document.createElement("span");
        label.className = "meta-read-source";
        li.querySelector(".meta-read")?.after(label);
      }
      label.textContent = name;
    }
  }
}

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

try {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const profile = window.almanacProfile || buildDefaultProfile(input.now);
  const history = summaryToHistory(window.almanacHistorySummary || {});
  const pages = rankPages(input.pool, profile, input.now, {
    buckets: input.buckets, leans: input.leans, names: input.names, health: input.health,
    terms: [seenPenaltyTerm(history)],
  });
  if (root.classList.contains("rerank")) {
    const today = document.getElementById("section-today") || document;
    const rows = new Map([...today.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
    const order = pages.today.map((s) => s.id);
    const onPage = new Set(order);
    for (const [sid, li] of rows) if (!onPage.has(sid)) li.remove();
    const lists = ["headlines", "more-list", "rest-list"].map((id) => document.getElementById(id));
    retier(lists, order, rows, input.deks, input.images || {});
    placeReadChoice(rows, input, profile.trust);
    for (const story of pages.today) placeOtherSide(rows.get(story.id), story.other_side || null, input);
    drawNotices(document.getElementById("standing-notices"), pages.notices);
    const toggle = today.querySelector(".more-toggle");
    if (toggle) toggle.textContent = `Show ${Math.max(0, order.length - 35)} more headlines`;
  }
} finally {
  root.classList.remove("rerank");
}
