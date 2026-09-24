// S24: IndexedDB for story actions, browser only: one store for Save snapshots (S26
// reads it), one for thumbs records (S29's weekly review reads them). Same tiny
// promise wrapper as reader/cache.js (S25). Unlike that cache, nothing here is pruned:
// a save or a thumb is the owner's own deliberate record, not an incidental cache
// entry, so it lives until the owner removes it (a toggle) or a later slice (S26, S34
// history) retires it.
const DB_NAME = "almanac-actions";
const VERSION = 1;
const STORES = ["saves", "thumbs"];

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
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("actions store blocked"));
    }).catch((error) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

function adapter(name) {
  return {
    async get(id) {
      const database = await db();
      return (await request(database.transaction(name).objectStore(name).get(id))) || null;
    },
    async put(record) {
      const database = await db();
      const tx = database.transaction(name, "readwrite");
      tx.objectStore(name).put(record);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async delete(id) {
      const database = await db();
      const tx = database.transaction(name, "readwrite");
      tx.objectStore(name).delete(id);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    /** Every record, for S26 (saves) and S29 (thumbs); not used by this slice. */
    async list() {
      const database = await db();
      return request(database.transaction(name).objectStore(name).getAll());
    },
  };
}

export const savesStore = adapter("saves");
export const thumbsStore = adapter("thumbs");
