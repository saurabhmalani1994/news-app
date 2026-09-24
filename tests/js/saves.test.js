import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSaveSnapshot, toggleSave, undoSave } from "../../app/static/js/actions/saves.js";

function memoryStore() {
  const data = new Map();
  return {
    async get(id) { return data.has(id) ? data.get(id) : null; },
    async put(record) { data.set(record.id, record); },
    async delete(id) { data.delete(id); },
  };
}

const ATTRS = {
  title: "Singapore raises the flood barrier budget",
  url: "https://example.com/a",
  image: "https://example.com/a.jpg",
  has_body: true,
};

test("buildSaveSnapshot is the light card, not the full body", () => {
  const record = buildSaveSnapshot("s1", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.deepEqual(record, {
    id: "s1",
    title: "Singapore raises the flood barrier budget",
    source: "",
    url: "https://example.com/a",
    image: "https://example.com/a.jpg",
    time: "2026-09-24T00:00:00Z",
    has_body: true,
  });
});

test("buildSaveSnapshot prefers source_name over a bare source id", () => {
  const record = buildSaveSnapshot("s1", { ...ATTRS, source: "straitstimes", source_name: "The Straits Times" }, () => "t");
  assert.equal(record.source, "The Straits Times");
});

test("toggle: saving twice removes it", async () => {
  const store = memoryStore();
  const added = await toggleSave(store, "s1", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.equal(added.action, "added");
  assert.equal((await store.get("s1")).id, "s1");
  const removed = await toggleSave(store, "s1", ATTRS, () => "2026-09-24T00:00:01Z");
  assert.equal(removed.action, "removed");
  assert.equal(await store.get("s1"), null);
});

test("undoSave reverses either half of the toggle", async () => {
  const store = memoryStore();
  const added = await toggleSave(store, "s1", ATTRS, () => "2026-09-24T00:00:00Z");
  await undoSave(store, "s1", added.action, added.previous);
  assert.equal(await store.get("s1"), null);

  await toggleSave(store, "s1", ATTRS, () => "2026-09-24T00:00:01Z");
  const removed = await toggleSave(store, "s1", ATTRS, () => "2026-09-24T00:00:02Z");
  await undoSave(store, "s1", removed.action, removed.previous);
  assert.equal((await store.get("s1")).id, "s1");
});
