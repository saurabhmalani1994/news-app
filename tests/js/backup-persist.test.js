// S35 (R24): storage.persist() runs once and never nags.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage } from "../../app/static/js/profile/store.js";
import { ensurePersisted, readPersistRecord, persistLabel, PERSIST_KEY } from "../../app/static/js/backup/persist.js";

test("unsupported browser: recorded once, no request ever made", async () => {
  const storage = new MemoryStorage();
  const requestPersist = () => { throw new Error("must not be called"); };
  const record = await ensurePersisted({ storage, supported: false, requestPersist, now: () => "2026-09-26T00:00:00Z" });
  assert.equal(record.outcome, "unsupported");
  assert.equal(persistLabel(record), "Storage: may be cleared by the browser");
});

test("already persisted: granted without asking again", async () => {
  const storage = new MemoryStorage();
  let requested = false;
  const record = await ensurePersisted({
    storage, supported: true, persisted: () => true,
    requestPersist: () => { requested = true; return true; },
    now: () => "2026-09-26T00:00:00Z",
  });
  assert.equal(record.outcome, "granted");
  assert.equal(requested, false, "already persisted, so persist() itself is never called");
});

test("not yet persisted: asks once, records the outcome", async () => {
  const storage = new MemoryStorage();
  let asked = 0;
  const record = await ensurePersisted({
    storage, supported: true, persisted: () => false,
    requestPersist: () => { asked++; return true; },
    now: () => "2026-09-26T00:00:00Z",
  });
  assert.equal(record.outcome, "granted");
  assert.equal(asked, 1);
  assert.equal(persistLabel(record), "Storage: kept");
});

test("browser denies: recorded, and never nags on a later call", async () => {
  const storage = new MemoryStorage();
  let asked = 0;
  const opts = {
    storage, supported: true, persisted: () => false,
    requestPersist: () => { asked++; return false; },
    now: () => "2026-09-26T00:00:00Z",
  };
  const first = await ensurePersisted(opts);
  assert.equal(first.outcome, "denied");
  assert.equal(persistLabel(first), "Storage: may be cleared by the browser");
  const second = await ensurePersisted(opts);
  assert.equal(asked, 1, "a stored record short-circuits every later check: never nag");
  assert.deepEqual(second, first);
});

test("a thrown persist() call still records a denied outcome, not an unhandled rejection", async () => {
  const storage = new MemoryStorage();
  const record = await ensurePersisted({
    storage, supported: true, persisted: () => false,
    requestPersist: () => { throw new Error("blocked"); },
    now: () => "2026-09-26T00:00:00Z",
  });
  assert.equal(record.outcome, "denied");
});

test("a corrupt stored record is treated as none, so the check runs again", async () => {
  const storage = new MemoryStorage();
  storage.setItem(PERSIST_KEY, "not json");
  assert.equal(readPersistRecord(storage), null);
  const record = await ensurePersisted({ storage, supported: false, now: () => "2026-09-26T00:00:00Z" });
  assert.equal(record.outcome, "unsupported");
});
