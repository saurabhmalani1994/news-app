// U2: the pure edits behind the You page, its per-interest and standing-story pages and
// the source picker. Every function takes a profile and returns the next profile as a
// plain draft (ProfileStore.save stamps and validates it), or null when there is nothing
// to change, so a tap that changes nothing never writes a version. No DOM, no storage:
// Node tests import this unchanged (tests/js/you-edits.test.js).
//
// U4: adding and removing an interest. STARTER_TOPICS (default-profile.js) is the one
// source of the six starter buckets' own settings, reused here so re-adding one of them
// restores its shipped defaults rather than a flattened generic value.
//
// W1 (R50): a phrase interest (the owner's own free text) is added here too, and a
// standing story can be added and removed, not only edited.
import { STARTER_TOPICS } from "./default-profile.js";
import { STANDING_DEFAULTS, STANDING_NEW } from "../standing.js";
import { PHRASE_MAX, QUERIES_MAX, isPhraseTopic, normalizePhrase, textWords } from "../phrase.js";

// --- Interest levels: plain words over the 0 to 1 affinity weight. ---
//
// Off is the topic's own enabled flag, not an affinity: switching a topic off keeps its
// weight, so turning it back on at the same level is one tap. The other three read the
// affinity in ranges and write one fixed value when chosen. Choosing the level a topic
// already reads as changes nothing, so a hand-tuned 0.8 stays 0.8 when More is tapped.
export const LEVELS = Object.freeze([
  { id: "more", word: "More", min: 0.75, max: 1, value: 0.9 },
  { id: "normal", word: "Normal", min: 0.4, max: 0.75, value: 0.6 },
  { id: "less", word: "Less", min: 0, max: 0.4, value: 0.2 },
  { id: "off", word: "Off" },
]);

const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]));

/** The level id an affinity reads as, ignoring enabled: more, normal or less. */
export function levelForAffinity(affinity) {
  const a = Number(affinity);
  if (a >= LEVEL_BY_ID.more.min) return "more";
  if (a >= LEVEL_BY_ID.normal.min) return "normal";
  return "less";
}

/** The affinity written when a level is chosen; null for off (off is enabled=false). */
export function affinityForLevel(level) {
  const entry = LEVEL_BY_ID[level];
  return entry && entry.value !== undefined ? entry.value : null;
}

/** The level id a topic setting reads as: off when disabled, else by affinity. */
export function levelOf(setting) {
  if (!setting || setting.enabled === false) return "off";
  return levelForAffinity(setting.affinity);
}

export function levelWord(level) {
  return LEVEL_BY_ID[level]?.word || "";
}

function withTopic(profile, id, patch) {
  const current = profile.topics?.[id];
  if (!current) return null;
  const next = { ...current, ...patch };
  if (Object.keys(patch).every((k) => current[k] === next[k])) return null;
  return { ...profile, topics: { ...profile.topics, [id]: next } };
}

/** Sets a topic's level. More, Normal and Less also switch a disabled topic back on. */
export function withTopicLevel(profile, id, level) {
  const current = profile.topics?.[id];
  if (!current || !LEVEL_BY_ID[level]) return null;
  if (level === "off") return withTopic(profile, id, { enabled: false });
  if (current.enabled !== false && levelForAffinity(current.affinity) === level) return null;
  const patch = { enabled: true };
  if (levelForAffinity(current.affinity) !== level) patch.affinity = affinityForLevel(level);
  return withTopic(profile, id, patch);
}

