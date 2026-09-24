// S26: keeps a saved has_body story's body available offline past the reader cache's
// normal 200-entry eviction (reader/cache.js KEEP, evictionIds). The body itself still
// lives only in S25's almanac-reader cache, keyed by article id; this never copies it
// into a second store. Pinning happens wherever a save happens (the card's own overflow
// sheet on any tab, or the Saved screen's own Unsave sheet), so both call through here
// rather than each carrying its own fetch-and-pin logic.
//
// `deps` is {cache, fetchBody}: `cache` is reader/cache.js's bodyCache in the browser
// (get/put/pin/unpin), or a plain double in tests; `fetchBody` is reader/core.js's
// loadBody, given the same shape so a test can hand it a stub that never touches
// indexedDB or the network.

async function pinSavedBody(record, { cache, fetchBody }) {
  if (!record?.has_body || !record.article_id) return;
  // Cache-first already (loadBody checks `cache` before the network): if the story was
  // already read once, this is just a pin with no request. Never throws: a save must
  // never fail because the device is offline or the fetch errors, only the offline
  // pinning is skipped, silently, for later.
  await fetchBody(record.article_id, { cache }).catch(() => {});
  await cache.pin(record.article_id).catch(() => {});
}

async function unpinSavedBody(record, { cache }) {
  if (!record?.has_body || !record.article_id) return;
  await cache.unpin(record.article_id).catch(() => {});
}

/** After toggleSave (actions/saves.js) resolves: pin on "added", unpin on "removed". */
export async function syncSavePin(result, deps) {
  if (result.action === "added") return pinSavedBody(result.record, deps);
  if (result.action === "removed") return unpinSavedBody(result.previous, deps);
  return undefined;
}

/** After undoSave reverses a toggle: the opposite of what syncSavePin just did. */
export async function syncUndoPin(action, record, previous, deps) {
  if (action === "added") return unpinSavedBody(record, deps);
  if (action === "removed") return pinSavedBody(previous, deps);
  return undefined;
}
