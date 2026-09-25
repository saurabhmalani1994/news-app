// S34 proof: the reopen decision (reader, still-live pool, or link out) and the fallback
// for a record written before S34 added article_id.
import { test } from "node:test";
import assert from "node:assert/strict";

import { articleIdFor, reopenTarget } from "../../app/static/js/history/reopen.js";

const RECORD = { id: "c1", article_id: "a827ba1a90cf4138", url: "https://example.com/a" };
const OLD_RECORD = { id: "c1", title: "An old read", source: "NPR", url: "https://example.com/old" }; // pre-S34: no article_id, no source_id

test("articleIdFor prefers the stored article id", () => {
  assert.equal(articleIdFor(RECORD), "a827ba1a90cf4138");
});

test("articleIdFor falls back to the story id for a record written before S34", () => {
  assert.equal(articleIdFor(OLD_RECORD), "c1");
});

test("articleIdFor never throws on an empty or missing record", () => {
  assert.equal(articleIdFor({}), null);
  assert.equal(articleIdFor(null), null);
});

test("a cached body opens in the reader", () => {
  assert.deepEqual(reopenTarget(RECORD, { cached: true, poolHasBody: false }), { mode: "reader", id: "a827ba1a90cf4138" });
});

test("no cache but still in the live pool with a body also opens in the reader", () => {
  assert.deepEqual(reopenTarget(RECORD, { cached: false, poolHasBody: true }), { mode: "reader", id: "a827ba1a90cf4138" });
});

test("neither cached nor in the live pool: link out to the record's own url", () => {
  assert.deepEqual(reopenTarget(RECORD, { cached: false, poolHasBody: false }), { mode: "link", url: "https://example.com/a" });
});

test("a pre-S34 record with neither cached nor a live pool hit still links out, using its own url", () => {
  assert.deepEqual(reopenTarget(OLD_RECORD, { cached: false, poolHasBody: false }), { mode: "link", url: "https://example.com/old" });
});

test("a pre-S34 record that is still cached (under its fallback article id) still opens in the reader", () => {
  assert.deepEqual(reopenTarget(OLD_RECORD, { cached: true, poolHasBody: false }), { mode: "reader", id: "c1" });
});

test("neither a cache, a live pool hit, nor a url: nothing to reopen", () => {
  assert.deepEqual(reopenTarget({ id: "c9" }, {}), { mode: "none" });
});
