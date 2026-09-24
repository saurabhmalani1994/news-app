// S27 proof: every section tab is the ranked pool filtered by the one mapping table, in
// ranked order; US Politics takes the us_politics tag or, failing it, the source bucket;
// the Live slot holds nothing until S33 fills it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rank } from "../../app/static/js/ranker.js";
import { SECTIONS, bucketMap, inSection, sectionIds, sectionLists } from "../../app/static/js/sections.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const sources = JSON.parse(readFileSync(new URL("../../sources.json", import.meta.url), "utf8")).sources;
const buckets = bucketMap(sources);
const NOW = "2026-09-24T06:00:00Z";

function article(id, source_id, topics, hoursOld) {
  return { id, source_id, title: `Story ${id}`, published_at: new Date(Date.parse(NOW) - hoursOld * 3.6e6).toISOString(), topics };
}

const pool = {
  generated_at: NOW,
  articles: [
    article("a1", "npr", ["world"], 1),
    article("a2", "politico", ["politics"], 2),
    article("a3", "npr", ["politics", "us_politics"], 3),
    article("a4", "straits_times", ["singapore"], 1.5),
    article("a5", "bbc_world", ["asia", "world"], 4),
    article("a6", "techcrunch_ai", ["ai"], 5),
    article("a7", "fierce_biotech", ["biotech", "science"], 6),
    article("a8", "unknown_outlet", ["politics"], 0.5),
  ],
  clusters: [],
};

test("the table names the owner's tabs in order, Live second", () => {
  assert.deepEqual(SECTIONS.map((s) => s.label), ["Today", "Live", "US Politics", "World", "Singapore", "Asia", "AI", "Biotech"]);
  assert.equal(SECTIONS[1].slot, "live");
});

test("each tab equals the ranked pool filtered by the table, in ranked order", () => {
  const ranked = rank(pool, buildDefaultProfile(NOW), NOW);
  const order = ranked.map((s) => s.id);
  for (const section of sectionLists(ranked, buckets)) {
    const table = SECTIONS.find((s) => s.id === section.id);
    const want = ranked.filter((s) => inSection(s, table, buckets)).map((s) => s.id);
    assert.deepEqual(section.ids, want, section.id);
    // a subsequence of the ranked order: nothing reordered, nothing added
    assert.deepEqual(section.ids, order.filter((id) => section.ids.includes(id)), section.id);
  }
  assert.deepEqual(sectionIds(ranked, SECTIONS[0], buckets), order);
});

test("US Politics: the us_politics tag, else the source bucket, never the generic politics tag", () => {
  const ranked = rank(pool, buildDefaultProfile(NOW), NOW);
  const us = sectionIds(ranked, SECTIONS.find((s) => s.id === "us-politics"), buckets);
  assert.equal(buckets.politico, "us_politics");
  assert.deepEqual([...us].sort(), ["a2", "a3"]); // a2 by bucket, a3 by tag; a8 is generic politics
});

test("the Live slot is empty until S33 fills it", () => {
  const ranked = rank(pool, buildDefaultProfile(NOW), NOW);
  assert.deepEqual(sectionIds(ranked, SECTIONS[1], buckets), []);
});

test("buckets follow sources.json and every table bucket exists there", () => {
  const known = new Set(sources.map((s) => s.bucket));
  for (const s of SECTIONS) for (const b of s.buckets || []) assert.ok(known.has(b), b);
});

test("G1: Singapore and Asia follow the story's own geography, never the outlet", () => {
  const g = (id, source_id, geo, hoursOld, topics = ["world"]) => ({ ...article(id, source_id, topics, hoursOld), geo });
  const lean = { near_duplicates: [], independent_sources: 2, lean_buckets: ["center", "non-us"] };
  const geoPool = {
    generated_at: NOW,
    articles: [
      g("w1", "mothership", ["us"], 1), // a Singapore outlet's White House story
      g("w2", "npr", ["us"], 1.2),
      g("h1", "straits_times_sg", ["asia", "sg", "world"], 2), // HDB prices, no "Singapore"
      g("x1", "npr", ["asia", "us", "world"], 3), // Xi and Trump summit
      g("x2", "business_times_sg", ["asia", "us", "world"], 3.1),
      g("m1", "cna_asia", ["world"], 4), // Middle East, from an Asia outlet
      g("n1", "cna_singapore", [], 5), // names no place at all
      g("s1", "npr", ["us"], 6), // a US outlet's story ...
      g("s2", "bbc_world", ["asia", "sg", "world"], 6.1), // ... that another member places in Singapore
    ],
    clusters: [
      { id: "cw", article_ids: ["w1", "w2"], ...lean },
      { id: "cx", article_ids: ["x1", "x2"], ...lean },
      { id: "cs", article_ids: ["s1", "s2"], ...lean },
    ],
  };
  const ranked = rank(geoPool, buildDefaultProfile(NOW), NOW);
  const ids = (id) => sectionIds(ranked, SECTIONS.find((s) => s.id === id), buckets).sort();
  assert.deepEqual(ids("singapore"), ["cs", "h1"]);
  assert.deepEqual(ids("asia"), ["cs", "cx", "h1"]);
  assert.ok(ids("world").includes("cx") && ids("world").includes("m1"));
  assert.deepEqual(ranked.find((s) => s.id === "cs").geo, ["asia", "sg", "us", "world"]); // union of members
  for (const id of ["singapore", "asia"]) assert.equal(SECTIONS.find((s) => s.id === id).buckets, undefined, id);
});
