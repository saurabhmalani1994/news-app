// S15: writes a card snapshot to the history store (DESIGN-v1.1 section 7, R17, R23).
// `store` is {get(id), put(record), delete(id)}, history/store.js's openedStore or
// shownStore in the browser, or a plain Map-backed stand-in in tests (the same shape
// actions/saves.js and actions/thumbs.js already use). `id` is the story's own id, the
// same one ranker.js's stories carry (a pool cluster id, or the lone article's id):
// the join key the seen-penalty term (history/penalty.js) looks stories up by.
//
// Session-once: a story scrolled past three times in one page life, or a reader
// reopened after the back button, writes at most once per store per session (the node
// test "recorded once per story per session" checks this). The guard is in-memory and
// module-scoped, so it resets itself on every fresh page load, which is what "session"
// means here; `resetHistorySession` exists only for tests that need a second session
// inside one process.
const sessionSeen = { opened: new Set(), shown: new Set() };

export function resetHistorySession() {
  sessionSeen.opened.clear();
  sessionSeen.shown.clear();
}

/** The card snapshot a history entry keeps: id, cluster id (the same id, carried
 * explicitly so an exported record is self-describing without its IndexedDB keyPath,
 * for S34's history screen and S35's export/import), title, source, url, image,
 * topics and the event time. Mirrors actions/saves.js's buildSaveSnapshot field for
 * field, so a story recorded to history and one saved agree on what a "card" is. */
export function buildHistorySnapshot(id, attributes, now) {
  const time = typeof now === "function" ? now() : now;
  return {
    id,
    cluster_id: id,
    title: attributes.title || "",
    source: attributes.source_name || attributes.source || "",
    url: attributes.url || "",
    image: attributes.image || null,
    topics: attributes.topics || [],
    time,
  };
}

async function record(store, session, id, attributes, now, onWrite) {
  if (session.has(id)) return { recorded: false, record: null };
  session.add(id);
  const snapshot = buildHistorySnapshot(id, attributes, now);
  await store.put(snapshot);
  if (onWrite) onWrite(snapshot);
  return { recorded: true, record: snapshot };
}

/** The owner opened the story: in the reader, or tapped out to the source. Full
 * penalty weight (R17). `onWrite`, optional, is for the compact localStorage summary
 * (history/summary.js) the pre-paint re-rank reads; kept out of this module so it
 * stays testable with a plain in-memory store and no localStorage. */
export function recordOpened(store, id, attributes, now, onWrite) {
  return record(store, sessionSeen.opened, id, attributes, now, onWrite);
}

/** The card was at least half visible for about 1 second (IntersectionObserver,
 * history/observe.js). Smaller, incremental penalty weight (R17). */
export function recordShown(store, id, attributes, now, onWrite) {
  return record(store, sessionSeen.shown, id, attributes, now, onWrite);
}
