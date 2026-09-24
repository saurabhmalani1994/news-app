// U2: the You page's pure edits: level words over affinity both ways, source toggles
// writing mutes.sources, and one version per per-interest edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile, STARTER_TOPICS } from "../../app/static/js/profile/default-profile.js";
import {
  LEVELS, levelForAffinity, affinityForLevel, levelOf, withTopicLevel, withTopicField,
  withTopicMuted, withBoostAmount, withStandingField, parseKeywords, withSummaries, summariesMode,
  sourceState, withSourceState, withSourceStates, sourceCounts, groupByRegion, matchesQuery,
  sourceDetail, commitEdit, SOURCE_STATES,
  INTEREST_CATALOG, availableInterests, withTopicAdded, withTopicRemoved,
} from "../../app/static/js/profile/you-edits.js";
import { TAG_TO_TOPIC } from "../../app/static/js/ranker.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const TOPICS_DOC = JSON.parse(readFileSync(new URL("../../topics.json", import.meta.url), "utf-8"));

function makeStore() {
  let tick = 0;
  return new ProfileStore({
    storage: new MemoryStorage(), schema: SCHEMA, seedDefault: buildDefaultProfile,
    now: () => `2026-09-24T00:00:${String(tick++ % 60).padStart(2, "0")}Z`,
  });
}

test("affinity to level: every range boundary reads as the documented word", () => {
  assert.equal(levelForAffinity(1), "more");
  assert.equal(levelForAffinity(0.75), "more");
  assert.equal(levelForAffinity(0.7499), "normal");
  assert.equal(levelForAffinity(0.4), "normal");
  assert.equal(levelForAffinity(0.3999), "less");
  assert.equal(levelForAffinity(0), "less");
  assert.equal(levelOf({ affinity: 0.9, enabled: false }), "off");
  assert.deepEqual(LEVELS.map((l) => l.word), ["More", "Normal", "Less", "Off"]);
});

test("level to affinity: each written value reads back as its own level", () => {
  for (const level of ["more", "normal", "less"]) {
    const value = affinityForLevel(level);
    assert.ok(value >= 0 && value <= 1);
    assert.equal(levelForAffinity(value), level);
  }
  assert.equal(affinityForLevel("off"), null);
});

test("choosing a level: off keeps the weight, on again restores it, same level is a no-op", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z"); // singapore 0.9, More
  assert.equal(withTopicLevel(p, "singapore", "more"), null);
  const off = withTopicLevel(p, "singapore", "off");
  assert.equal(off.topics.singapore.enabled, false);
  assert.equal(off.topics.singapore.affinity, 0.9);
  const back = withTopicLevel(off, "singapore", "more");
  assert.equal(back.topics.singapore.enabled, true);
  assert.equal(back.topics.singapore.affinity, 0.9);
  const less = withTopicLevel(p, "singapore", "less");
  assert.equal(less.topics.singapore.affinity, affinityForLevel("less"));
  assert.equal(withTopicLevel(p, "nope", "more"), null);
});

test("source toggles write mutes.sources and nothing else", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(sourceState(p, "npr"), SOURCE_STATES.ON);
  const off = withSourceState(p, "npr", "off");
  assert.deepEqual(off.mutes.sources, ["npr"]);
  assert.deepEqual(off.mutes.topics, p.mutes.topics);
  assert.deepEqual({ ...off, mutes: p.mutes }, p);
  assert.equal(sourceState(off, "npr"), "off");
  assert.equal(withSourceState(off, "npr", "off"), null);
  assert.deepEqual(withSourceState(off, "npr", "on").mutes.sources, []);
  const group = withSourceStates(off, ["npr", "bbc_world", "axios"], "off");
  assert.deepEqual(group.mutes.sources, ["npr", "bbc_world", "axios"]);
  assert.deepEqual(withSourceStates(group, ["bbc_world", "axios"], "on").mutes.sources, ["npr"]);
  assert.equal(withSourceStates(group, ["npr", "axios"], "off"), null);
  const catalog = [{ id: "npr" }, { id: "bbc_world" }, { id: "axios" }, { id: "reason" }];
  assert.deepEqual(sourceCounts(group, catalog), { on: 1, total: 4 });
});

test("a source toggle saved through the store is one version the ranker's mute list carries", () => {
  const store = makeStore();
  const result = commitEdit(store, (p) => withSourceState(p, "fox_politics", "off"));
  assert.equal(result.ok, true);
  assert.equal(result.before, 1);
  assert.equal(store.history().length, 2);
  assert.deepEqual(store.current().mutes.sources, ["fox_politics"]);
  store.revert(result.before); // Undo
  assert.deepEqual(store.current().mutes.sources, []);
  assert.equal(commitEdit(store, (p) => withSourceState(p, "npr", "on")), null); // no-op, no version
  assert.equal(store.history().length, 3);
});

