// S27: the device's one re-tier routine, shared by rerank.js (Today, re-ranked for a
// stored profile) and tabs.js (each section tab, built from Today's rows). Given lists
// for the top tiers, the "More headlines" module and the folded rest, it places rows in
// order and gives each the classes, dek and photo its tier takes by the build's own
// rules (app/build.py, app/images.py): the story's chosen hero photo in the hero, the
// lead's thumbnail in the river, none elsewhere. Every feed string is set as text only
// (R26) and only an https url reaches src.

import { leanHit, leanMarker } from "./lean.js";
import { readChoice } from "./reader/core.js";

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

/** U1: the fitted dek a row of `tier` shows, from the build's list for its story
 * (app/build.py _dek_pairs): [hero, lead block, row], trailing repeats dropped. Every
 * tier carries one; rank-gate.js hides the river and text-only rows' deks when the
 * profile's display.summaries is "top". */
export function dekFor(entry, tier) {
  if (!Array.isArray(entry) || !entry.length) return "";
  const index = tier === "hero" ? 0 : tier === "secondary" ? 1 : 2;
  const text = entry[Math.min(index, entry.length - 1)];
  return typeof text === "string" ? text : "";
}

/** Places `order`'s rows (a Map of sid to li) into lists = [top, more, rest]; a missing
 * list drops the rows its slots would hold. B5: a row the device fronted with another
 * version (placeFace, `data-face`) takes that version's deks and photo from `fronts`
 * (the page's #rank-input `fronts`) instead of the story's own. */
export function retier(lists, order, rows, deks, images, fronts = {}) {
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
      const front = li.dataset.face ? fronts?.[li.dataset.face] : null;
      li.querySelector(".story-body").prepend(...media(tier, front ? front.i : images[order[i]]));
      const text = dekFor(front ? front.d : deks[order[i]], tier);
      if (text) {
        const dek = document.createElement("span");
        dek.className = "dek";
        dek.textContent = text;
        li.querySelector(".headline").after(dek);
      }
      target[slot].append(li);
    }
  });
}

// B5: the row's face. The build draws each row with its story's face for the default
// profile (app/frontpage.py face_of, embedded as the cluster's `lead`); a stored profile
// whose trust or mutes pick another version (passes.js rankPages `faces`) gets the row
// redrawn here from the page's own facts before first paint: the headline, the link, the
// outlet, its marker and tap target, and the age, exactly as app/build.py would have
// written them for that version (`fronts`, typeset at build); retier then gives it that
// version's deks and photo. Every string is set as text (R26); only an http(s) url
// reaches href. The row's "N sources" and its carousel trigger are the story's, not the
// face's, and do not change.
const articleMaps = new WeakMap();
function articleOf(input, id) {
  let map = articleMaps.get(input);
  if (!map) {
    map = new Map((input.pool?.articles || []).map((a) => [a.id, a]));
    articleMaps.set(input, map);
  }
  return map.get(id);
}

/** Fronts row `li` with article `faceId`; `buildFace` is the one the build drew it with.
 * Returns true when the row changed. Sets `data-face` while the row shows another
 * version than the build's, and clears it once it is back. */
