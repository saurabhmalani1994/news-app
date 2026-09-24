// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26).
import { rank } from "./ranker.js";

const TIERS = [["hero", 1], ["secondary", 2], ["river", 12], ["text-only", 20], ["text-only", Infinity]];
const HEADLINE = { hero: "headline headline--hero", secondary: "headline headline--river", river: "headline headline--river", "text-only": "headline" };

function retier(order, deks) {
  const rows = new Map([...document.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
  const lists = ["headlines", "more-list", "rest-list"].map((id) => document.getElementById(id));
  const target = [lists[0], lists[0], lists[0], lists[1], lists[2]];
  let i = 0;
  TIERS.forEach(([tier, count], slot) => {
    for (let n = 0; n < count && i < order.length; n++, i++) {
      const li = rows.get(order[i]);
      if (!li || !target[slot]) continue;
      li.className = `story story--${tier}`;
      li.querySelector(".headline").className = HEADLINE[tier];
      li.querySelector(".dek")?.remove();
      const pair = deks[order[i]];
      if (pair && (tier === "hero" || tier === "secondary")) {
        const dek = document.createElement("span");
        dek.className = "dek";
        dek.textContent = tier === "hero" ? pair[0] : pair[pair.length - 1];
        li.querySelector(".headline").after(dek);
      }
      target[slot].append(li);
    }
  });
}

const root = document.documentElement;
try {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ranked = rank(input.pool, window.almanacProfile, input.now);
  if (root.classList.contains("rerank")) retier(ranked.map((s) => s.id), input.deks);
} finally {
  root.classList.remove("rerank");
}
