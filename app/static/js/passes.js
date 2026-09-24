// S13: the post-passes (DESIGN-v1 section 4 and 6, carried by DESIGN-v1.1 section 6;
// must-know per R16). They run after scoring, in one fixed order, and never change a
// score: they remove, move, place or attach, and every story they touch carries a
// named, readable entry in its own `passes` list, so a story that lost or gained a
// place says which rule did it (S12's why-this sheet shows these entries).
//
// Order, and where each pass runs:
//   1 mute         every tab   a muted source or topic never appears
//   2 dedup        every tab   one card per piece of copy
//   3 lean-quota   each tab    at most max_share of any `window` cards from one lean
//   4 exploration  Today       positions 4, 14, 24 by recency + importance only
//   5 other-side   each tab    one attached link on a 3+ source, 2+ lean cluster, from
//                              the lean least represented in the page's first screen
//   6 must-know    Today       floor_slots R16-eligible stories at the top
// Mute and dedup are facts about the pool for this owner, so they run once and every
// tab is filtered from their result. A section tab is the same list filtered (S27),
// then its own lean quota and other-side slot, since each tab is its own screen
// ("no single side dominates a screen", OWNER-BRIEF). Exploration and the must-know
// floor belong to the front page: a section tab is already a chosen topic, and the
// floor is "at the top of the front page" (OWNER-BRIEF, derived).
//
// Pure and deterministic like the ranker: the same pool, profile and time give the
// same pages byte for byte, at build under Node and on the device.
import { rank, HARD_NEWS, TAG_TO_TOPIC } from "./ranker.js";
import { SECTIONS, inSection } from "./sections.js";

export const PASS_ORDER = Object.freeze(["mute", "dedup", "lean-quota", "exploration", "other-side", "must-know"]);
export const TODAY_PASSES = Object.freeze(["lean-quota", "exploration", "other-side", "must-know"]);
export const SECTION_PASSES = Object.freeze(["lean-quota", "other-side"]);

// Defaults for profile.passes. Design-set: window 10 and 60% (DESIGN-v1 section 6, R29),
// exploration at 4, 14, 24 (DESIGN-v1 section 6). Chosen here where the design is
// silent, owner-editable in the profile: one other-side link per page, and the page's
// lean mix read over its first screen of `window` cards.
export const PASS_DEFAULTS = Object.freeze({
  lean_quota: Object.freeze({ window: 10, max_share: 0.6 }),
  exploration: Object.freeze({ positions: Object.freeze([4, 14, 24]) }),
  other_side: Object.freeze({ per_page: 1 }),
});
// Design-set and not a profile field: the other side needs a cluster of at least 3
// sources across at least 2 lean buckets (research section 5, DESIGN-v1 section 6).
// The page embeds link data only for such clusters, so the device can always draw it.
export const OTHER_SIDE_MIN_SOURCES = 3;
// Dedup compares whole headlines; shorter ones ("Live updates") are too generic to be
// the same piece of copy.
export const DEDUP_MIN_TITLE_CHARS = 20;

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MUST_KNOW = "must_know";

function settings(profile) {
  const p = (profile && profile.passes) || {};
  return {
    lean_quota: { ...PASS_DEFAULTS.lean_quota, ...(p.lean_quota || {}) },
    exploration: { ...PASS_DEFAULTS.exploration, ...(p.exploration || {}) },
    other_side: { ...PASS_DEFAULTS.other_side, ...(p.other_side || {}) },
  };
}

const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const note = (story, pass, text, extra = {}) => story.passes.push({ pass, text, ...extra });

/** The article that fronts a story's card: the build's lead (app/frontpage.py _lead,
 * carried on the cluster as `lead`), or the story's only article. */
function leadOf(story, ctx) {
  const lead = ctx.leads.get(story.id);
  return lead && story.article_ids.includes(lead) ? lead : story.article_ids[0];
}

/** The lean of the outlet a card shows: its lead's source lean (sources.json), or null. */
export function cardLean(story, ctx) {
  const article = ctx.articles.get(leadOf(story, ctx));
  return (article && ctx.leans[article.source_id]) || null;
}

