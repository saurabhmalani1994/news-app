// H2: brings a profile saved by an older build up to the current shape. Every field a
// later slice added is filled with its default only where it is missing: S13 passes,
// S28 standing_stories, S33 live_overrides, U2 display, and any sub-field of those. W1:
// a phrase interest's phrase is kept in its clean form (fillTopic).
// Nothing the owner set is changed, no topic (known or not) is dropped, and the stored
// history is never rewritten: ProfileStore saves the result once, as one new version.
//
// Pure, so it runs under Node's test runner (tests/js/profile-migrate.test.js). The
// defaults are the shipped default profile's own (default-profile.js), never a copy.

import { buildDefaultProfile } from "./default-profile.js";
import { normalizePhrase } from "../phrase.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` with every key `fallback` has and `value` lacks filled in, recursively for
 * plain objects; arrays and scalars the owner set are kept as they are. */
function fill(value, fallback) {
  if (!isObject(value) || !isObject(fallback)) return value === undefined ? structuredClone(fallback) : value;
  const out = { ...value };
  for (const [key, def] of Object.entries(fallback)) out[key] = fill(value[key], def);
  return out;
}

/** A standing story an older build saved without a field a later one requires. */
function fillStory(story, defaults) {
  if (!isObject(story)) return story;
  const known = defaults.find((d) => d.id === story.id);
  const generic = { enabled: true, keywords: [], tags: [], buckets: [], floor_slots: 0, floor_within: 15, silence_hours: 0 };
  return fill({ ...story, label: story.label || known?.label || story.id }, known || generic);
}

/** A topic an older build saved without `enabled` (or a label): shown, under its id.
 * W1: a phrase interest missing its label (a hand edit in Advanced) shows its phrase,
 * and a phrase saved with stray spaces or quotes is kept in its clean form, the form
 * the You page itself saves and the search query is built from. */
function fillTopic(id, topic) {
  if (!isObject(topic)) return topic;
  const out = { ...topic, enabled: topic.enabled !== false };
  if (typeof topic.phrase === "string") {
    const clean = normalizePhrase(topic.phrase);
    if (clean) out.phrase = clean;
  }
  out.label = topic.label || (typeof out.phrase === "string" && out.phrase) || id;
  return out;
}

/**
 * Returns {profile, added}: the profile with every missing field filled, and the list of
 * top-level fields that were missing (empty when the profile is already current, so a
 * caller saves only when there is something to save).
 */
export function migrateProfile(profile, now) {
  const defaults = buildDefaultProfile(now);
  const out = structuredClone(profile);
  const added = [];
  for (const [key, def] of Object.entries(defaults)) {
    if (["schema_version", "profile_version", "updated_at"].includes(key)) continue;
    if (out[key] === undefined || out[key] === null) {
      out[key] = structuredClone(def);
      added.push(key);
    }
  }
  if (isObject(out.topics)) {
    for (const [id, topic] of Object.entries(out.topics)) out.topics[id] = fillTopic(id, topic);
  }
  for (const key of ["mutes", "seen_penalty", "passes", "live_overrides", "display"]) {
    if (isObject(out[key])) out[key] = fill(out[key], defaults[key]);
  }
  if (Array.isArray(out.standing_stories)) {
    out.standing_stories = out.standing_stories.map((s) => fillStory(s, defaults.standing_stories));
  }
  const changed = added.length > 0 || JSON.stringify(out) !== JSON.stringify(profile);
  if (changed && !added.length) added.push("fields");
  return { profile: out, added: changed ? added : [] };
}