export function placeFace(li, faceId, buildFace, input) {
  if (!li || !faceId) return false;
  const shown = li.dataset.face || buildFace;
  const front = (input.fronts || {})[faceId];
  const article = articleOf(input, faceId);
  if (faceId === shown || !front || !article) return false;
  const doc = li.ownerDocument;
  li.querySelector(".headline").textContent = front.t;
  const url = (input.coverage || {})[faceId]?.url || "";
  let link = li.querySelector(".story-link");
  const web = WEB.test(url);
  if (web !== (link.tagName === "A")) {
    const next = doc.createElement(web ? "a" : "span");
    next.className = "story-link";
    next.append(...link.childNodes);
    link.replaceWith(next);
    link = next;
  }
  if (web) {
    link.setAttribute("href", url);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  const sourceId = article.source_id || "";
  const name = (input.names || {})[sourceId] || "";
  const lean = (input.leans || {})[sourceId];
  const country = (input.countries || {})[sourceId];
  const line = li.querySelector(".meta-line");
  line.querySelector(".lean")?.remove();
  const source = line.querySelector(".meta-source");
  if (source) {
    source.textContent = name;
    const marker = name ? leanMarker(lean, { country, doc }) : null;
    if (marker) source.after(marker);
  }
  const age = line.querySelector(".meta-age");
  if (age) age.textContent = front.a;
  const second = li.querySelector(".meta-line--2");
  if (second && front.a) second.setAttribute("data-age", front.a);
  li.querySelectorAll(":scope > .lean-hit:not(.lean-hit--other)").forEach((el) => el.remove());
  const hit = name ? leanHit(sourceId, lean, doc, country) : null;
  if (hit) link.after(hit);
  if (faceId === buildFace) delete li.dataset.face;
  else li.dataset.face = faceId;
  return true;
}

/** R43: each "Read here" row re-picks, for this profile's trust, the member whose full
 * text it opens (reader/core.js readChoice, the build's own rule) and names its outlet
 * the way app/build.py does: nothing more when it is the row's own source, else the
 * name after the mark. B5: the row's own source is its face for this profile (`faces`,
 * passes.js rankPages), so a face with full text is also what "Read here" opens. The
 * row's data-body is what the reader opens, as is, so the row and the reader agree.
 * rerank.js runs it while the page is hidden, inside one nowrap meta line whose height never
 * changes, so nothing moves. */
export function placeReadChoice(rows, input, trust, faces = {}) {
  const leads = new Map((input.pool?.clusters || []).map((c) => [c.id, c.lead]));
  const sourceOf = new Map((input.pool?.articles || []).map((a) => [a.id, a.source_id]));
  for (const [sid, li] of rows) {
    const link = li.querySelector("a.story-link");
    if (!link || !input.bodies?.[sid] || !li.querySelector(".meta-read")) continue;
    const lead = faces[sid] || leads.get(sid) || sid;
    const choice = readChoice(input.bodies?.[sid], lead, trust || {});
    if (!choice) continue;
    link.dataset.body = choice.id;
    const name = choice.source_id === sourceOf.get(lead) ? "" : (input.names || {})[choice.source_id] || "";
    let label = li.querySelector(".meta-read-source");
    if (!name) {
      label?.remove();
    } else {
      if (!label) {
        label = li.ownerDocument.createElement("span");
        label.className = "meta-read-source";
        li.querySelector(".meta-read")?.after(label);
      }
      label.textContent = name;
    }
  }
}

// H4 item 3: outlets a row's own cluster would leave visible for this viewer, the same
// units passes.js's mute and versions.js's buildVersions already drop for them: a
// near-duplicate group (syndicated copies) counts once, one outlet counts once however
// many pieces it ran, and a muted outlet's own article never forms or joins a unit.
// Mirrors app/frontpage.py visible_source_count so the build and the device agree.
export function visibleSourceCount(cluster, articleById, muted) {
  if (!cluster) return 1;
  const off = new Set(muted || []);
  const groupOf = new Map();
  (cluster.near_duplicates || []).forEach((group, index) => {
    for (const id of group) groupOf.set(id, index);
  });
  const units = new Set();
  for (const id of cluster.article_ids || []) {
    const article = articleById.get(id);
    if (!article || off.has(article.source_id)) continue;
    const group = groupOf.get(id);
    units.add(group !== undefined ? `g${group}` : `s${article.source_id}`);
  }
  return units.size;
}

/** Rewrites a row's "N sources" span (app/build.py _meta) for `count`, the number the
 * stored profile's mutes actually leave (visibleSourceCount); removes the span and its
 * separator once count drops to 1 or fewer. The build only ever renders the span when
 * its own mute-free count is over 1, and muting only ever lowers this count, so a row
 * that never had one never needs one created here (CLS 0: nothing this adds or removes
 * runs after first paint, only while root carries .rerank). */
export function placeSourceCount(li, count) {
  const span = li?.querySelector(".meta-count");
  if (!span) return;
  if (count > 1) { span.textContent = `${count} sources`; return; }
  const sep = span.previousElementSibling;
  if (sep && sep.classList.contains("meta-sep")) sep.remove();
  span.remove();
}

// S13: the other-side link a pass attached to a row (passes.js), drawn as the build
// draws it (app/build.py OTHER): its own link after the card's, label then headline,
// every string as text (R26), an href only for an http(s) url. `record` is the story's
// other_side ({article_id, source_id, lean}) or null, which clears the row. U3: the
// label names the outlet, then its marker (js/lean.js, the rows' own), and the marker's
// tap target follows the link as a sibling.
const WEB = /^https?:\/\/[^\s]+$/i;

export function placeOtherSide(li, record, input) {
  if (!li) return;
  li.querySelector(".other-side")?.remove();
  li.querySelector(".lean-hit--other")?.remove();
  const link = record && (input.links || {})[record.article_id];
  if (!link) return;
  const [url, title] = link;
  const web = WEB.test(url || "");
  const node = document.createElement(web ? "a" : "span");
  node.className = "other-side";
  node.dataset.aid = record.article_id;
  if (web) {
    node.setAttribute("href", url);
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  const label = document.createElement("span");
  label.className = "other-side-label";
  const kicker = document.createElement("span");
  kicker.className = "other-side-kicker";
  kicker.textContent = "Other side \u00b7 ";
  const source = document.createElement("span");
  source.className = "other-side-source";
  source.textContent = (input.names || {})[record.source_id] || record.source_id;
  label.append(kicker, source);
  const lean = record.lean || (input.leans || {})[record.source_id];
  const country = (input.countries || {})[record.source_id];
  const marker = leanMarker(lean, { country });
  if (marker) label.append(marker);
  const headline = document.createElement("span");
  headline.className = "other-side-title";
  headline.textContent = title;
  node.append(label, headline);
  li.append(node);
  const hit = leanHit(record.source_id, lean, document, country, "lean-hit--other");
  if (hit) li.append(hit);
}