const nameOf = (ctx, sourceId) => ctx.names[sourceId] || sourceId;
const neutral = (story) => story.explanation.filter((t) => t.term === "recency" || t.term === "importance").reduce((s, t) => s + t.value, 0);
const byNeutral = (a, b) => neutral(b) - neutral(a) || b.score - a.score || byStr(a.id, b.id);

/** Gives every story whose place changed between `before` and `after` a `pass` entry,
 * unless the pass already wrote one for it. `why(story, from, to)` words it. */
function markShifts(before, after, pass, why) {
  const was = new Map(before.map((s, i) => [s.id, i]));
  after.forEach((s, to) => {
    const from = was.get(s.id);
    if (from === to || s.passes.some((e) => e.pass === pass)) return;
    note(s, pass, why(s, from + 1, to + 1), { from: from + 1, to: to + 1 });
  });
}

const shiftText = (label, cause) => (s, from, to) =>
  `Moved ${to > from ? "down" : "up"} by ${label}: from ${from} to ${to}, ${cause}`;

// 1. Mute. A muted topic removes every story tagged with it (pool tags map to profile
// topics as the ranker maps them). A muted source removes a story it fronts, or one it
// alone covers; a many-outlet story with one muted member stays, fronted by another
// outlet, so muting one outlet can never hide news the rest of the press is covering.
function mute(list, ctx) {
  const sources = new Set((ctx.profile.mutes && ctx.profile.mutes.sources) || []);
  const topics = new Set((ctx.profile.mutes && ctx.profile.mutes.topics) || []);
  const kept = [];
  list.forEach((story, i) => {
    const tags = story.topics.map((t) => (Object.hasOwn(ctx.profile.topics || {}, t) ? t : TAG_TO_TOPIC[t] || t));
    const topic = [...story.topics, ...tags].filter((t) => topics.has(t) && t !== MUST_KNOW).sort(byStr)[0];
    const leadSource = ctx.articles.get(leadOf(story, ctx))?.source_id;
    const source = sources.has(leadSource) ? leadSource : story.source_ids.every((s) => sources.has(s)) ? story.source_ids[0] : null;
    if (topic || source) {
      const why = topic ? `the topic ${topic} is muted` : `the source ${nameOf(ctx, source)} is muted`;
      note(story, "mute", `Removed by mute: ${why}`, { from: i + 1, to: null });
      ctx.removed.push(story);
    } else kept.push(story);
  });
  markShifts(list, kept, "mute", shiftText("mute", "a muted story above it was removed"));
  return kept;
}

const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// 2. Dedup. The ranker already groups each cluster into one story; this catches the
// same headline arriving as two stories (syndicated copy the clusterer kept apart). The
// fuller story stays: more independent outlets, then more articles, then the newest,
// then the lower id. That is a fact about the pool, not the profile, so every profile
// removes the same stories and the page built for the default one holds every row a
// device re-rank can need.
const fullness = (a, b) => b.independent_sources - a.independent_sources || b.article_ids.length - a.article_ids.length
  || b.latest_ms - a.latest_ms || byStr(a.id, b.id);

function dedup(list, ctx) {
  const owner = new Map();
  const twinOf = new Map();
  for (const story of [...list].sort(fullness)) {
    const titles = story.titles.map(normTitle).filter((t) => t.length >= DEDUP_MIN_TITLE_CHARS);
    const twin = titles.map((t) => owner.get(t)).find(Boolean);
    if (twin) twinOf.set(story.id, twin);
    else titles.forEach((t) => owner.has(t) || owner.set(t, story.id));
  }
  const kept = [];
  list.forEach((story, i) => {
    if (!twinOf.has(story.id)) { kept.push(story); return; }
    note(story, "dedup", `Removed by dedup: the same headline is on the page as story ${twinOf.get(story.id)}, which more outlets carry`, { from: i + 1, to: null });
    ctx.removed.push(story);
  });
  markShifts(list, kept, "dedup", shiftText("dedup", "a duplicate above it was removed"));
  return kept;
}

