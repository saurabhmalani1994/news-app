// S11: the one ranker (DESIGN-v1.1 section 4). A pure, deterministic function of a pool,
// a profile and a time: no clock, no storage, no randomness, and the input arrays' order
// never matters. The same module runs at build time under Node (the default profile's
// front page) and on the device (a stored profile that differs from the default).
//
// Every score is the exact sum of its named terms. Terms are integers on a fixed scale
// of SCALE per point (micro-points), each rounded once, and the score is their integer
// sum, so sum(explanation) === score holds exactly and any order replays byte for byte.
//
// Base terms, in explanation order:
//   recency     W_RECENCY * 2^(-age / half-life); half-life is the longest among the
//               story's matched profile topics (R18), DEFAULT_HALF_LIFE_HOURS if none
//   affinity    W_AFFINITY * min(AFFINITY_CAP, strongest matched topic's affinity plus
//               EXTRA_TOPIC_SHARE of each other matched topic's), so a story tagged
//               with three followed topics is not three times as interesting
//   importance  W_IMPORTANCE * log2(independent sources), so one outlet adds nothing
//   trust       (trust - 1) * (recency + affinity + importance): the profile's trust is
//               a multiplier (R10, default 1.0), shown as its own signed contribution
//   boost:<id>  each matching flat boost's amount * W_BOOST
// Seams, not built here: S15 adds the seen penalty (R17) through `opts.terms`, and S13
// adds its post-passes (mute, dedup, lean quota, exploration, other side, must-know
// floor) through `opts.passes`; each pass names itself in the story's `passes` list.

export const SCALE = 1_000_000;
export const WEIGHTS = Object.freeze({ recency: 1, affinity: 1, importance: 0.5, boost: 1 });
export const AFFINITY_CAP = 1;
export const EXTRA_TOPIC_SHARE = 0.25;
export const DEFAULT_HALF_LIFE_HOURS = 12;

// R16 hard-news set; mirrors topics.json "hard_news" (a node test keeps them equal).
export const HARD_NEWS = Object.freeze(["conflict", "economy", "politics", "science", "world"]);

// Pool topic tags whose profile bucket has another name. Any other tag matches a
// profile topic of the same id, so adding a bucket stays a settings action.
export const TAG_TO_TOPIC = Object.freeze({ politics: "us_politics", biotech: "industrial_biotech" });

const MUST_KNOW = "must_know";
const HOUR_MS = 3_600_000;

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs) => [...new Set(xs)].sort(byStr);
const epochMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Independent outlets when a cluster predates S08's own count: a syndicated copy
 * group counts once, and one outlet counts once however many pieces it ran. */
function fallbackIndependent(members, nearDuplicates) {
  const groupOf = new Map();
  [...nearDuplicates].map((g) => [...g].sort(byStr)).sort((a, b) => byStr(a[0], b[0]))
    .forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const units = new Set(members.map((a) => (groupOf.has(a.id) ? `g${groupOf.get(a.id)}` : `s:${a.source_id}`)));
  return units.size;
}

/** The pool as stories: one per cluster, one per article no cluster holds. Same
 * grouping as app/frontpage.py's build_stories (a pytest checks the ids agree). */
export function storiesFromPool(pool) {
  const byId = new Map((pool.articles || []).map((a) => [a.id, a]));
  const clustered = new Set();
  const stories = [];
  const clusters = [...(pool.clusters || [])].sort((a, b) => byStr(a.id, b.id));
  for (const c of clusters) {
    const members = uniqSorted(c.article_ids).filter((id) => byId.has(id) && !clustered.has(id)).map((id) => byId.get(id));
    if (!members.length) continue;
    members.forEach((a) => clustered.add(a.id));
    stories.push(makeStory(c.id, members, {
      independent: Number.isInteger(c.independent_sources) ? c.independent_sources : fallbackIndependent(members, c.near_duplicates || []),
      lean: c.lean_buckets || [],
    }));
  }
  for (const a of byId.values()) {
    if (!clustered.has(a.id)) stories.push(makeStory(a.id, [a], { independent: 1, lean: [] }));
  }
  return stories.sort((a, b) => byStr(a.id, b.id));
}

function makeStory(id, members, { independent, lean }) {
  return {
    id,
    article_ids: members.map((a) => a.id).sort(byStr),
    source_ids: uniqSorted(members.map((a) => a.source_id)),
    topics: uniqSorted(members.flatMap((a) => a.topics || [])),
    titles: members.map((a) => a.title || "").sort(byStr),
    latest_ms: Math.max(...members.map((a) => epochMs(a.published_at))),
    independent_sources: independent,
    lean_buckets: uniqSorted(lean),
  };
}

/** R16: hard-news tags and independent sources spanning at least two lean buckets.
 * Syndication breadth alone never qualifies: one piece of copy carried by outlets of
 * different leans is still one independent source. */
export function mustKnowEligible(story) {
  return story.topics.some((t) => HARD_NEWS.includes(t))
    && story.independent_sources >= 2
    && story.lean_buckets.length >= 2;
}

