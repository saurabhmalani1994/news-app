import { test } from "node:test";
import assert from "node:assert/strict";

import { storyAttributes, storyIdForArticle } from "../../app/static/js/actions/context.js";

const INPUT = {
  pool: {
    articles: [
      { id: "a1", source_id: "straitstimes", topics: ["singapore", "world"] },
      { id: "a2", source_id: "cna", topics: ["singapore"] },
      { id: "a3", source_id: "bbc", topics: ["world"] },
    ],
    clusters: [{ id: "c1", article_ids: ["a1", "a2"], lead: "a1", independent_sources: 2 }],
  },
  names: { straitstimes: "The Straits Times", cna: "CNA", bbc: "BBC" },
  leans: { straitstimes: "center", cna: "center", bbc: "center-left" },
};

test("storyAttributes reads a clustered story off its lead article", () => {
  const attrs = storyAttributes(INPUT, "c1");
  assert.equal(attrs.source, "straitstimes");
  assert.equal(attrs.source_name, "The Straits Times");
  assert.equal(attrs.lean, "center");
  assert.deepEqual(attrs.topics, ["singapore", "world"]);
  assert.equal(attrs.cluster_size, 2);
});

test("storyAttributes falls back to the article itself when there is no cluster", () => {
  const attrs = storyAttributes(INPUT, "a3");
  assert.equal(attrs.source, "bbc");
  assert.equal(attrs.lean, "center-left");
  assert.equal(attrs.cluster_size, 1);
});

test("storyIdForArticle finds the cluster a lead article fronts, else the article's own id", () => {
  assert.equal(storyIdForArticle(INPUT, "a1"), "c1");
  assert.equal(storyIdForArticle(INPUT, "a3"), "a3");
});