// 3. Lean quota. Cards are placed in score order, except that a card is held back
// while placing it would put more than max_share of any `window` consecutive cards
// in its outlet's lean bucket; the next card that fits takes the place. A card of no
// known lean never counts. When nothing left fits, order resumes unchanged.
function leanQuota(list, ctx) {
  const { window, max_share } = ctx.settings.lean_quota;
  const cap = Math.floor(window * max_share + 1e-9);
  const leanOf = new Map(list.map((s) => [s.id, cardLean(s, ctx)]));
  const out = [];
  const waiting = [...list];
  const held = new Map();
  while (waiting.length) {
    const recent = out.slice(-(window - 1)).map((s) => leanOf.get(s.id));
    const fits = (s) => { const l = leanOf.get(s.id); return !l || recent.filter((x) => x === l).length < cap; };
    let pick = waiting.findIndex(fits);
    if (pick < 0) pick = 0;
    for (let j = 0; j < pick; j++) {
      const s = waiting[j];
      if (!held.has(s.id)) held.set(s.id, recent.filter((x) => x === leanOf.get(s.id)).length);
    }
    out.push(waiting.splice(pick, 1)[0]);
  }
  const was = new Map(list.map((s, i) => [s.id, i + 1]));
  out.forEach((s, i) => {
    if (!held.has(s.id) || was.get(s.id) === i + 1) return;
    const lean = leanOf.get(s.id);
    note(s, "lean-quota", `Moved down by lean quota: from ${was.get(s.id)} to ${i + 1}, ${held.get(s.id)} of the ${window - 1} cards above its place were already ${lean}; at most ${cap} of any ${window} from one lean`, { from: was.get(s.id), to: i + 1 });
  });
  markShifts(list, out, "lean-quota", shiftText("lean quota", "a card from an over-represented lean above it was held back"));
  return out;
}

/** How many `window`-card stretches of the list hold more than the quota allows from
 * one lean. The passes after the quota use it so a move they make never undoes it. */
function quotaBreaks(list, ctx) {
  const { window, max_share } = ctx.settings.lean_quota;
  const cap = Math.floor(window * max_share + 1e-9);
  const leans = list.map((s) => cardLean(s, ctx));
  const count = new Map();
  let breaks = 0;
  leans.forEach((l, i) => {
    if (l) count.set(l, (count.get(l) || 0) + 1);
    const out = i >= window ? leans[i - window] : null;
    if (out) count.set(out, count.get(out) - 1);
    if (i >= Math.min(window, leans.length) - 1 && [...count.values()].some((c) => c > cap)) breaks += 1;
  });
  return breaks;
}

/** `list` with the story at index `from` moved to index `to`. */
const moved = (list, from, to) => { const out = [...list]; out.splice(to, 0, ...out.splice(from, 1)); return out; };

// 4. Exploration. Each slot position (1-based) takes the best story at or below it
// scored by recency and importance only, affinity and boosts zeroed, so a story from a
// topic the owner does not follow can still reach the page. Of those, the best whose
// move keeps the lean quota as the quota pass left it; the best outright only when no
// move does.
function exploration(list, ctx) {
  let out = [...list];
  const placed = new Set();
  for (const pos of [...ctx.settings.exploration.positions].sort((a, b) => a - b)) {
    if (pos < 1 || pos > out.length) continue;
    const pool = out.slice(pos - 1).filter((s) => !placed.has(s.id)).sort(byNeutral);
    if (!pool.length) continue;
    const base = quotaBreaks(out, ctx);
    const pick = pool.find((s) => quotaBreaks(moved(out, out.indexOf(s), pos - 1), ctx) <= base) || pool[0];
    const from = out.indexOf(pick) + 1;
    out = moved(out, from - 1, pos - 1);
    placed.add(pick.id);
    const topics = pick.topics_matched.filter((t) => t !== MUST_KNOW);
    const reach = topics.length ? `topics ${listWords(topics)}` : "no followed topic";
    const kept = pick === pool[0] ? "" : " that keeps the lean quota";
    note(pick, "exploration", `Placed by exploration in slot ${pos}${from === pos ? "" : ` from ${from}`}: best on recency and importance alone${kept}, affinity and boosts zeroed (${reach})`, { from, to: pos });
  }
  markShifts(list, out, "exploration", shiftText("exploration", "an exploration slot above it was filled"));
  return out;
}