function matchedTopics(story, profile, eligible) {
  const topics = profile.topics || {};
  const ids = new Set();
  for (const tag of story.topics) {
    const id = Object.hasOwn(topics, tag) ? tag : TAG_TO_TOPIC[tag];
    if (id && topics[id] && topics[id].enabled) ids.add(id);
  }
  if (eligible && topics[MUST_KNOW] && topics[MUST_KNOW].enabled) ids.add(MUST_KNOW);
  return [...ids].sort(byStr);
}

function boostMatches(boost, story, matched) {
  const value = String(boost.match_value);
  if (boost.match_type === "topic") return matched.includes(value) || story.topics.includes(value);
  if (boost.match_type === "source") return story.source_ids.includes(value);
  if (boost.match_type === "keyword") {
    const needle = value.toLowerCase();
    return story.titles.some((t) => t.toLowerCase().includes(needle));
  }
  return false;
}

const micro = (x) => Math.round(x * SCALE);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** One story's explanation: [{term, value, detail}], value an integer in micro-points. */
export function scoreStory(story, profile, nowMs) {
  const eligible = mustKnowEligible(story);
  const matched = matchedTopics(story, profile, eligible);
  const topics = profile.topics || {};
  const halfLife = matched.length ? Math.max(...matched.map((id) => topics[id].half_life_hours)) : DEFAULT_HALF_LIFE_HOURS;
  const ageHours = Math.max(0, (nowMs - story.latest_ms) / HOUR_MS);
  const weights = matched.map((id) => topics[id].affinity);
  const strongest = weights.length ? Math.max(...weights) : 0;
  const affinityRaw = strongest + EXTRA_TOPIC_SHARE * (weights.reduce((a, b) => a + b, 0) - strongest);
  const trustTable = profile.trust || {};
  const trust = Math.max(...story.source_ids.map((s) => (Object.hasOwn(trustTable, s) ? trustTable[s] : 1)));

  const recency = micro(WEIGHTS.recency * 2 ** (-ageHours / halfLife));
  const affinity = micro(WEIGHTS.affinity * Math.min(AFFINITY_CAP, affinityRaw));
  const importance = micro(WEIGHTS.importance * Math.log2(Math.max(1, story.independent_sources)));
  const terms = [
    { term: "recency", value: recency, detail: `${ageHours.toFixed(1)}h old, ${halfLife}h half-life` },
    { term: "affinity", value: affinity, detail: matched.join(", ") || "no followed topic" },
    { term: "importance", value: importance, detail: `${story.independent_sources} independent sources` },
    { term: "trust", value: Math.round((trust - 1) * (recency + affinity + importance)), detail: `x${trust}` },
  ];
  const boosts = [...(profile.boosts || [])].sort((a, b) => byStr(a.id, b.id));
  for (const b of boosts) {
    if (boostMatches(b, story, matched)) {
      terms.push({ term: `boost:${b.id}`, value: micro(WEIGHTS.boost * clamp(b.amount, -1, 1)), detail: b.label });
    }
  }
  return { terms, matched, eligible };
}

const sum = (terms) => terms.reduce((s, t) => s + t.value, 0);

/**
 * Ranks a pool for a profile at a time. Returns stories best first, each with
 * `score` (integer micro-points), `explanation` (signed named terms summing to it
 * exactly), `must_know` (R16 eligibility) and `passes` (names of post-passes that
 * touched it; empty until S13). `now` is an ISO timestamp or epoch milliseconds.
 *
 * opts.terms: extra per-story terms [{name, fn(story, ctx) -> points}] (S15 seen penalty).
 * opts.passes: post-passes [{name, fn(ranked, ctx) -> ranked}] run in order (S13).
 */
export function rank(pool, profile, now, opts = {}) {
  const nowMs = typeof now === "number" ? now : epochMs(now);
  const ctx = { profile, nowMs, ...(opts.context || {}) };
  const ranked = storiesFromPool(pool).map((story) => {
    const { terms, matched, eligible } = scoreStory(story, profile, nowMs);
    for (const extra of opts.terms || []) {
      terms.push({ term: extra.name, value: micro(extra.fn(story, ctx)), detail: extra.detail || "" });
    }
    return { ...story, topics_matched: matched, must_know: eligible, score: sum(terms), explanation: terms, passes: [] };
  });
  ranked.sort((a, b) => b.score - a.score || b.latest_ms - a.latest_ms || byStr(a.id, b.id));
  let out = ranked;
  for (const pass of opts.passes || []) out = pass.fn(out, ctx);
  return out;
}

/** A canonical string of the profile fields that change ranking. The build stamps the
 * default profile's key on the page; the device re-ranks only when its key differs.
 * rank-gate.js carries a byte-identical copy of `canonical` (a node test checks). */
export function profileKey(profile) {
  const p = profile || {};
  return canonical([p.topics, p.trust, p.boosts, p.mutes, p.seen_penalty]);
}

export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
