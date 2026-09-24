import { test } from "node:test";
import assert from "node:assert/strict";

import { evictionIds, KEEP } from "../../app/static/js/reader/cache.js";

function records(count, { pinnedIds = new Set() } = {}) {
  // Oldest first: article id "a0" is the oldest, cached_at ascending.
  return Array.from({ length: count }, (_, i) => ({
    article_id: `a${i}`,
    cached_at: i,
    pinned: pinnedIds.has(`a${i}`),
  }));
}

test("under the cap, nothing is evicted", () => {
  assert.deepEqual(evictionIds(records(KEEP)), []);
  assert.deepEqual(evictionIds(records(50), { keep: 200 }), []);
});

test("over the cap, the oldest unpinned rows go until the unpinned count fits", () => {
  const rows = records(250);
  const evicted = evictionIds(rows);
  assert.equal(evicted.length, 50);
  // Oldest ids first (a0..a49), never a newer one skipped over an older survivor.
  assert.deepEqual(evicted, Array.from({ length: 50 }, (_, i) => `a${i}`));
});

test("a pinned body survives a 250-entry eviction, even the oldest one", () => {
  // The five oldest rows (a0..a4) are pinned, saved stories among 245 unpinned ones.
  const pinnedIds = new Set(["a0", "a1", "a2", "a3", "a4"]);
  const rows = records(250, { pinnedIds });
  const evicted = evictionIds(rows);
  for (const id of pinnedIds) assert.ok(!evicted.includes(id), `${id} is pinned and must survive`);
  // 245 unpinned rows over a 200 cap: the 45 oldest unpinned ones go.
  assert.equal(evicted.length, 45);
  assert.ok(evicted.every((id) => !pinnedIds.has(id)));
});

test("every row pinned: nothing is ever evicted, no matter how far over the cap", () => {
  const rows = records(300, { pinnedIds: new Set(records(300).map((r) => r.article_id)) });
  assert.deepEqual(evictionIds(rows), []);
});