/** One numeric field of a topic (affinity, half_life_hours, floor_slots). */
export function withTopicField(profile, id, field, value) {
  if (!["affinity", "half_life_hours", "floor_slots"].includes(field)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return withTopic(profile, id, { [field]: number });
}

/** Hides a topic's stories outright (mutes.topics, S13's mute pass) or shows them again. */
export function withTopicMuted(profile, id, muted) {
  const list = profile.mutes?.topics || [];
  if (list.includes(id) === muted) return null;
  const topics = muted ? [...list, id] : list.filter((t) => t !== id);
  return { ...profile, mutes: { ...profile.mutes, topics } };
}

/** The boosts that target one topic (match_type topic), in profile order. */
export function boostsForTopic(profile, id) {
  return (profile.boosts || []).filter((b) => b.match_type === "topic" && b.match_value === id);
}

export function withBoostAmount(profile, boostId, amount) {
  const number = Number(amount);
  const boosts = profile.boosts || [];
  const index = boosts.findIndex((b) => b.id === boostId);
  if (index < 0 || !Number.isFinite(number) || boosts[index].amount === number) return null;
  const next = boosts.slice();
  next[index] = { ...boosts[index], amount: number };
  return { ...profile, boosts: next };
}

export function withBoostRemoved(profile, boostId) {
  const boosts = profile.boosts || [];
  if (!boosts.some((b) => b.id === boostId)) return null;
  return { ...profile, boosts: boosts.filter((b) => b.id !== boostId) };
}

// --- U4: the interest catalog, and adding or removing one. ---
//
// The ids offered are exactly the ones the pipeline can actually match a story to:
// the closed topic-tag set fetcher/topics.py tags articles with (topics.json's own
// "topics" list), with ranker.js's TAG_TO_TOPIC remap folded in so the tag and the
// interest id it lands on are never offered as two different things (the "biotech" tag
// lands on the "industrial_biotech" bucket, so that is what is offered, not "biotech"
// itself). "politics" and "us_politics" are both offered since the pipeline tags them
// separately (a UK election is "politics" but never "us_politics"). must_know is not a
// tag at all: it is the ranker's own guaranteed-floor bucket (ranker.js MUST_KNOW,
// matched by mustKnowEligible(), not by a story's topic tags), offered on its own
// since it is still an interest the pipeline can and does match.
//
// W1 (R50) adds the one interest outside this closed set: a phrase, the owner's own
// free text, which the ranker matches in headlines and deks (phrase.js), not by tag.
// It is offered from the same sheet ("Follow a phrase"), below.
export const INTEREST_CATALOG = Object.freeze([
  { id: "singapore", label: "Singapore", group: "Regions" },
  { id: "asia", label: "Asia", group: "Regions" },
  { id: "world", label: "World", group: "Regions" },
  { id: "ai", label: "AI", group: "Sectors" },
  { id: "industrial_biotech", label: "Industrial Biotech", group: "Sectors" },
  { id: "climate_tech", label: "Climate Tech", group: "Sectors" },
  { id: "foodtech", label: "Foodtech", group: "Sectors" },
  { id: "us_politics", label: "US Politics", group: "Subjects" },
  { id: "politics", label: "Politics", group: "Subjects" },
  { id: "economy", label: "Economy", group: "Subjects" },
  { id: "science", label: "Science", group: "Subjects" },
  { id: "conflict", label: "Conflict", group: "Subjects" },
  { id: "must_know", label: "Must-know", group: "Guaranteed" },
]);

/** The catalog entries not already in the profile, catalog order (grouped). */
export function availableInterests(profile) {
  const have = profile.topics || {};
  return INTEREST_CATALOG.filter((entry) => !Object.hasOwn(have, entry.id));
}

/** Adds a catalog interest at a sensible default level. Null when `id` is not in the
 * catalog (an unknown id) or is already one of the profile's interests (a duplicate).
 * A starter bucket (STARTER_TOPICS) restores its own shipped weight and half-life, so
 * removing and re-adding one is not lossy; any other catalog entry gets the same
 * Normal-level default this page's own Advanced section has always used. */
export function withTopicAdded(profile, id) {
  const entry = INTEREST_CATALOG.find((e) => e.id === id);
  if (!entry) return null;
  if (Object.hasOwn(profile.topics || {}, id)) return null;
  const setting = STARTER_TOPICS[id] ? { ...STARTER_TOPICS[id] } : { label: entry.label, affinity: 0.6, half_life_hours: 24, enabled: true };
  return { ...profile, topics: { ...profile.topics, [id]: setting } };
}

/** Removes an interest outright: not in the profile is refused (null), and the
 * profile.schema.json floor of at least one topic is refused the same way, so the
 * store's own validation is never the one to catch it. Its mute (if any) and any boost
 * that targeted it go too, so nothing orphaned is left for checkIntegrity to trip on;
 * Undo (store.revert) restores the exact prior version regardless, boosts included. */
export function withTopicRemoved(profile, id) {
  const topics = profile.topics || {};
  if (!Object.hasOwn(topics, id) || Object.keys(topics).length <= 1) return null;
  const nextTopics = { ...topics };
  delete nextTopics[id];
  const mutedTopics = (profile.mutes?.topics || []).filter((t) => t !== id);
  const boosts = (profile.boosts || []).filter((b) => !(b.match_type === "topic" && b.match_value === id));
  return { ...profile, topics: nextTopics, mutes: { ...profile.mutes, topics: mutedTopics }, boosts };
}

// --- W1: phrase interests. ---
//
// A phrase interest is a topic like any other (a level, a half-life, a page of its
// own, Remove with Undo), under an id of its own ("p_" and the phrase's letters), with
// its text in `phrase`. The ranker matches it in headlines and deks; the interests sync
// sends its query to the hourly search. Both caps below are the search's: a phrase in
// quotes stays under the query limit, and phrases plus standing stories that are on
// stay within the query count, so every one the owner follows is searched.

export { isPhraseTopic };

const slug = (text) => String(text).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** An id not yet taken in `taken` (a Set or object keys): `base`, else base_2, base_3. */
function freeId(base, taken) {
  const has = (id) => (taken instanceof Set ? taken.has(id) : Object.hasOwn(taken, id));
  if (!has(base)) return base;
  for (let n = 2; ; n++) if (!has(`${base}_${n}`)) return `${base}_${n}`;
}

/** The topic id a new phrase gets: "p_" and its letters, unique in the profile. */
export function phraseTopicId(profile, phrase) {
  const base = `p_${slug(phrase).slice(0, 27).replace(/_+$/, "") || "phrase"}`;
  return freeId(base, profile.topics || {});
}

/** Phrase interests and standing stories that are on: what the hourly search runs. */
export function searchCount(profile) {
  const phrases = Object.values(profile.topics || {}).filter((t) => isPhraseTopic(t) && t.enabled !== false).length;
  const stories = (Array.isArray(profile.standing_stories) ? profile.standing_stories : STANDING_DEFAULTS)
    .filter((s) => s && s.enabled !== false).length;
  return phrases + stories;
}

/** Whether typed text can become a phrase interest: {ok, phrase} or {ok: false,
 * reason}, reason one of empty, long, duplicate (with the id it repeats) or full. */
export function phraseStatus(profile, text) {
  const phrase = normalizePhrase(text);
  if (!phrase) return { ok: false, reason: "empty" };
  if (phrase.length > PHRASE_MAX) return { ok: false, reason: "long", phrase };
  const words = textWords(phrase).join(" ");
  const same = Object.entries(profile.topics || {})
    .find(([, t]) => isPhraseTopic(t) && textWords(t.phrase).join(" ") === words);
  if (same) return { ok: false, reason: "duplicate", phrase, id: same[0] };
  if (searchCount(profile) >= QUERIES_MAX) return { ok: false, reason: "full", phrase };
  return { ok: true, phrase };
}

/** Adds a phrase interest at Normal, 24h half-life (the same default any other new
 * interest gets). Null when phraseStatus refuses the text. */
export function withPhraseAdded(profile, text) {
  const status = phraseStatus(profile, text);
  if (!status.ok) return null;
  const id = phraseTopicId(profile, status.phrase);
  const setting = { label: status.phrase, phrase: status.phrase, affinity: 0.6, half_life_hours: 24, enabled: true };
  return { ...profile, topics: { ...profile.topics, [id]: setting } };
}

// --- Standing stories (S28): one field of one story, by id. ---

/** "a, b; c" or one per line into a clean keyword list: trimmed, no blanks or repeats. */
export function parseKeywords(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text).split(/[,;\n]/)) {
    const word = part.trim().replace(/\s+/g, " ");
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
  }
  return out;
}

