// S24: thumbs up/down (R19, DESIGN-v1.1 "Story actions"). A thumb is recorded with
// the story's own attributes and a time, never applied as a weight change and never
// written through ProfileStore: this module never imports it and never touches
// profile.json, so R19 holds by construction, not by convention. `store` is
// {get(id), put(record), delete(id)}, the actions/store.js IndexedDB adapter in the
// browser or a plain Map-backed stand-in in tests.

/** The record a thumb writes: the story's attributes plus the vote and the time,
 * nothing that could feed a score back into the ranker. */
export function buildThumbRecord(id, direction, attributes, now) {
  const time = typeof now === "function" ? now() : now;
  return {
    id,
    direction, // "up" | "down"
    topics: attributes.topics || [],
    source: attributes.source || null,
    lean: attributes.lean || null,
    cluster_size: attributes.cluster_size ?? 1,
    tab: attributes.tab || null,
    rank: attributes.rank ?? null,
    time,
  };
}

/** Toggles story `id`'s thumb to `direction`: tapping the same direction again clears
 * it (the toggle is its own undo); the other direction replaces it. Returns
 * {action: "set" | "cleared", record, previous}. */
export async function toggleThumb(store, id, direction, attributes, now) {
  const previous = (await store.get(id)) || null;
  if (previous && previous.direction === direction) {
    await store.delete(id);
    return { action: "cleared", record: null, previous };
  }
  const record = buildThumbRecord(id, direction, attributes, now);
  await store.put(record);
  return { action: "set", record, previous };
}

/** Reverts one toggleThumb call: puts `previous` back, or clears if there was none. */
export async function undoThumb(store, id, previous) {
  if (previous) await store.put(previous);
  else await store.delete(id);
}
