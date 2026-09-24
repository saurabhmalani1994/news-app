// S15 proof: retention. Opened keeps a year, shown keeps 14 days (DESIGN-v1.1 section
// 7, R23); pruning deletes exactly the rows older than each store's own window and
// nothing else, and pruneHistory drops the matching entries from both stores' own
// windows in one pass.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneStore, pruneHistory, OPENED_RETENTION_MS, SHOWN_RETENTION_MS, DAY_MS } from "../../app/static/js/history/prune.js";

function memoryStore(records) {
  const data = new Map(records.map((r) => [r.id, r]));
  return {
    async list() { return [...data.values()]; },
    async delete(id) { data.delete(id); },
    async get(id) { return data.get(id) || null; },
    size() { return data.size; },
  };
}

const NOW = Date.parse("2026-09-24T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

test("pruneStore deletes only rows past the given retention window", async () => {
  const store = memoryStore([
    { id: "a", time: daysAgo(1) },
    { id: "b", time: daysAgo(13.9) },
    { id: "c", time: daysAgo(14.1) },
    { id: "d", time: daysAgo(30) },
  ]);
  const removed = await pruneStore(store, SHOWN_RETENTION_MS, NOW);
  assert.deepEqual(removed.sort(), ["c", "d"]);
  assert.deepEqual((await store.list()).map((r) => r.id).sort(), ["a", "b"]);
});

test("opened's window is a year, not 14 days", async () => {
  const store = memoryStore([
    { id: "recent", time: daysAgo(200) },
    { id: "old", time: daysAgo(366) },
  ]);
  const removed = await pruneStore(store, OPENED_RETENTION_MS, NOW);
  assert.deepEqual(removed, ["old"]);
});

test("a row at exactly the boundary is kept (older-than, not older-than-or-equal)", async () => {
  const store = memoryStore([{ id: "edge", time: new Date(NOW - SHOWN_RETENTION_MS).toISOString() }]);
  const removed = await pruneStore(store, SHOWN_RETENTION_MS, NOW);
  assert.deepEqual(removed, []);
});

test("pruneHistory applies each store's own retention window", async () => {
  const openedStore = memoryStore([{ id: "o1", time: daysAgo(10) }, { id: "o2", time: daysAgo(400) }]);
  const shownStore = memoryStore([{ id: "s1", time: daysAgo(10) }, { id: "s2", time: daysAgo(20) }]);
  const result = await pruneHistory({ openedStore, shownStore }, NOW);
  assert.deepEqual(result.opened, ["o2"]);
  assert.deepEqual(result.shown, ["s2"]);
  assert.equal(openedStore.size(), 1);
  assert.equal(shownStore.size(), 1);
});