export function withStandingField(profile, id, field, value) {
  if (!["enabled", "keywords", "floor_slots", "floor_within", "silence_hours"].includes(field)) return null;
  const list = profile.standing_stories || [];
  const index = list.findIndex((s) => s.id === id);
  if (index < 0) return null;
  let next = value;
  if (field === "keywords") next = Array.isArray(value) ? value : parseKeywords(value);
  else if (field !== "enabled") {
    next = Number(value);
    if (!Number.isFinite(next)) return null;
  }
  if (JSON.stringify(list[index][field]) === JSON.stringify(next)) return null;
  const stories = list.slice();
  stories[index] = { ...list[index], [field]: next };
  return { ...profile, standing_stories: stories };
}

// --- W1: adding and removing a standing story. ---
//
// A new story takes the defaults' own floor and alarm (standing.js STANDING_NEW), no
// tags (a headline with a keyword counts wherever it runs) and no buckets (no sources
// of its own for the alarm to check). An absent standing_stories field means the two
// defaults, so the first add or remove writes them out first and keeps them.

export const STANDING_MAX = 12; // profile.schema.json standing_stories maxItems
export const STANDING_LABEL_MAX = 40;

const storiesOf = (profile) => (Array.isArray(profile.standing_stories)
  ? profile.standing_stories : structuredClone(STANDING_DEFAULTS));

