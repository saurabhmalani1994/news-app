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
    article_id: "s1",
  });
});

test("buildSaveSnapshot prefers source_name over a bare source id", () => {
  const record = buildSaveSnapshot("s1", { ...ATTRS, source: "straitstimes", source_name: "The Straits Times" }, () => "t");
  assert.equal(record.source, "The Straits Times");
});

test("buildSaveSnapshot keeps the lead article id for a clustered story, not the cluster id", () => {
  // A clustered story's own id (sid) is the cluster id; the reader only ever opens the
  // cluster's lead article (app/build.py body_id), so S26 has to remember that id, not
  // the story id, or a saved cluster's reader link and offline pin would target nothing.
  const record = buildSaveSnapshot("cluster-7", { ...ATTRS, article_id: "a42" }, () => "t");
  assert.equal(record.article_id, "a42");
  assert.equal(record.id, "cluster-7");
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
