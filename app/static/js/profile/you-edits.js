// U2: the pure edits behind the You page, its per-interest and standing-story pages and
// the source picker. Every function takes a profile and returns the next profile as a
// plain draft (ProfileStore.save stamps and validates it), or null when there is nothing
// to change, so a tap that changes nothing never writes a version. No DOM, no storage:
// Node tests import this unchanged (tests/js/you-edits.test.js).

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
