// S24: which profile topic bucket a story's "Mute topic" or "Boost topic" action
// targets. profile.schema.json's checkIntegrity requires a muted topic to already be a
// key in profile.topics, so a pool tag with no bucket yet (the ranker matches it
// through nothing, ranker.js TAG_TO_TOPIC or a same-name key) needs one created before
// the mute or boost can save. That is exactly DESIGN-v1.1 section 9 item 2, "adding a
// bucket is a settings action, not a code change": this menu is that action, the first
// time a story from an untracked topic is muted or boosted.
import { TAG_TO_TOPIC } from "../ranker.js";

// Readable labels for tags that are not already a profile topic label (the six starter
// buckets carry their own label in the profile; this only covers the rest, e.g. the
// HARD_NEWS tags and the section tags sections.js never asks the ranker about).
const LABELS = Object.freeze({ ai: "AI", us_politics: "US Politics" });

export function topicLabel(id) {
  if (Object.hasOwn(LABELS, id)) return LABELS[id];
  return id.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** The one topic id a mute or boost targets: the first of the story's tags that is
 * already a profile topic (directly, or through TAG_TO_TOPIC), else that same mapping
 * applied to the first tag, so the result is always the id a new bucket would take.
 * Null only for a story with no topic tags at all. */
export function resolveTopic(storyTopics, profileTopics = {}) {
  const tags = (storyTopics || []).filter(Boolean).map((t) => (Object.hasOwn(profileTopics, t) ? t : TAG_TO_TOPIC[t] || t));
  if (!tags.length) return null;
  return tags.find((t) => Object.hasOwn(profileTopics, t)) || tags[0];
}

/** `topics` with `id` present, a fresh middling bucket if it was not already there. */
export function ensureTopic(topics, id, { affinity = 0.5, halfLifeHours = 24 } = {}) {
  if (!id || Object.hasOwn(topics, id)) return topics;
  return { ...topics, [id]: { label: topicLabel(id), affinity, half_life_hours: halfLifeHours, enabled: true } };
}
