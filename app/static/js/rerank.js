// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26). S39: a row's
// photo follows its tier by the build's own rule (app/images.py): a hero-worthy photo
// in the hero, a thumbnail in the river, none elsewhere; only an https url reaches src.
import { rank } from "./ranker.js";

const TIERS = [["hero", 1], ["secondary", 2], ["river", 12], ["text-only", 20], ["text-only", Infinity]];
const HEADLINE = { hero: "headline headline--hero", secondary: "headline headline--river", river: "headline headline--river", "text-only": "headline" };

const HTTPS = /^https:\/\/[^\s]+$/i;

function media(tier, record) {
  if (!record || !HTTPS.test(record[0])) return [];
  const kind = tier === "hero" && record[1] ? "hero" : tier === "river" && record[2] ? "thumb" : null;
  if (!kind) return [];
  const frame = document.createElement("span");
  frame.className = `story-media story-media--${kind}`;
  const img = document.createElement("img");
  const px = kind === "hero" ? "360" : "88";
  img.className = "story-img";
  img.setAttribute("width", px);
  img.setAttribute("height", px);
  img.setAttribute("alt", "");
  img.setAttribute(kind === "hero" ? "fetchpriority" : "loading", kind === "hero" ? "high" : "lazy");
  img.setAttribute("decoding", "async");
  img.setAttribute("referrerpolicy", "no-referrer");
  img.setAttribute("src", record[0]);
  frame.append(img);
  if (kind !== "hero" || !record[3]) return [frame];
  const credit = document.createElement("span");
  credit.className = "story-credit";
  credit.textContent = record[3];
  return [frame, credit];
}

function retier(order, deks, images) {
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
      li.querySelectorAll(".story-media, .story-credit").forEach((el) => el.remove());
      li.querySelector(".story-body").prepend(...media(tier, images[order[i]]));
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
  if (root.classList.contains("rerank")) retier(ranked.map((s) => s.id), input.deks, input.images || {});
} finally {
  root.classList.remove("rerank");
}
