// U5: the You page's source picker collapses behind about eight top-level groups (the
// owner, on his phone: "the you page now got way too big again... specifically the news
// sources page"). groupSources folds sources.json's finer buckets under one of them;
// searchSources is the flat, cross-group search the list's own search field uses while
// it holds text. Both are pure (no DOM), so they are tested directly here the same way
// groupByRegion and matchesQuery already are in you-edits.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupSources, searchSources, SOURCE_GROUPS, sourceCounts, SOURCE_STATES } from "../../app/static/js/profile/you-edits.js";

const SOURCES = JSON.parse(readFileSync(new URL("../../sources.json", import.meta.url), "utf-8")).sources;

test("every real source lands in exactly one group, and the groups cover it all", () => {
  const groups = groupSources(SOURCES);
  // About 6 to 10 groups (the brief's own target), not one per fine-grained bucket.
  assert.ok(groups.length >= 6 && groups.length <= 10, `expected 6 to 10 groups, got ${groups.length}`);
  const seen = new Map();
  for (const group of groups) {
    for (const source of group.sources) {
      assert.ok(!seen.has(source.id), `${source.id} appears in more than one group`);
      seen.set(source.id, group.id);
    }
  }
  assert.equal(seen.size, SOURCES.length, "every source is in some group");
  const total = groups.reduce((n, g) => n + g.sources.length, 0);
  assert.equal(total, SOURCES.length, "group sizes sum to the full catalog");
});

test("the real catalog's groups are the brief's own eight, with the right counts", () => {
  const groups = groupSources(SOURCES);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g.sources.length]));
  // Computed straight from sources.json's own bucket field (see sources.json), folded
  // under the mapping SOURCE_GROUPS declares: us_politics and asia keep their own
  // buckets; world absorbs general, israel_gaza, sudan, europe, africa, latin_america,
  // middle_east and oceania; science_biotech absorbs science and biotech.
  assert.deepEqual(byId, {
    us_politics: 10,
    world: 35,
    asia: 20,
    singapore: 5,
    business: 5,
    tech_ai: 5,
    science_biotech: 7,
    climate_food: 10,
  }, JSON.stringify(byId));
  assert.equal(groups.map((g) => g.label).join(", "),
    "US politics, World, Asia, Singapore, Business, Tech and AI, Science and biotech, Climate and food");
  // Every group is one of SOURCE_GROUPS' own eight (no unmapped-bucket fallback fired).
  assert.deepEqual(groups.map((g) => g.id), SOURCE_GROUPS.map((g) => g.id));
});

test("a bucket not in SOURCE_GROUPS still gets its own group, named from itself, last", () => {
  const catalog = [
    { id: "a", name: "Alpha News", bucket: "us_politics" },
    { id: "b", name: "Beta Times", bucket: "brand_new_region" },
  ];
  const groups = groupSources(catalog);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, "us_politics");
  assert.deepEqual(groups[1], { id: "brand_new_region", label: "Brand new region", sources: [catalog[1]] });
});

test("a source with no bucket at all still lands somewhere, not dropped", () => {
  const catalog = [{ id: "x", name: "X Wire" }];
  const groups = groupSources(catalog);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sources.length, 1);
  assert.equal(groups[0].sources[0].id, "x");
});

test("sources within a group are sorted by name, case and accent insensitive", () => {
  const catalog = [
    { id: "z", name: "Zebra Daily", bucket: "asia" },
    { id: "e", name: "édition Asia", bucket: "asia" },
    { id: "a", name: "Asia Wire", bucket: "asia" },
  ];
  const [group] = groupSources(catalog);
  assert.deepEqual(group.sources.map((s) => s.id), ["a", "e", "z"]);
});

test("searchSources matches flat across every group, same rule matchesQuery uses", () => {
  const catalog = [
    { id: "a", name: "Straits Times", bucket: "singapore" },
    { id: "b", name: "New York Times", bucket: "us_politics" },
    { id: "c", name: "CNA", bucket: "singapore" },
    { id: "d", name: "Le Monde", bucket: "world" },
  ];
  const times = searchSources(catalog, "times");
  assert.deepEqual(times.map((s) => s.id).sort(), ["a", "b"]);
  const cna = searchSources(catalog, "cna");
  assert.deepEqual(cna.map((s) => s.id), ["c"]);
  assert.deepEqual(searchSources(catalog, "nothing matches this"), []);
  // Every word typed must match somewhere in the name (matchesQuery's own rule).
  assert.deepEqual(searchSources(catalog, "new times").map((s) => s.id), ["b"]);
  // An empty query is not a search: everything "matches" (the page treats blank text as
  // no filter and shows the group list instead, but the pure function itself is total).
  assert.equal(searchSources(catalog, "").length, catalog.length);
});

test("group on/off counts (the row's own \"N of M on\" line) read from the real profile shape", () => {
  const catalog = [
    { id: "a", name: "A", bucket: "asia" },
    { id: "b", name: "B", bucket: "asia" },
    { id: "c", name: "C", bucket: "us_politics" },
  ];
  const profile = { mutes: { sources: ["b"] } };
  const [usPolitics, asia] = groupSources(catalog); // SOURCE_GROUPS orders us_politics before asia
  assert.deepEqual(sourceCounts(profile, asia.sources), { on: 1, total: 2 });
  assert.deepEqual(sourceCounts(profile, usPolitics.sources), { on: 1, total: 1 });
  assert.equal(SOURCE_STATES.ON, "on");
});
