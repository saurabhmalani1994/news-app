// S24: Mute source, Mute topic and Boost topic (DESIGN-v1.1 "Story actions"). Each
// builds the next profile as a plain draft, the same shape ProfileStore.save() takes
// (S10): stamping the version and validating is the store's job, not this module's, so
// this stays pure and Node-testable. Every function returns null for "nothing to do"
// (already muted, already boosted, no source or topic to act on) so the caller never
// writes a no-op version.
import { ensureTopic, resolveTopic } from "./topic-resolve.js";

export function withSourceMuted(profile, sourceId) {
  const current = (profile.mutes && profile.mutes.sources) || [];
  if (!sourceId || current.includes(sourceId)) return null;
  return { ...profile, mutes: { ...profile.mutes, sources: [...current, sourceId] } };
}

export function withTopicMuted(profile, storyTopics) {
  const id = resolveTopic(storyTopics, profile.topics || {});
  const current = (profile.mutes && profile.mutes.topics) || [];
  if (!id || current.includes(id)) return null;
  const topics = ensureTopic(profile.topics || {}, id);
  return { ...profile, topics, mutes: { ...profile.mutes, topics: [...current, id] } };
}

export const BOOST_AMOUNT = 0.4;

export function withTopicBoosted(profile, storyTopics, { amount = BOOST_AMOUNT } = {}) {
  const id = resolveTopic(storyTopics, profile.topics || {});
  if (!id) return null;
  const topics = ensureTopic(profile.topics || {}, id);
  const boosts = profile.boosts || [];
  const boostId = `boost-topic-${id}`;
  if (boosts.some((b) => b.id === boostId)) return null;
  const boost = { id: boostId, label: `More ${topics[id].label}`, match_type: "topic", match_value: id, amount };
  return { ...profile, topics, boosts: [...boosts, boost] };
}

/** J38: "Less of this topic" from the story menu, one step and never a mute: a boost on
 * the topic goes first (that is what made it "more"); else its level steps down, more
 * to normal, normal to less. Null when the topic is already at Less or off, when the
 * story has no topic, or when the topic is not one the reader has (nothing to lower). */
export const LESS_AFFINITY = Object.freeze({ more: 0.6, normal: 0.2 });
export function withTopicLess(profile, storyTopics) {
  const id = resolveTopic(storyTopics, profile.topics || {});
  if (!id) return null;
  const boostId = `boost-topic-${id}`;
  const boosts = profile.boosts || [];
  if (boosts.some((b) => b.id === boostId)) return { ...profile, boosts: boosts.filter((b) => b.id !== boostId) };
  const topic = (profile.topics || {})[id];
  if (!topic || topic.enabled === false || typeof topic.affinity !== "number") return null;
  const next = topic.affinity >= 0.75 ? LESS_AFFINITY.more : topic.affinity >= 0.4 ? LESS_AFFINITY.normal : null;
  if (next === null) return null;
  return { ...profile, topics: { ...profile.topics, [id]: { ...topic, affinity: next } } };
}