/** Keywords a standing story can keep: parseKeywords, each 2 to 60 characters, 40 at most. */
export function standingKeywords(text) {
  return (Array.isArray(text) ? text : parseKeywords(text)).filter((k) => k.length >= 2 && k.length <= 60).slice(0, 40);
}

/** Whether a name and keywords can become a standing story: {ok, label, keywords} or
 * {ok: false, reason}, reason one of name, keywords, duplicate or full. */
export function standingStatus(profile, { label, keywords }) {
  const name = String(label ?? "").trim().replace(/\s+/g, " ").slice(0, STANDING_LABEL_MAX);
  const words = standingKeywords(keywords ?? "");
  const stories = storiesOf(profile);
  if (!name) return { ok: false, reason: "name" };
  if (!words.length) return { ok: false, reason: "keywords", label: name };
  if (stories.some((s) => String(s.label).toLowerCase() === name.toLowerCase())) return { ok: false, reason: "duplicate", label: name };
  if (stories.length >= STANDING_MAX) return { ok: false, reason: "full", label: name };
  return { ok: true, label: name, keywords: words };
}

/** The id a new standing story gets: its name's letters, unique among the stories. */
export function standingId(profile, label) {
  let base = slug(label).slice(0, 29).replace(/_+$/, "");
  if (!/^[a-z]/.test(base)) base = `s_${base}`.replace(/_+$/, "");
  if (base.length < 2) base = "story";
  return freeId(base, new Set(storiesOf(profile).map((s) => s.id)));
}

/** Appends a standing story, last in priority. Null when standingStatus refuses it. */
export function withStandingAdded(profile, draft) {
  const status = standingStatus(profile, draft);
  if (!status.ok) return null;
  const stories = storiesOf(profile);
  const story = {
    id: standingId(profile, status.label), label: status.label, enabled: true, keywords: status.keywords,
    tags: [], buckets: [], ...STANDING_NEW,
  };
  return { ...profile, standing_stories: [...stories, story] };
}

/** Removes a standing story by id; null when there is no such story. */
export function withStandingRemoved(profile, id) {
  const stories = storiesOf(profile);
  if (!stories.some((s) => s.id === id)) return null;
  return { ...profile, standing_stories: stories.filter((s) => s.id !== id) };
}

// --- Display (U1 reads it): summaries on every story, or only on the lead stories. ---

export function summariesMode(profile) {
  return profile.display?.summaries === "top" ? "top" : "all";
}

