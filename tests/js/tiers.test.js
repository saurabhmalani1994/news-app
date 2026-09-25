// H4 item 3: the device re-rank's mute-aware "N sources" count (js/tiers.js
// visibleSourceCount), mirroring app/frontpage.py visible_source_count so the build and
// the device agree on what the row's own count means once a profile mutes an outlet.
import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleSourceCount } from "../../app/static/js/tiers.js";

// Same shape as tests/test_frontpage.py's a000 fixture: 4 outlets once syndication
// folds a003/a004 into one group (s00, s01, s02, group(s03,s04)).
const ARTICLES = [
  { id: "a000", source_id: "s00" },
  { id: "a001", source_id: "s01" },
  { id: "a002", source_id: "s02" },
  { id: "a003", source_id: "s03" },
  { id: "a004", source_id: "s04" },
  { id: "a013", source_id: "s01" },
];
const articleById = new Map(ARTICLES.map((a) => [a.id, a]));
const CLUSTER = {
  id: "a000",
  article_ids: ARTICLES.map((a) => a.id),
  near_duplicates: [["a003", "a004"]],
};

test("counts outlets, folding a syndicated group to one, muted ones dropped", () => {
  assert.equal(visibleSourceCount(CLUSTER, articleById, []), 4);
  assert.equal(visibleSourceCount(CLUSTER, articleById, ["s00"]), 3);
  assert.equal(visibleSourceCount(CLUSTER, articleById, ["s01"]), 3);
});

test("a syndicated group survives losing one of its two members", () => {
  assert.equal(visibleSourceCount(CLUSTER, articleById, ["s03"]), 4);
  assert.equal(visibleSourceCount(CLUSTER, articleById, ["s03", "s04"]), 3);
});

test("no cluster (a single-article story) reads as one, the only shape build.py gives it", () => {
  assert.equal(visibleSourceCount(null, articleById, []), 1);
});

test("an article the pool no longer carries is skipped rather than counted", () => {
  const withGhost = { ...CLUSTER, article_ids: [...CLUSTER.article_ids, "ghost"] };
  assert.equal(visibleSourceCount(withGhost, articleById, []), 4);
});
