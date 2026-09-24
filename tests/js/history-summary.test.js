// S15 proof: the compact localStorage summary the pre-paint re-rank reads. noteSeen
// writes through (record.js's onWrite calls it on every new IndexedDB write); pruning
// mirrors what history/prune.js already removed from IndexedDB; summaryToHistory is
// the shape history/penalty.js's seenPenaltyTerm expects.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readSummary, noteSeen, pruneSummary, summaryToHistory, isEmptySummary, SUMMARY_KEY } from "../../app/static/js/history/summary.js";

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

test("readSummary on an empty store is both-empty, not a throw", () => {
  assert.deepEqual(readSummary(memoryStorage()), { opened: {}, shown: {} });
});

test("noteSeen writes through and is readable back", () => {
  const storage = memoryStorage();
  noteSeen(storage, "opened", "c1", "2026-09-24T10:00:00Z");
  noteSeen(storage, "shown", "c2", "2026-09-24T11:00:00Z");
  assert.deepEqual(readSummary(storage), { opened: { c1: "2026-09-24T10:00:00Z" }, shown: { c2: "2026-09-24T11:00:00Z" } });
});

test("noteSeen on the same id overwrites the time, does not duplicate", () => {
  const storage = memoryStorage();
  noteSeen(storage, "opened", "c1", "2026-09-24T10:00:00Z");
  noteSeen(storage, "opened", "c1", "2026-09-24T12:00:00Z");
  assert.deepEqual(readSummary(storage).opened, { c1: "2026-09-24T12:00:00Z" });
});

test("a corrupt SUMMARY_KEY value reads back as empty, never throws", () => {
  const storage = memoryStorage();
  storage.setItem(SUMMARY_KEY, "{not json");
  assert.deepEqual(readSummary(storage), { opened: {}, shown: {} });
});

test("pruneSummary drops exactly the ids the IndexedDB-side prune removed", () => {
  const storage = memoryStorage();
  noteSeen(storage, "opened", "keep", "t");
  noteSeen(storage, "opened", "gone", "t");
  noteSeen(storage, "shown", "gone2", "t");
  pruneSummary(storage, { opened: ["gone"], shown: ["gone2"] });
  assert.deepEqual(readSummary(storage), { opened: { keep: "t" }, shown: {} });
});

test("summaryToHistory builds the {opened, shown} Map shape penalty.js reads", () => {
  const history = summaryToHistory({ opened: { c1: "t1" }, shown: { c2: "t2" } });
  assert.deepEqual(history.opened.get("c1"), { time: "t1" });
  assert.deepEqual(history.shown.get("c2"), { time: "t2" });
  assert.equal(history.opened.get("missing"), undefined);
});

test("isEmptySummary is true for null, both-empty and false once anything is noted", () => {
  assert.equal(isEmptySummary(null), true);
  assert.equal(isEmptySummary({ opened: {}, shown: {} }), true);
  assert.equal(isEmptySummary({ opened: { c1: "t" }, shown: {} }), false);
});
