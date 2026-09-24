// S25: the reader's body cache in IndexedDB, so a story read once reads again offline.
// One store, keyed by article id, holding the checked record (reader/core.js checkBody)
// plus when it was cached. Bounded: past KEEP entries the oldest go. S26 (Saved) will
// keep saved stories' bodies beyond this bound. The service worker (S18) is not used
// for bodies; this store is the reader's only cache.

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

async function prune(database) {
  const tx = database.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let extra = (await request(store.count())) - KEEP;
  if (extra <= 0) return;
  await new Promise((resolve, reject) => {
    const cursor = store.index("cached_at").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at || extra <= 0) { resolve(); return; }
      at.delete();
      extra -= 1;
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export const bodyCache = {
  async get(id) {
    const database = await db();
    return (await request(database.transaction(STORE).objectStore(STORE).get(id))) || null;
  },
  async put(id, body) {
    const database = await db();
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...body, article_id: id, cached_at: Date.now() });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await prune(database).catch(() => {});
  },
};
