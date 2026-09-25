// S34 proof: "Clear history" empties both stores and reports exactly what it removed, in
// history/prune.js's own {opened, shown} id-list shape (so it can feed straight into
// history/summary.js's pruneSummary).
import { test } from "node:test";
import assert from "node:assert/strict";

import { clearHistory } from "../../app/static/js/history/clear.js";

function memoryStore(records) {
  const data = new Map(records.map((r) => [r.id, r]));
  return {
    async list() { return [...data.values()]; },
    async delete(id) { data.delete(id); },
    size() { return data.size; },
  };
}

test("clearHistory empties both stores", async () => {
  const openedStore = memoryStore([{ id: "o1" }, { id: "o2" }]);
  const shownStore = memoryStore([{ id: "s1" }]);
  await clearHistory({ openedStore, shownStore });
  assert.equal(openedStore.size(), 0);
  assert.equal(shownStore.size(), 0);
});

test("clearHistory reports every id it removed, from each store", async () => {
  const openedStore = memoryStore([{ id: "o1" }, { id: "o2" }]);
  const shownStore = memoryStore([{ id: "s1" }]);
  const result = await clearHistory({ openedStore, shownStore });
  assert.deepEqual(result.opened.sort(), ["o1", "o2"]);
  assert.deepEqual(result.shown, ["s1"]);
});

test("clearHistory on an already-empty history is a no-op, not an error", async () => {
  const openedStore = memoryStore([]);
  const shownStore = memoryStore([]);
  const result = await clearHistory({ openedStore, shownStore });
  assert.deepEqual(result, { opened: [], shown: [] });
});
