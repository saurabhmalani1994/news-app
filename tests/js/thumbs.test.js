import { test } from "node:test";
import assert from "node:assert/strict";

import { buildThumbRecord, toggleThumb, undoThumb } from "../../app/static/js/actions/thumbs.js";

function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(id) { return data.has(id) ? data.get(id) : null; },
    async put(record) { data.set(record.id, record); },
    async delete(id) { data.delete(id); },
  };
}

const ATTRS = { topics: ["singapore", "world"], source: "straitstimes", lean: "center", cluster_size: 3, tab: "today", rank: 4 };

test("buildThumbRecord carries the story's own attributes and a time, nothing else", () => {
  const record = buildThumbRecord("s1", "up", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.deepEqual(record, {
    id: "s1", direction: "up", topics: ["singapore", "world"], source: "straitstimes",
    lean: "center", cluster_size: 3, tab: "today", rank: 4, time: "2026-09-24T00:00:00Z",
  });
});

test("R19: the thumb record shape never includes a weight, score or profile field", () => {
  const record = buildThumbRecord("s1", "down", ATTRS, () => "2026-09-24T00:00:00Z");
  for (const key of Object.keys(record)) {
    assert.ok(!/weight|score|affinity|profile/i.test(key), `unexpected field ${key}`);
  }
});

test("R19: toggling a thumb never calls anything that could write a profile (no such dependency exists to call)", async () => {
  // thumbs.js imports nothing from profile/store.js or ranker.js; toggling only ever
  // touches the storage adapter it is given.
  const store = memoryStore();
  let calls = 0;
  const spyingStore = {
    async get(id) { calls++; return store.get(id); },
    async put(r) { calls++; return store.put(r); },
    async delete(id) { calls++; return store.delete(id); },
  };
  await toggleThumb(spyingStore, "s1", "up", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.equal(calls, 2); // one get, one put; nothing else was touched
});

test("toggle: tapping the same direction twice clears it (the toggle is its own undo)", async () => {
  const store = memoryStore();
  const first = await toggleThumb(store, "s1", "up", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.equal(first.action, "set");
  assert.equal(first.record.direction, "up");
  const second = await toggleThumb(store, "s1", "up", ATTRS, () => "2026-09-24T00:00:01Z");
  assert.equal(second.action, "cleared");
  assert.equal(await store.get("s1"), null);
});

test("toggle: the other direction replaces the existing thumb", async () => {
  const store = memoryStore();
  await toggleThumb(store, "s1", "up", ATTRS, () => "2026-09-24T00:00:00Z");
  const result = await toggleThumb(store, "s1", "down", ATTRS, () => "2026-09-24T00:00:01Z");
  assert.equal(result.action, "set");
  assert.equal(result.record.direction, "down");
  assert.equal(result.previous.direction, "up");
});

test("undoThumb restores what was there before, or clears a fresh one", async () => {
  const store = memoryStore();
  const set = await toggleThumb(store, "s1", "up", ATTRS, () => "2026-09-24T00:00:00Z");
  await undoThumb(store, "s1", set.previous); // there was nothing before
  assert.equal(await store.get("s1"), null);

  await toggleThumb(store, "s1", "up", ATTRS, () => "2026-09-24T00:00:01Z");
  const replaced = await toggleThumb(store, "s1", "down", ATTRS, () => "2026-09-24T00:00:02Z");
  await undoThumb(store, "s1", replaced.previous);
  assert.equal((await store.get("s1")).direction, "up");
});