test("every per-interest edit produces exactly one version", () => {
  const store = makeStore();
  let p = store.current();
  p.boosts = [{ id: "boost-topic-ai", label: "More AI", match_type: "topic", match_value: "ai", amount: 0.4 }];
  store.save(p);
  const edits = [
    (q) => withTopicLevel(q, "ai", "more"),
    (q) => withTopicLevel(q, "ai", "off"),
    (q) => withTopicField(q, "ai", "affinity", 0.55),
    (q) => withTopicField(q, "ai", "half_life_hours", 24),
    (q) => withTopicMuted(q, "ai", true),
    (q) => withBoostAmount(q, "boost-topic-ai", 0.2),
    (q) => withStandingField(q, "sudan", "silence_hours", 12),
    (q) => withStandingField(q, "sudan", "keywords", "Sudan, Darfur ,  RSF\nsudan"),
    (q) => withSummaries(q, "top"),
  ];
  for (const edit of edits) {
    const before = store.history().length;
    const result = commitEdit(store, edit);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(store.history().length, before + 1);
    assert.equal(commitEdit(store, edit), null, "repeating the same edit writes nothing");
    assert.equal(store.history().length, before + 1);
  }
  const final = store.current();
  assert.equal(final.topics.ai.half_life_hours, 24);
  assert.deepEqual(final.mutes.topics, ["ai"]);
  assert.deepEqual(final.standing_stories.find((s) => s.id === "sudan").keywords, ["Sudan", "Darfur", "RSF"]);
  assert.equal(summariesMode(final), "top");
});

test("an out-of-range field is refused by the store, writing nothing", () => {
  const store = makeStore();
  const result = commitEdit(store, (q) => withTopicField(q, "ai", "half_life_hours", 500));
  assert.equal(result.ok, false);
  assert.equal(store.history().length, 1);
});

test("display.summaries defaults to all and toggles to top", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(p.display.summaries, "all");
  assert.equal(withSummaries(p, "all"), null);
  delete p.display;
  assert.equal(summariesMode(p), "all");
  assert.equal(withSummaries(p, "top").display.summaries, "top");
});

test("grouping, search and row words", () => {
  const catalog = [
    { id: "b", name: "Zeta Times", bucket: "zz_new_region", lean: "center" },
    { id: "a", name: "Asia Times", bucket: "asia", lean: "non-us" },
    { id: "c", name: "CNA Asia", bucket: "asia", lean: "state", ownership: "state-owned" },
    { id: "d", name: "NPR", bucket: "general", lean: "center-left" },
  ];
  const groups = groupByRegion(catalog);
  assert.deepEqual(groups.map((g) => g.label), ["General and world", "Asia", "Zz new region"]);
  assert.deepEqual(groups[1].sources.map((s) => s.id), ["a", "c"]);
  assert.ok(matchesQuery("Straits Times Singapore", "times sing"));
  assert.ok(!matchesQuery("Straits Times Singapore", "cna"));
  assert.ok(matchesQuery("Le Monde édition", "edition"));
  assert.equal(sourceDetail(catalog[2]), "State-owned");
  assert.equal(sourceDetail(catalog[3]), "Center-left");
  assert.deepEqual(parseKeywords(" a, b;a\n\n c "), ["a", "b", "c"]);
});

// U4: the catalog offered to Add interest is exactly the ids the pipeline can actually
// match a story to (the closed tag set fetcher/topics.py tags articles with, TAG_TO_TOPIC's
// own remap folded in) plus must_know, the ranker's own guaranteed-floor bucket which is
// not a tag at all. Every entry is one distinct, non-empty, lowercase-and-underscore id.
test("the interest catalog is exactly the pipeline's own matchable ids, once each", () => {
  const catalogIds = new Set(INTEREST_CATALOG.map((e) => e.id));
  assert.equal(catalogIds.size, INTEREST_CATALOG.length, "no id listed twice");
  for (const entry of INTEREST_CATALOG) {
    assert.match(entry.id, /^[a-z][a-z0-9_]*$/, entry.id);
    assert.ok(entry.label && entry.group, JSON.stringify(entry));
  }
  // Every raw pipeline tag (topics.json) is covered by a catalog entry, either its own
  // id or the id TAG_TO_TOPIC (ranker.js) folds it into: "biotech" -> "industrial_biotech"
  // is a pure rename ("a tag whose profile bucket has another name"), so only the
  // renamed id is offered, not both. "politics" is the one exception: TAG_TO_TOPIC also
  // names it a fallback into "us_politics" for a topic that does not exist yet, but
  // fetcher/topics.py documents them as deliberately different scopes (us_politics
  // narrower, politics also firing on non-US politics), so both get their own entry.
  for (const tag of TOPICS_DOC.topics) {
    const landsOn = tag === "politics" ? "politics" : (TAG_TO_TOPIC[tag] || tag);
    assert.ok(catalogIds.has(landsOn), `tag ${tag} has no catalog entry (expected ${landsOn})`);
  }
  assert.ok(catalogIds.has("must_know"), "must_know is not a tag: the ranker's own guaranteed floor, offered on its own");
  assert.equal(catalogIds.size, TOPICS_DOC.topics.length + 1, "one entry per pipeline tag (biotech folded in), plus must_know");
  // Every starter bucket already on the default profile is a catalog entry too, so
  // removing one always leaves it re-addable.
  for (const id of Object.keys(STARTER_TOPICS)) assert.ok(catalogIds.has(id), `${id} missing from the catalog`);
});

