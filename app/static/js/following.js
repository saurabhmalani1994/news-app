// W3: what the owner follows, and the stories that match each right now. The owner
// added two phrase interests and said their stories "never appeared": at Normal a
// phrase lifts a story only a little, so its matches sat below Today's fold, and no
// screen listed them. This module is the one answer for every place that lists them:
// the Following tab (tabs.js) and each phrase interest's and standing story's own page
// on You (profile-screen.js).
//
// A story matches a phrase interest exactly when the ranker gives it that interest in
// its affinity term (ranker.js topics_matched: the phrase in a headline or dek, or the
// phrase's own watch tag from the hourly search), and a standing story exactly when
// standing.js qualifies it (a keyword in a headline, or its own search's watch tag,
// under its tag rule). Stories come from the page's own #rank-input after the mute and
// dedup passes, so a muted outlet's story is not listed here either. Newest first.
//
// followList and followMatches are pure (Node tests them); followRow is the one DOM
// helper: a Today row cloned as a compact text-only row, every string already set as
// text by the build or tiers.js (R26), with the dek the text-only tier takes.
import { isPhraseTopic } from "./phrase.js";
import { standingStories, qualifies } from "./standing.js";
import { applyPasses, pageOptions } from "./passes.js";
import { dekFor } from "./tiers.js";

/** How many stories a follow shows on the Following tab before its "See all" row. */
export const FOLLOW_PREVIEW = 5;

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Everything the profile follows, in the order the You page lists it: phrase
 * interests that are on (profile order), then standing stories that are on (their
 * priority order). Each is {kind, id, label, href}, href its own page on You. */
export function followList(profile) {
  const out = [];
  for (const [id, topic] of Object.entries(profile?.topics || {})) {
    if (!isPhraseTopic(topic) || topic.enabled === false) continue;
    out.push({ kind: "phrase", id, label: `“${topic.phrase}”`, href: `/profile#interest/${encodeURIComponent(id)}` });
  }
  for (const def of standingStories(profile)) {
    out.push({ kind: "story", id: def.id, label: def.label, href: `/profile#story/${encodeURIComponent(def.id)}` });
  }
  return out;
}

/** Each follow with its matching stories, newest first: [{kind, id, label, href,
 * stories}]. `input` is the page's decoded #rank-input (page-input.js). */
export function followMatches(input, profile) {
  const follows = followList(profile);
  if (!follows.length) return [];
  const { list } = applyPasses(["mute", "dedup"], input.pool, profile, input.now, pageOptions(input));
  const defs = new Map(standingStories(profile).map((d) => [d.id, d]));
  const newest = (a, b) => b.latest_ms - a.latest_ms || byStr(a.id, b.id);
  return follows.map((f) => {
    const hit = f.kind === "phrase" ? (s) => s.topics_matched.includes(f.id) : (s) => qualifies(s, defs.get(f.id));
    return { ...f, stories: list.filter(hit).sort(newest) };
  });
}

/** One follow's stories for a page: {kind, id, label, href, stories} or null when the
 * profile does not follow it (off, or gone). */
export function followFor(input, profile, kind, id) {
  return followMatches(input, profile).find((f) => f.kind === kind && f.id === id) || null;
}

/** A Today row (`li`, as the build or the device re-rank left it) as a compact
 * text-only row for a list of matches: no photo, no other-side link, the text-only
 * dek. `input` gives the story's deks (#rank-input deks and, for a row the device
 * fronted with another version, fronts). The clone keeps the row's link, its reader
 * body, its meta and its menu, so a tap does what it does on Today. */
export function followRow(li, input) {
  const row = li.cloneNode(true);
  const sid = row.dataset.sid;
  row.className = "story story--text-only";
  row.querySelector(".headline")?.setAttribute("class", "headline");
  row.querySelectorAll(".story-media, .story-credit, .dek, .other-side, .lean-hit--other").forEach((el) => el.remove());
  const front = row.dataset.face ? input.fronts?.[row.dataset.face] : null;
  const text = dekFor(front ? front.d : input.deks?.[sid], "text-only");
  if (text) {
    const dek = row.ownerDocument.createElement("span");
    dek.className = "dek";
    dek.textContent = text;
    row.querySelector(".headline")?.after(dek);
  }
  return row;
}

/** "3 stories now", "1 story now", "No stories now". */
export function countWords(n) {
  return n ? `${n} ${n === 1 ? "story" : "stories"} now` : "No stories now";
}
