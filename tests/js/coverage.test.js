import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCoverage, coverageContext, LEAN_ORDER, LEAN_LABELS } from "../../app/static/js/coverage.js";

// A six-outlet cluster: one near-duplicate pair (two outlets carrying the same wire
// copy), a right-lean outlet with two of its own separate pieces, and singles across
// center and non-us. Chosen so every rule in the brief has something to bite on: a
// near-dup collapse, a same-outlet-multiple-rows case, and a lean spread of 4.
const CLUSTER = {
  id: "c1",
  method: "cosine_entity",
  article_ids: ["a_wire1", "a_wire2", "a_right1", "a_right2", "a_center", "a_intl"],
  near_duplicates: [["a_wire1", "a_wire2"]],
  independent_sources: 4,
  lean_buckets: ["left", "center", "right", "non-us"],
};

const POOL_ARTICLES = [
  { id: "a_wire1", source_id: "npr", title: "Senate passes the bill", published_at: "2026-09-24T10:00:00Z" },
  { id: "a_wire2", source_id: "pbs_newshour", title: "Senate passes the bill", published_at: "2026-09-24T10:05:00Z" },
  { id: "a_right1", source_id: "fox_politics", title: "GOP claims a win on the bill", published_at: "2026-09-24T11:00:00Z" },
  { id: "a_right2", source_id: "fox_politics", title: "What the bill means for taxes", published_at: "2026-09-24T09:00:00Z" },
  { id: "a_center", source_id: "bbc_world", title: "US Senate passes spending bill", published_at: "2026-09-24T09:30:00Z" },
  { id: "a_intl", source_id: "kyodo_news", title: "US Senate approves budget bill", published_at: "2026-09-24T08:00:00Z" },
];

const CTX = coverageContext({
  pool: { articles: POOL_ARTICLES },
  names: { npr: "NPR", pbs_newshour: "PBS NewsHour", fox_politics: "Fox News Politics", bbc_world: "BBC World", kyodo_news: "Kyodo News" },
  leans: { npr: "center-left", pbs_newshour: "center-left", fox_politics: "right", bbc_world: "center", kyodo_news: "non-us" },
  ownership: { kyodo_news: "member-owned" },
  coverage: {
    a_wire1: { url: "https://npr.example/a", has_body: false },
    a_wire2: { url: "https://pbs.example/a", has_body: false },
    a_right1: { url: "https://fox.example/1", has_body: true },
    a_right2: { url: "https://fox.example/2", has_body: false },
    a_center: { url: "https://bbc.example/a", has_body: false },
    a_intl: { url: "https://kyodo.example/a", has_body: false },
  },
});

test("every article in the cluster appears exactly once, as a row or under also carried by", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const seen = [];
  for (const group of groups) {
    for (const row of group.rows) {
      seen.push(row.id);
      for (const also of row.also) seen.push(also.id);
    }
  }
  assert.deepEqual(seen.slice().sort(), [...CLUSTER.article_ids].sort());
  assert.equal(new Set(seen).size, seen.length, "no article appears twice");
});

test("a near-duplicate group collapses to one row, the lowest article id, with the rest listed as also carried by", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const leftGroup = groups.find((g) => g.bucket === "center-left");
  assert.equal(leftGroup.rows.length, 1);
  assert.equal(leftGroup.rows[0].id, "a_wire1");
  assert.deepEqual(leftGroup.rows[0].also.map((a) => a.id), ["a_wire2"]);
  assert.equal(leftGroup.rows[0].also[0].sourceName, "PBS NewsHour");
});

test("the same outlet's two separate pieces are two separate rows, not collapsed", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const right = groups.find((g) => g.bucket === "right");
  assert.equal(right.rows.length, 2);
  assert.deepEqual(right.rows.map((r) => r.id), ["a_right1", "a_right2"], "newest first within a group");
});

test("groups appear in the fixed taxonomy order, skipping empty buckets", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const order = groups.map((g) => g.bucket);
  assert.deepEqual(order, ["center-left", "center", "right", "non-us"]);
  const positions = order.map((bucket) => LEAN_ORDER.indexOf(bucket));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "fixed order is respected");
});

test("lean bucket names are plain words, not raw taxonomy keys", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const right = groups.find((g) => g.bucket === "right");
  assert.equal(right.label, "Right");
  assert.equal(LEAN_LABELS["non-us"], "International");
});

test("grouping and order are deterministic: rebuilding from the same input gives the same result", () => {
  const first = buildCoverage(CLUSTER, CTX);
  const second = buildCoverage(CLUSTER, CTX);
  assert.deepEqual(first, second);
});

test("the summary numbers match the cluster's own fields: outlets, independent_sources, lean_buckets", () => {
  const { summary } = buildCoverage(CLUSTER, CTX);
  // 5 distinct source_ids carried it (npr, pbs_newshour, fox_politics once, bbc_world,
  // kyodo_news); fox_politics has two articles but is still one outlet.
  assert.equal(summary.outlets, 5);
  assert.equal(summary.independent, CLUSTER.independent_sources);
  assert.equal(summary.leans, CLUSTER.lean_buckets.length);
  assert.equal(summary.text, "5 outlets, 4 independent, across 4 leans");
});

test("an ownership label reaches the row only when sources.json carries one", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const intl = groups.find((g) => g.bucket === "non-us").rows[0];
  assert.equal(intl.ownership, "member-owned");
  const right = groups.find((g) => g.bucket === "right").rows[0];
  assert.equal(right.ownership, "");
});

test("has_body and url come through per row for the reader/link-out choice", () => {
  const { groups } = buildCoverage(CLUSTER, CTX);
  const right = groups.find((g) => g.bucket === "right");
  const [claimsWin] = right.rows;
  assert.equal(claimsWin.id, "a_right1");
  assert.equal(claimsWin.hasBody, true);
  assert.equal(claimsWin.url, "https://fox.example/1");
});

test("a source with no recorded lean falls back to a bucket rather than being dropped", () => {
  const cluster = { ...CLUSTER, article_ids: ["a_center", "a_unknown"], near_duplicates: [], independent_sources: 2, lean_buckets: ["center"] };
  const ctx = coverageContext({
    pool: { articles: [...POOL_ARTICLES, { id: "a_unknown", source_id: "mystery_outlet", title: "A story", published_at: "2026-09-24T07:00:00Z" }] },
    names: { bbc_world: "BBC World", mystery_outlet: "Mystery Outlet" },
    leans: { bbc_world: "center" },
    ownership: {},
    coverage: { a_center: { url: "https://bbc.example/a", has_body: false }, a_unknown: { url: "https://mystery.example/a", has_body: false } },
  });
  const { groups } = buildCoverage(cluster, ctx);
  const seen = groups.flatMap((g) => g.rows.map((r) => r.id));
  assert.deepEqual(seen.sort(), ["a_center", "a_unknown"]);
});
