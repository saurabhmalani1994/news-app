import { test } from "node:test";
import assert from "node:assert/strict";

import { syncSavePin, syncUndoPin } from "../../app/static/js/actions/save-pin.js";

function fakeCache() {
  const pinned = new Set();
  const fetched = [];
  return {
    pinned,
    fetched,
    async pin(id) { pinned.add(id); },
    async unpin(id) { pinned.delete(id); },
  };
}

function fakeFetchBody(fetched) {
  return async (id) => { fetched.push(id); };
}

const HAS_BODY = { id: "s1", article_id: "a1", has_body: true, title: "t" };
const NO_BODY = { id: "s2", article_id: "a2", has_body: false, title: "t" };

test("saving a has_body story fetches and pins its body", async () => {
  const cache = fakeCache();
  await syncSavePin({ action: "added", record: HAS_BODY, previous: null }, { cache, fetchBody: fakeFetchBody(cache.fetched) });
  assert.deepEqual(cache.fetched, ["a1"]);
  assert.ok(cache.pinned.has("a1"));
});

test("saving a story without a body never fetches or pins anything", async () => {
  const cache = fakeCache();
  await syncSavePin({ action: "added", record: NO_BODY, previous: null }, { cache, fetchBody: fakeFetchBody(cache.fetched) });
  assert.deepEqual(cache.fetched, []);
  assert.equal(cache.pinned.size, 0);
});

test("unsaving a has_body story unpins it", async () => {
  const cache = fakeCache();
  cache.pinned.add("a1");
  await syncSavePin({ action: "removed", record: null, previous: HAS_BODY }, { cache, fetchBody: fakeFetchBody(cache.fetched) });
  assert.ok(!cache.pinned.has("a1"));
});

test("undoing a save (action was added) unpins again", async () => {
  const cache = fakeCache();
  cache.pinned.add("a1");
  await syncUndoPin("added", HAS_BODY, null, { cache, fetchBody: fakeFetchBody(cache.fetched) });
  assert.ok(!cache.pinned.has("a1"));
});

test("undoing an unsave (action was removed) re-pins the restored record", async () => {
  const cache = fakeCache();
  await syncUndoPin("removed", null, HAS_BODY, { cache, fetchBody: fakeFetchBody(cache.fetched) });
  assert.ok(cache.pinned.has("a1"));
  assert.deepEqual(cache.fetched, ["a1"]);
});

test("a failing fetch or a full cache never throws: the save itself must still succeed", async () => {
  const cache = {
    async pin() { throw new Error("storage full"); },
    async unpin() { throw new Error("storage full"); },
  };
  const fetchBody = async () => { throw new Error("offline"); };
  await assert.doesNotReject(syncSavePin({ action: "added", record: HAS_BODY, previous: null }, { cache, fetchBody }));
  await assert.doesNotReject(syncSavePin({ action: "removed", record: null, previous: HAS_BODY }, { cache, fetchBody }));
});