export function withSummaries(profile, mode) {
  if (!["all", "top"].includes(mode) || summariesMode(profile) === mode) return null;
  return { ...profile, display: { ...(profile.display || {}), summaries: mode } };
}

// L1: the lean marker after a source name, on unless turned off; its filled dot grey
// unless colored. An absent field reads as the default, so an older profile needs no
// migration. rank-gate.js reads the same two fields before first paint.

export function leanMarkersOn(profile) {
  return profile.display?.lean_markers !== false;
}

export function leanColorOn(profile) {
  return profile.display?.lean_color === true;
}

export function withLeanMarkers(profile, on) {
  if (typeof on !== "boolean" || leanMarkersOn(profile) === on) return null;
  return { ...profile, display: { ...(profile.display || {}), lean_markers: on } };
}

export function withLeanColor(profile, on) {
  if (typeof on !== "boolean" || leanColorOn(profile) === on) return null;
  return { ...profile, display: { ...(profile.display || {}), lean_color: on } };
}

// --- Sources: on or off, written as mutes.sources so the ranker's S13 mute pass does
// the removing (no ranker change). ---
//
// Seam for a later bundles build: a source's state is a word, not a boolean, so a
// third state ("only in comparisons") slots in as one more SOURCE_STATES entry, read
// and written here from its own profile field, with the page's row control switching
// on sourceState() rather than on a checkbox's checked flag. Only on and off exist now.
export const SOURCE_STATES = Object.freeze({ ON: "on", OFF: "off" });

export function sourceState(profile, id) {
  return (profile.mutes?.sources || []).includes(id) ? SOURCE_STATES.OFF : SOURCE_STATES.ON;
}

/** Sets many sources at once (a group's "turn all on or off"); null if none change. */
export function withSourceStates(profile, ids, state) {
  const muted = profile.mutes?.sources || [];
  const set = new Set(muted);
  for (const id of ids) {
    if (state === SOURCE_STATES.OFF) set.add(id);
    else if (state === SOURCE_STATES.ON) set.delete(id);
  }
  if (set.size === muted.length && muted.every((id) => set.has(id))) return null;
  // Keep existing order, append new mutes in the order given, so a diff reads cleanly.
  const sources = [...muted.filter((id) => set.has(id)), ...ids.filter((id) => set.has(id) && !muted.includes(id))];
  return { ...profile, mutes: { ...profile.mutes, sources: [...new Set(sources)] } };
}

export function withSourceState(profile, id, state) {
  return withSourceStates(profile, [id], state);
}

/** {on, total} over the catalog's sources (a stale mute of a retired source is not counted). */
export function sourceCounts(profile, catalogSources) {
  const total = catalogSources.length;
  const on = catalogSources.filter((s) => sourceState(profile, s.id) === SOURCE_STATES.ON).length;
  return { on, total };
}

// Region groups, in the order the page shows them. A bucket not named here (a later
// slice may add many) still gets a group, after these, labelled from its own id.
export const REGION_ORDER = Object.freeze([
  ["general", "General and world"],
  ["us_politics", "US politics"],
  ["singapore", "Singapore"],
  ["asia", "Asia"],
  ["israel_gaza", "Israel and Gaza"],
  ["sudan", "Sudan"],
  ["ai", "AI"],
  ["biotech", "Biotech"],
]);

