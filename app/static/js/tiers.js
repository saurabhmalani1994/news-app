// S27: the device's one re-tier routine, shared by rerank.js (Today, re-ranked for a
// stored profile) and tabs.js (each section tab, built from Today's rows). Given lists
// for the top tiers, the "More headlines" module and the folded rest, it places rows in
// order and gives each the classes, dek and photo its tier takes by the build's own
// rules (app/build.py, app/images.py): the story's chosen hero photo in the hero, the
// lead's thumbnail in the river, none elsewhere. Every feed string is set as text only
// (R26) and only an https url reaches src.

export const TIERS = [["hero", 1], ["secondary", 2], ["river", 12], ["text-only", 20], ["text-only", Infinity]];
const HEADLINE = { hero: "headline headline--hero", secondary: "headline headline--river", river: "headline headline--river", "text-only": "headline" };

const HTTPS = /^https:\/\/[^\s]+$/i;

export function media(tier, record) {
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

/** Places `order`'s rows (a Map of sid to li) into lists = [top, more, rest]; a missing
 * list drops the rows its slots would hold. */
export function retier(lists, order, rows, deks, images) {
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
