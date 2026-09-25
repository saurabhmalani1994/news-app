// S15 proof: the history store's write side. buildHistorySnapshot is the light card
// (mirrors actions/saves.js's buildSaveSnapshot); recordOpened and recordShown write at
// most once per story per session, the in-memory guard record.js keeps.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHistorySnapshot, recordOpened, recordShown, resetHistorySession } from "../../app/static/js/history/record.js";

function memoryStore() {
  const data = new Map();
  return {
    calls: { put: 0 },
    async get(id) { return data.has(id) ? data.get(id) : null; },
    async put(record) { this.calls.put += 1; data.set(record.id, record); },
    async delete(id) { data.delete(id); },
    async list() { return [...data.values()]; },
  };
}

const ATTRS = {
  title: "Singapore raises the flood barrier budget",
  source: "straitstimes",
  source_name: "The Straits Times",
  url: "https://example.com/a",
  image: "https://example.com/a.jpg",
  topics: ["singapore", "world"],
};

test("buildHistorySnapshot is a light card, id and cluster_id agree", () => {
  const record = buildHistorySnapshot("c1", ATTRS, () => "2026-09-24T00:00:00Z");
  assert.deepEqual(record, {
    id: "c1",
    cluster_id: "c1",
    title: "Singapore raises the flood barrier budget",
    source: "The Straits Times",
    source_id: "straitstimes",
    url: "https://example.com/a",
    image: "https://example.com/a.jpg",
    topics: ["singapore", "world"],
    article_id: "c1", // ATTRS names no article_id: falls back to the story id, correct for a lone article
    time: "2026-09-24T00:00:00Z",
  });
});

test("buildHistorySnapshot falls back to a bare source id and empty fields", () => {
  const record = buildHistorySnapshot("c2", {}, () => "t");
  assert.equal(record.source, "");
  assert.equal(record.source_id, "");
  assert.equal(record.article_id, "c2");
  assert.deepEqual(record.topics, []);
  assert.equal(record.image, null);
});

// S34: a clustered story's card names an article distinct from the story (cluster) id;
// the snapshot keeps both, so the history screen can still reopen the right article
// once the story itself has left the pool.
test("buildHistorySnapshot keeps a clustered story's own article id and source id, distinct from the story id", () => {
  const record = buildHistorySnapshot("c1", { ...ATTRS, article_id: "a827ba1a90cf4138" }, () => "t");
  assert.equal(record.id, "c1");
  assert.equal(record.article_id, "a827ba1a90cf4138");
  assert.equal(record.source_id, "straitstimes");
});

test("recordOpened writes once per story per session", async () => {
  resetHistorySession();
  const store = memoryStore();
  const first = await recordOpened(store, "c1", ATTRS, () => "2026-09-24T00:00:00Z");
  const second = await recordOpened(store, "c1", ATTRS, () => "2026-09-24T01:00:00Z");
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(store.calls.put, 1);
  assert.equal((await store.get("c1")).time, "2026-09-24T00:00:00Z", "the first write stands, the second is a no-op");
});

test("recordShown writes once per story per session, independent of recordOpened", async () => {
  resetHistorySession();
  const openedStore = memoryStore();
  const shownStore = memoryStore();
  await recordOpened(openedStore, "c1", ATTRS, () => "t1");
  await recordShown(shownStore, "c1", ATTRS, () => "t2");
  await recordShown(shownStore, "c1", ATTRS, () => "t3");
  await recordShown(shownStore, "c2", ATTRS, () => "t4");
  assert.equal(openedStore.calls.put, 1);
  assert.equal(shownStore.calls.put, 2, "c1 once, c2 once");
});

test("a fresh session (resetHistorySession) can record the same story again", async () => {
  resetHistorySession();
  const store = memoryStore();
  await recordOpened(store, "c1", ATTRS, () => "t1");
  resetHistorySession();
  const again = await recordOpened(store, "c1", ATTRS, () => "t2");
  assert.equal(again.recorded, true);
  assert.equal(store.calls.put, 2);
});

test("recordOpened calls onWrite with the snapshot it wrote, once", async () => {
  resetHistorySession();
  const store = memoryStore();
  const writes = [];
  await recordOpened(store, "c9", ATTRS, () => "t1", (snapshot) => writes.push(snapshot));
  await recordOpened(store, "c9", ATTRS, () => "t2", (snapshot) => writes.push(snapshot));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, "c9");
});
