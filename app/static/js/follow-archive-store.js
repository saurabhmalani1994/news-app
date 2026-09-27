// S30: the per-follow archive's IndexedDB store (follow-archive.js). One object store,
// one row per follow ({follow, items}), the same tiny promise wrapper history/store.js
// (S15), actions/store.js (S24) and reader/cache.js (S25) each already carry: small
// enough that sharing a base module would cost more to read than it saves.
export const FOLLOW_ARCHIVE_DB = "almanac-follow-archive";
const VERSION = 1;
const STORE = "follows";

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
      const req = indexedDB.open(FOLLOW_ARCHIVE_DB, VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "follow" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("follow archive store blocked"));
    }).catch((error) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

/** `{follow, items}` for one follow key, or null when nothing is recorded yet. */
async function get(follow) {
  const database = await db();
  return (await request(database.transaction(STORE).objectStore(STORE).get(follow))) || null;
}

/** Replaces one follow's whole item list (follow-archive.js already merges and prunes
 * before calling this, so this is a plain overwrite, not an append). */
async function put(follow, items) {
  const database = await db();
  const tx = database.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ follow, items });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const followArchiveStore = { get, put };