test("availableInterests hides catalog entries already on the profile", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z"); // starter: us_politics, singapore, ai, industrial_biotech, world, must_know
  const ids = availableInterests(p).map((e) => e.id);
  assert.equal(ids.length, INTEREST_CATALOG.length - 6);
  for (const id of ["us_politics", "singapore", "ai", "industrial_biotech", "world", "must_know"]) assert.ok(!ids.includes(id));
  assert.ok(ids.includes("climate_tech") && ids.includes("politics"));
});

test("adding an interest: a known one works, a duplicate is refused, an unknown id is refused", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  const added = withTopicAdded(p, "climate_tech");
  assert.deepEqual(added.topics.climate_tech, { label: "Climate Tech", affinity: 0.6, half_life_hours: 24, enabled: true });
  assert.equal(Object.keys(p.topics).length, 6, "the input draft is untouched");
  assert.equal(withTopicAdded(p, "singapore"), null); // duplicate: already an interest
  assert.equal(withTopicAdded(p, "not-a-real-interest"), null); // unknown id: not in the catalog
  // A starter bucket restores its own shipped weight, not the flattened generic default.
  const withoutSg = withTopicRemoved(p, "singapore");
  const readded = withTopicAdded(withoutSg, "singapore");
  assert.deepEqual(readded.topics.singapore, STARTER_TOPICS.singapore);
  // must_know keeps its zeroed affinity and floor_slots, the whole point of the bucket.
  const withoutMK = withTopicRemoved(p, "must_know");
  const readdedMK = withTopicAdded(withoutMK, "must_know");
  assert.equal(readdedMK.topics.must_know.affinity, 0);
  assert.equal(readdedMK.topics.must_know.floor_slots, 2);
});

test("removing an interest: known works and cleans up its mute and boosts, unknown is refused, the last one is refused", () => {
  const base = buildDefaultProfile("2026-09-24T00:00:00Z");
  let p = { ...base, mutes: { ...base.mutes, topics: ["ai"] }, boosts: [{ id: "b1", label: "AI", match_type: "topic", match_value: "ai", amount: 0.3 }] };
  const removed = withTopicRemoved(p, "ai");
  assert.ok(!Object.hasOwn(removed.topics, "ai"));
  assert.deepEqual(removed.mutes.topics, []);
  assert.deepEqual(removed.boosts, []);
  assert.equal(withTopicRemoved(p, "not-an-interest"), null); // unknown id
  // Removing every topic but one, then trying to take the last one, is refused (the
  // schema requires at least one topic).
  let onlyOne = p;
  for (const id of Object.keys(p.topics)) { if (id === "world") continue; onlyOne = withTopicRemoved(onlyOne, id) || onlyOne; }
  assert.deepEqual(Object.keys(onlyOne.topics), ["world"]);
  assert.equal(withTopicRemoved(onlyOne, "world"), null);
});

test("add, remove and undo through the store: one version each, exact restore, the schema stays valid", () => {
  const store = makeStore();
  const v0 = store.history().length;

  const addResult = commitEdit(store, (p) => withTopicAdded(p, "climate_tech"));
  assert.equal(addResult.ok, true, JSON.stringify(addResult.errors));
  assert.equal(store.history().length, v0 + 1);
  assert.ok(Object.hasOwn(store.current().topics, "climate_tech"));
  assert.equal(commitEdit(store, (p) => withTopicAdded(p, "climate_tech")), null, "adding it again writes nothing");
  assert.equal(store.history().length, v0 + 1);

  const beforeRemove = store.current();
  const removeResult = commitEdit(store, (p) => withTopicRemoved(p, "ai"));
  assert.equal(removeResult.ok, true, JSON.stringify(removeResult.errors));
  assert.equal(store.history().length, v0 + 2);
  assert.ok(!Object.hasOwn(store.current().topics, "ai"));

  store.revert(removeResult.before); // Undo: back to the version just before the remove
  assert.deepEqual(store.current().topics, beforeRemove.topics);
  assert.equal(store.history().length, v0 + 3);

  // Every version this test wrote validates: the store itself already refuses an
  // invalid save (each commitEdit above asserted result.ok), and the final snapshot
  // checks clean against the schema too.
  assert.deepEqual(validateProfile(store.current(), SCHEMA), []);
});
