// U2: the You page's pure edits: level words over affinity both ways, source toggles
// writing mutes.sources, and one version per per-interest edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import {
  LEVELS, levelForAffinity, affinityForLevel, levelOf, withTopicLevel, withTopicField,
  withTopicMuted, withBoostAmount, withStandingField, parseKeywords, withSummaries, summariesMode,
  sourceState, withSourceState, withSourceStates, sourceCounts, groupByRegion, matchesQuery,
  sourceDetail, commitEdit, SOURCE_STATES,
} from "../../app/static/js/profile/you-edits.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));

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
