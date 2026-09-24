// S15: IndexedDB history, browser only, device only (R23: history never leaves the
// phone). Two stores, `opened` and `shown` (DESIGN-v1.1 section 7, R17), each holding
// one card snapshot per story: `record.js` says what a snapshot carries and how it is
// written; `prune.js` says how long each store keeps its rows. Same tiny promise
// wrapper as actions/store.js (S24) and reader/cache.js (S25).
export const DB_NAME = "almanac-history";
const VERSION = 1;
export const STORES = ["opened", "shown"];

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
      req.onblocked = () => reject(new Error("history store blocked"));
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
    /** Every record, for pruning (prune.js) and the S34 history screen. */
    async list() {
      const database = await db();
      return request(database.transaction(name).objectStore(name).getAll());
    },
  };
}

export const openedStore = adapter("opened");
export const shownStore = adapter("shown");
