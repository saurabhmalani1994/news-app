import { test } from "node:test";
import assert from "node:assert/strict";

import { sortedSaves } from "../../app/static/js/saved-list.js";
import { toggleSave, undoSave } from "../../app/static/js/actions/saves.js";

function memoryStore() {
  const data = new Map();
  return {
    async get(id) { return data.has(id) ? data.get(id) : null; },
    async put(record) { data.set(record.id, record); },
    async delete(id) { data.delete(id); },
    async list() { return [...data.values()]; },
  };
}

const A = { title: "A", url: "https://example.com/a", has_body: false };
const B = { title: "B", url: "https://example.com/b", has_body: true, article_id: "b" };

test("save then list order: newest saved first", async () => {
  const store = memoryStore();
  await toggleSave(store, "a", A, () => "2026-09-24T00:00:00Z");
  await toggleSave(store, "b", B, () => "2026-09-24T00:05:00Z");
  const order = sortedSaves(await store.list()).map((r) => r.id);
  assert.deepEqual(order, ["b", "a"]);
});

test("a third save slots in ahead of both older ones", async () => {
  const store = memoryStore();
  await toggleSave(store, "a", A, () => "2026-09-24T00:00:00Z");
  await toggleSave(store, "b", B, () => "2026-09-24T00:05:00Z");
  await toggleSave(store, "c", { title: "C", url: "https://example.com/c", has_body: false }, () => "2026-09-24T00:10:00Z");
  const order = sortedSaves(await store.list()).map((r) => r.id);
  assert.deepEqual(order, ["c", "b", "a"]);
});

test("unsave with Undo: the list drops the row, then Undo restores it in its original spot", async () => {
  const store = memoryStore();
  await toggleSave(store, "a", A, () => "2026-09-24T00:00:00Z");
  await toggleSave(store, "b", B, () => "2026-09-24T00:05:00Z");
  assert.deepEqual(sortedSaves(await store.list()).map((r) => r.id), ["b", "a"]);

  const removed = await toggleSave(store, "a", A, () => "2026-09-24T00:06:00Z"); // toggling an existing save unsaves it
  assert.equal(removed.action, "removed");
  assert.deepEqual(sortedSaves(await store.list()).map((r) => r.id), ["b"]);

  await undoSave(store, "a", removed.action, removed.previous);
  assert.deepEqual(sortedSaves(await store.list()).map((r) => r.id), ["b", "a"]); // "a" back in its original time slot
});