export function regionLabel(bucket) {
  const known = REGION_ORDER.find(([id]) => id === bucket);
  if (known) return known[1];
  if (!bucket) return "Other";
  const words = bucket.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** [{bucket, label, sources}] grouped by region, sources by name within each. */
export function groupByRegion(catalogSources) {
  const groups = new Map();
  for (const source of catalogSources) {
    const bucket = source.bucket || "";
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(source);
  }
  const rank = (b) => {
    const i = REGION_ORDER.findIndex(([id]) => id === b);
    return i < 0 ? REGION_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([bucket, sources]) => ({
      bucket,
      label: regionLabel(bucket),
      sources: sources.slice().sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" })),
    }));
}

// U5: the picker's own nested groups. The owner, on his phone: "the you page now got
// way too big again... specifically the news sources page" (97 rows, every one drawn
// at once). These fold sources.json's finer buckets under about eight clear names, each
// its own collapsed row on #sources and its own sub-view (#sources/<id>) when opened, so
// the list page draws eight rows instead of ninety-seven. A bucket not listed here (a
// later slice's new region) still gets a group of its own, named from the bucket
// (regionLabel), appended after these, so a source is never dropped (H2).
export const SOURCE_GROUPS = Object.freeze([
  { id: "us_politics", label: "US politics", buckets: ["us_politics"] },
  { id: "world", label: "World", buckets: ["general", "israel_gaza", "sudan", "europe", "africa", "latin_america", "middle_east", "oceania"] },
  { id: "asia", label: "Asia", buckets: ["asia"] },
  { id: "singapore", label: "Singapore", buckets: ["singapore"] },
  { id: "business", label: "Business", buckets: ["business"] },
  { id: "tech_ai", label: "Tech and AI", buckets: ["ai"] },
  { id: "science_biotech", label: "Science and biotech", buckets: ["science", "biotech"] },
  { id: "climate_food", label: "Climate and food", buckets: ["climate_food"] },
]);

const BUCKET_TO_GROUP = Object.freeze(
  Object.fromEntries(SOURCE_GROUPS.flatMap((g) => g.buckets.map((bucket) => [bucket, g.id]))),
);

export function sourceGroupLabel(id) {
  return SOURCE_GROUPS.find((g) => g.id === id)?.label || regionLabel(id);
}

/** [{id, label, sources}] over about eight groups (SOURCE_GROUPS' order, then any
 * unmapped bucket by name), sources by name within each. Every catalog source lands in
 * exactly one group: the Map keyed by group id guarantees that, whatever the bucket. */
export function groupSources(catalogSources) {
  const groups = new Map();
  for (const source of catalogSources) {
    const bucket = source.bucket || "";
    const id = BUCKET_TO_GROUP[bucket] || bucket || "other";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(source);
  }
  const rank = (id) => {
    const i = SOURCE_GROUPS.findIndex((g) => g.id === id);
    return i < 0 ? SOURCE_GROUPS.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, groupSourcesList]) => ({
      id,
      label: sourceGroupLabel(id),
      sources: groupSourcesList.slice().sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" })),
    }));
}

/** Every source, from any group, whose name matches the query: U5's flat search. */
export function searchSources(catalogSources, query) {
  return catalogSources.filter((s) => matchesQuery(s.name, query));
}

/** Case and accent insensitive name match, every typed word somewhere in the name. */
export function matchesQuery(name, query) {
  const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hay = fold(name);
  return words.every((w) => hay.includes(w));
}

const LEAN_WORDS = {
  left: "Left",
  "center-left": "Center-left",
  center: "Center",
  "center-right": "Center-right",
  right: "Right",
  "non-us": "Outside US left and right",
  state: "State media",
};

export function leanWord(lean) {
  return LEAN_WORDS[lean] || "";
}

export function ownershipWord(ownership) {
  if (!ownership) return "";
  const words = String(ownership).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The row's quiet second line: lean in words, then ownership where present. State
 * media with a state ownership label says it once, not twice. */
export function sourceDetail(source) {
  const own = ownershipWord(source.ownership);
  const lean = leanWord(source.lean);
  if (own && source.lean === "state") return own;
  return [lean, own].filter(Boolean).join(" · ");
}

export const HEALTH_WORDS = Object.freeze({
  ok: "Working",
  empty: "Empty",
  failing: "Failing",
  down: "Down",
  unknown: "No data yet",
});

// --- Committing: one edit, one version, and what Undo needs. ---

/**
 * Runs `edit(current)` and saves the result as one new version. Returns null when the
 * edit changes nothing (no version written), else the store's own save result plus
 * `before`, the version Undo reverts to.
 */
export function commitEdit(store, edit) {
  const current = store.current();
  const draft = edit(current);
  if (!draft) return null;
  const before = current.profile_version;
  const result = store.save(draft);
  return { ...result, before };
}
