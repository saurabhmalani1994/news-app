// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26). S39: a row's
// photo follows its tier by the build's own rule (app/images.py): the story's chosen
// hero photo in the hero, the lead's thumbnail in the river, none elsewhere; only an
// https url reaches src.
import { rank } from "./ranker.js";
import { retier } from "./tiers.js";

const root = document.documentElement;
try {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ranked = rank(input.pool, window.almanacProfile, input.now);
  if (root.classList.contains("rerank")) {
    const today = document.getElementById("section-today") || document;
    const rows = new Map([...today.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
    const lists = ["headlines", "more-list", "rest-list"].map((id) => document.getElementById(id));
    retier(lists, ranked.map((s) => s.id), rows, input.deks, input.images || {});
  }
} finally {
  root.classList.remove("rerank");
}