// 5. Other side. The first `per_page` cards whose cluster has at least 3 independent
// sources across at least 2 lean buckets each get one attached link: that cluster's
// newest article from the lean least represented among the page's first `window`
// cards, other than the card's own lean and any muted source. Between equally rare
// leans, the one furthest across the US spectrum from the card's own lean wins, so a
// left-led card gets the right before the center. Nothing moves.
const SPECTRUM = ["left", "center-left", "center", "center-right", "right"];
function otherSide(list, ctx) {
  const { per_page } = ctx.settings.other_side;
  const window = ctx.settings.lean_quota.window;
  const mix = new Map();
  list.slice(0, window).forEach((s) => { const l = cardLean(s, ctx); if (l) mix.set(l, (mix.get(l) || 0) + 1); });
  const muted = new Set((ctx.profile.mutes && ctx.profile.mutes.sources) || []);
  let given = 0;
  return list.map((story, i) => {
    if (given >= per_page || story.independent_sources < OTHER_SIDE_MIN_SOURCES || story.lean_buckets.length < 2) return story;
    const own = cardLean(story, ctx);
    const lead = leadOf(story, ctx);
    const candidates = story.article_ids.map((id) => ctx.articles.get(id))
      .filter((a) => a && a.id !== lead && !muted.has(a.source_id) && ctx.leans[a.source_id] && ctx.leans[a.source_id] !== own);
    if (!candidates.length) return story;
    const count = (l) => mix.get(l) || 0;
    const far = (l) => (SPECTRUM.includes(l) && SPECTRUM.includes(own) ? Math.abs(SPECTRUM.indexOf(l) - SPECTRUM.indexOf(own)) : 0);
    const lean = [...new Set(candidates.map((a) => ctx.leans[a.source_id]))].sort((a, b) => count(a) - count(b) || far(b) - far(a) || byStr(a, b))[0];
    const pick = candidates.filter((a) => ctx.leans[a.source_id] === lean)
      .sort((a, b) => b.ms - a.ms || byStr(a.id, b.id))[0];
    given += 1;
    const out = { ...story, passes: [...story.passes], other_side: { article_id: pick.id, source_id: pick.source_id, lean } };
    note(out, "other-side", `Other side attached: ${nameOf(ctx, pick.source_id)} (${lean}) on this story, the least represented lean in this page's first ${window} cards (${count(lean)} of ${Math.min(window, list.length)}); the card itself leads with ${own || "an outlet of no listed lean"}`, { from: i + 1, to: i + 1 });
    return out;
  });
}

// 6. Must-know floor (R16, OWNER-BRIEF). The top floor_slots places hold eligible
// stories: hard news covered by independent outlets across at least two lean buckets.
// Eligible stories already there count; the rest are the best eligible stories below,
// by recency and importance alone (the must_know affinity is zeroed by design), however
// low their score, preferring one whose move keeps the lean quota. The floor itself is
// never given up for the quota. Displaced cards keep their order below the floor.
function mustKnow(list, ctx) {
  const setting = (ctx.profile.topics || {})[MUST_KNOW];
  const floor = setting && setting.enabled && !((ctx.profile.mutes && ctx.profile.mutes.topics) || []).includes(MUST_KNOW) ? setting.floor_slots || 0 : 0;
  if (!floor) return list;
  const inZone = list.slice(0, floor).filter((s) => s.must_know);
  const top = [...inZone];
  const arrange = (head) => [...head, ...list.filter((s) => !head.includes(s))];
  const eligible = list.slice(floor).filter((s) => s.must_know).sort(byNeutral);
  while (top.length < floor && eligible.length) {
    const base = quotaBreaks(arrange(top), ctx);
    const i = Math.max(0, eligible.findIndex((s) => quotaBreaks(arrange([...top, s]), ctx) <= base));
    top.push(eligible.splice(i, 1)[0]);
  }
  const out = arrange(top);
  const was = new Map(list.map((s, i) => [s.id, i + 1]));
  top.forEach((s, i) => {
    const hard = s.topics.filter((t) => ctx.hardNews.includes(t));
    note(s, "must-know", `Placed by must-know${was.get(s.id) === i + 1 ? "" : ` from ${was.get(s.id)}`}: ${listWords(hard)} news from ${s.independent_sources} outlets across ${listWords(s.lean_buckets)}`, { from: was.get(s.id), to: i + 1 });
  });
  markShifts(list, out, "must-know", shiftText("must-know", "a must-know story was placed above it"));
  return out;
}

