// S25: the reader's body cache in IndexedDB, so a story read once reads again offline.
// One store, keyed by article id, holding the checked record (reader/core.js checkBody)
// plus when it was cached. Bounded: past KEEP entries the oldest go. The service worker
// (S18) is not used for bodies; this store is the reader's only cache.
//
// S26: a saved story's body is pinned (record.pinned = true), the smallest change that
// keeps it out of eviction without a second body store: KEEP only ever bounds the
// unpinned rows (evictionIds below), so a pin adds to the cache's floor rather than
// competing inside it, and unsaving unpins rather than deleting (the body still reads
// fine offline until an ordinary eviction eventually reclaims it). `evictionIds` is
// pure (no indexedDB), so it is the part Node tests exercise directly; `prune` is just
// its IndexedDB-side caller.

const DB_NAME = "almanac-reader";
const STORE = "bodies";
const VERSION = 1;
export const KEEP = 200;

let opening = null;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "article_id" });
        store.createIndex("cached_at", "cached_at");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("reader cache blocked"));
    }).catch((error) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

/** Which article ids to evict, oldest first, so the unpinned rows fit within `keep`.
 * A pinned row (a saved story, S26) is never returned: pinning exempts a row from the
 * cap instead of competing for a place inside it, so saving never races an unrelated
 * read for the same 200 slots. Pure: `records` is [{article_id, cached_at, pinned}],
 * the shape prune() below reads out of the store; this is what tests/js exercises
 * directly, since Node has no indexedDB to drive prune() itself against. */
export function evictionIds(records, keep = KEEP) {
  const unpinned = records.filter((r) => !r.pinned).sort((a, b) => a.cached_at - b.cached_at);
  const extra = unpinned.length - keep;
  return extra > 0 ? unpinned.slice(0, extra).map((r) => r.article_id) : [];
}

async function prune(database) {
  const tx = database.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const records = [];
  await new Promise((resolve, reject) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) { resolve(); return; }
      records.push({ article_id: c.value.article_id, cached_at: c.value.cached_at, pinned: Boolean(c.value.pinned) });
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  for (const id of evictionIds(records)) store.delete(id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Sets `pinned` on an already-cached body; a no-op (returns false) when the article
 * has no cached body yet, since there is nothing here for a save to protect until the
 * body has actually been fetched once. */
async function setPinned(id, pinned) {
  const database = await db();
  const existing = await request(database.transaction(STORE).objectStore(STORE).get(id));
  if (!existing) return false;
  const tx = database.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ ...existing, pinned });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return true;
}

export const bodyCache = {
  async get(id) {
    const database = await db();
    return (await request(database.transaction(STORE).objectStore(STORE).get(id))) || null;
  },
  async put(id, body) {
    const database = await db();
    // A record already pinned (a saved story whose body is being refreshed) stays
    // pinned: put() is also the reader's own ordinary cache-fill, and that path must
    // never silently unsave a story's offline copy.
    const existing = await request(database.transaction(STORE).objectStore(STORE).get(id)).catch(() => null);
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...body, article_id: id, cached_at: Date.now(), pinned: Boolean(existing?.pinned) });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await prune(database).catch(() => {});
  },
  pin(id) { return setPinned(id, true); },
  unpin(id) { return setPinned(id, false); },
};
