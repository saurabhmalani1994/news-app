// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26). S39: a row's
// photo follows its tier by the build's own rule (app/images.py): the story's chosen
// hero photo in the hero, the lead's thumbnail in the river, none elsewhere; only an
// https url reaches src. S13: the order is Today after the post-passes (passes.js), the
// same code the build ran; a row the passes removed (a mute) leaves the page, and each
// row's other-side link follows the passes.
import { rankPages } from "./passes.js";
import { retier, placeOtherSide } from "./tiers.js";

const root = document.documentElement;
try {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const pages = rankPages(input.pool, window.almanacProfile, input.now, { buckets: input.buckets, leans: input.leans, names: input.names });
  if (root.classList.contains("rerank")) {
    const today = document.getElementById("section-today") || document;
    const rows = new Map([...today.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
    const order = pages.today.map((s) => s.id);
    const onPage = new Set(order);
    for (const [sid, li] of rows) if (!onPage.has(sid)) li.remove();
    const lists = ["headlines", "more-list", "rest-list"].map((id) => document.getElementById(id));
    retier(lists, order, rows, input.deks, input.images || {});
    for (const story of pages.today) placeOtherSide(rows.get(story.id), story.other_side || null, input);
    const toggle = today.querySelector(".more-toggle");
    if (toggle) toggle.textContent = `Show ${Math.max(0, order.length - 35)} more headlines`;
  }
} finally {
  root.classList.remove("rerank");
}