// Each pass is {name, fn(list, ctx) -> list}, the shape of ranker.js's opts.passes seam.
export const PASSES = Object.freeze({
  mute: { name: "mute", fn: mute },
  dedup: { name: "dedup", fn: dedup },
  "lean-quota": { name: "lean-quota", fn: leanQuota },
  exploration: { name: "exploration", fn: exploration },
  "other-side": { name: "other-side", fn: otherSide },
  "must-know": { name: "must-know", fn: mustKnow },
});

/** The context every pass reads, from the ranker's own compact pool. */
function passContext(pool, profile, opts) {
  const epoch = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
  return {
    profile,
    settings: settings(profile),
    leans: opts.leans || {},
    names: opts.names || {},
    hardNews: HARD_NEWS,
    articles: new Map((pool.articles || []).map((a) => [a.id, { ...a, ms: epoch(a.published_at) }])),
    leads: new Map((pool.clusters || []).filter((c) => c.lead).map((c) => [c.id, c.lead])),
    removed: [],
  };
}

const fresh = (list) => list.map((s) => ({ ...s, passes: s.passes.map((e) => ({ ...e })) }));
const run = (names, list, ctx) => names.reduce((acc, n) => PASSES[n].fn(acc, ctx), list);

/** Scores the pool and runs just the named passes, in the order given, over one list:
 * {list, removed}. For proofs and tools; the app runs rankPages. */
export function applyPasses(names, pool, profile, now, opts = {}) {
  const ctx = passContext(pool, profile, opts);
  const list = run(names, rank(pool, profile, now, { terms: opts.terms }), ctx);
  return { list, removed: ctx.removed };
}

/**
 * The pages for a profile: Today and every section tab, each after its passes.
 * Returns {today, removed, sections: [{id, label, slot, stories}]}; `today` and each
 * `stories` are ranker records plus their pass entries (and `other_side` where one is
 * attached); `removed` holds what mute and dedup took, each saying why.
 * opts: {buckets, leans, names, terms} (buckets and leans from sources.json, R10).
 */
export function rankPages(pool, profile, now, opts = {}) {
  const ctx = passContext(pool, profile, opts);
  const scored = rank(pool, profile, now, { terms: opts.terms });
  const kept = run(["mute", "dedup"], scored, ctx);
  const today = run(TODAY_PASSES, fresh(kept), ctx);
  const at = new Map(scored.map((s, i) => [s.id, i]));
  const sections = SECTIONS.filter((s) => !s.all).map((section) => {
    const here = (s) => inSection(s, section, opts.buckets || {});
    const gone = ctx.removed.filter(here);
    const list = fresh(kept.filter(here)).map((s) => {
      // Mute and dedup entries on Today count Today's places; in a tab, name the
      // removals above this story in this tab instead.
      s.passes = [];
      for (const pass of ["mute", "dedup"]) {
        const above = gone.filter((r) => at.get(r.id) < at.get(s.id) && r.passes.some((e) => e.pass === pass && e.to === null)).length;
        if (above) note(s, pass, `Moved up by ${pass}: ${above} ${pass === "mute" ? "muted" : "duplicate"} ${above === 1 ? "story" : "stories"} above it in this tab removed`);
      }
      return s;
    });
    return { id: section.id, label: section.label, slot: section.slot || null, stories: run(SECTION_PASSES, list, ctx) };
  });
  return { today, removed: ctx.removed, sections };
}
