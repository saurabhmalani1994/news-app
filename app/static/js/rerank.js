// S11: device re-rank, loaded by rank-gate.js only when the stored profile's ranking
// fields differ from the default the page was built with. Runs while the headlines are
// hidden, so the reader first sees the final order. Ranks the page's own compact pool
// (the build ranked the very same input) at the pool's generated_at, re-tiers the
// existing rows in place and sets every feed string as text only (R26). S39: a row's
// photo follows its tier by the build's own rule (app/images.py): the story's chosen
// hero photo in the hero, the lead's thumbnail in the river, none elsewhere; only an
// https url reaches src.
import { rank } from "./ranker.js";

const TIERS = [["hero", 1], ["secondary", 2], ["river", 12], ["text-only", 20], ["text-only", Infinity]];
const HEADLINE = { hero: "headline headline--hero", secondary: "headline headline--river", river: "headline headline--river", "text-only": "headline" };

const HTTPS = /^https:\/\/[^\s]+$/i;

function media(tier, record) {
  // record: {hero: [url, width, height, credit], thumb: url} (app/images.py media_for).
  // D2: the hero's photo may come from another outlet in the story, and its box is the
  // build's clamped shape, two integers set as --box so the frame is sized before load.
  const hero = tier === "hero" && record?.hero;
  const url = hero ? hero[0] : tier === "river" ? record?.thumb : null;
  if (!url || !HTTPS.test(url)) return [];
  const [width, height] = hero ? hero.slice(1, 3) : [88, 88];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return [];
  const frame = document.createElement("span");
  frame.className = `story-media story-media--${hero ? "hero" : "thumb"}`;
  if (hero) frame.style.setProperty("--box", `${width} / ${height}`);
  const img = document.createElement("img");
  img.className = "story-img";
  img.setAttribute("width", String(width));
  img.setAttribute("height", String(height));
  img.setAttribute("alt", "");
  img.setAttribute(hero ? "fetchpriority" : "loading", hero ? "high" : "lazy");
  img.setAttribute("decoding", "async");
  img.setAttribute("referrerpolicy", "no-referrer");
  img.setAttribute("src", url);
  frame.append(img);
  if (!hero || !hero[3]) return [frame];
  const credit = document.createElement("span");
  credit.className = "story-credit";
  credit.textContent = hero[3];
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
