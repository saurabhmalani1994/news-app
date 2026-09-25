// W1 (R50): the You page's new edits, pure and through the store. A phrase interest is
// added, refused (empty, too long, a repeat, the search full), leveled and removed with
// Undo, one version per edit; a standing story is added, followed (prefilled from a
// story's headlines), refused and removed with Undo, one version per edit. The schema
// takes a phrase and refuses a bad one, migrate keeps a phrase clean, and the store's
// onSave hook fires once per written version only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { migrateProfile } from "../../app/static/js/profile/migrate.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import {
  phraseStatus, withPhraseAdded, phraseTopicId, searchCount, withTopicLevel, withTopicRemoved, levelOf, commitEdit,
  standingStatus, withStandingAdded, withStandingRemoved, standingId, standingKeywords, STANDING_MAX,
} from "../../app/static/js/profile/you-edits.js";
import { STANDING_DEFAULTS, STANDING_NEW, standingStories, qualifies } from "../../app/static/js/standing.js";
import { suggestStanding } from "../../app/static/js/story-keywords.js";
import { storiesFromPool } from "../../app/static/js/ranker.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-24T12:00:00Z";

function makeStore(extra = {}) {
  let tick = 0;
  return new ProfileStore({
    storage: new MemoryStorage(), schema: SCHEMA, seedDefault: buildDefaultProfile,
    now: () => `2026-09-24T00:${String(Math.floor(tick / 60) % 60).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}Z`,
    ...extra,
  });
}

test("phrase status: typed text is cleaned, and each refusal says why", () => {
  const p = buildDefaultProfile(NOW);
  assert.deepEqual(phraseStatus(p, "  sodium   battery "), { ok: true, phrase: "sodium battery" });
  assert.deepEqual(phraseStatus(p, "“sodium battery”"), { ok: true, phrase: "sodium battery" });
  assert.equal(phraseStatus(p, "").reason, "empty");
  assert.equal(phraseStatus(p, " !! ").reason, "empty");
  assert.equal(phraseStatus(p, "x".repeat(61)).reason, "long");
  const added = withPhraseAdded(p, "Sodium battery");
  assert.equal(phraseStatus(added, "sodium batteries").reason, "duplicate", "a plural is the same phrase");
  assert.equal(phraseStatus(added, "sodium batteries").id, "p_sodium_battery");
  const full = buildDefaultProfile(NOW);
  for (let i = 0; i < 23; i++) full.topics[`p_t${i}`] = { label: `t ${i}`, phrase: `test phrase ${i}`, affinity: 0.6, half_life_hours: 24, enabled: true };
  assert.equal(searchCount(full), 25, "23 phrases and the two default standing stories");
  assert.equal(phraseStatus(full, "one more").reason, "full");
  full.topics.p_t0.enabled = false;
  assert.equal(phraseStatus(full, "one more").ok, true, "a phrase that is off is not searched, so it frees a place");
});

test("phrase add: a Normal interest with its own id, and the schema accepts it", () => {
  const p = withPhraseAdded(buildDefaultProfile(NOW), "Sodium-ion battery");
  assert.deepEqual(p.topics.p_sodium_ion_battery,
    { label: "Sodium-ion battery", phrase: "Sodium-ion battery", affinity: 0.6, half_life_hours: 24, enabled: true });
  assert.equal(levelOf(p.topics.p_sodium_ion_battery), "normal");
  assert.equal(phraseTopicId(p, "sodium ion battery!"), "p_sodium_ion_battery_2", "a taken id gets a suffix");
  assert.equal(phraseTopicId(p, "漢字"), "p_phrase", "no Latin letters still gets a valid id");
  assert.match(phraseTopicId(p, "a".repeat(60)), /^[a-z][a-z0-9_]{1,31}$/);
  assert.equal(withPhraseAdded(p, "sodium-ion batteries"), null, "a repeat is refused");
  assert.deepEqual(validateProfile({ ...p, profile_version: 2 }, SCHEMA), []);
});

test("schema and integrity: quotes, a wordless phrase and two phrases alike are refused", () => {
  const base = buildDefaultProfile(NOW);
  const bad = (phrase, extra = {}) => {
    const p = structuredClone(base);
    p.topics.p_x = { label: "x", phrase, affinity: 0.6, half_life_hours: 24, enabled: true };
    Object.assign(p.topics, extra);
    return validateProfile(p, SCHEMA);
  };
  assert.ok(bad("say \"hi\"").some((e) => e.includes("phrase")));
  assert.ok(bad("x".repeat(61)).some((e) => e.includes("longer than 60")));
  assert.ok(bad("!!!").some((e) => e.includes("at least one letter")));
  assert.ok(bad("heat pump", { p_y: { label: "y", phrase: "Heat-pumps", affinity: 0.6, half_life_hours: 24, enabled: true } })
    .some((e) => e.includes("the same phrase")));
  assert.deepEqual(bad("heat pump"), []);
});

test("migrate: a phrase is kept clean and a phrase with no label shows its phrase; nothing else moves", () => {
  const p = buildDefaultProfile(NOW);
  p.topics.p_heat_pump = { phrase: "  heat   pump ", affinity: 0.6, half_life_hours: 24, enabled: true };
  const { profile, added } = migrateProfile(p, NOW);
  assert.deepEqual(profile.topics.p_heat_pump, { phrase: "heat pump", label: "heat pump", affinity: 0.6, half_life_hours: 24, enabled: true });
  assert.deepEqual(added, ["fields"]);
  const clean = withPhraseAdded(buildDefaultProfile(NOW), "heat pump");
  assert.deepEqual(migrateProfile(clean, NOW).added, [], "a current profile with a phrase needs nothing");
});

test("one version per edit: phrase add, level, remove, and Undo restore exactly", () => {
  const saved = [];
  const store = makeStore({ onSave: (profile) => saved.push(profile.profile_version) });
  const v0 = store.history()[0].version;
  const add = commitEdit(store, (p) => withPhraseAdded(p, "sodium battery"));
  assert.ok(add.ok);
  assert.equal(store.history()[0].version, v0 + 1);
  assert.equal(commitEdit(store, (p) => withPhraseAdded(p, "sodium battery")), null, "a repeat writes nothing");
  const level = commitEdit(store, (p) => withTopicLevel(p, "p_sodium_battery", "more"));
  assert.equal(store.history()[0].version, v0 + 2);
  assert.equal(store.current().topics.p_sodium_battery.affinity, 0.9);
  const before = store.current().topics.p_sodium_battery;
  const removed = commitEdit(store, (p) => withTopicRemoved(p, "p_sodium_battery"));
  assert.equal(store.history()[0].version, v0 + 3);
  assert.ok(!store.current().topics.p_sodium_battery);
  store.revert(removed.before);
  assert.equal(store.history()[0].version, v0 + 4);
  assert.deepEqual(store.current().topics.p_sodium_battery, before);
  assert.deepEqual(saved, [v0 + 1, v0 + 2, v0 + 3, v0 + 4], "onSave once per written version, never for a no-op");
  assert.ok(level.ok);
});

test("onSave: never called for a refused save, and a throw in it never undoes the save", () => {
  const calls = [];
  const store = makeStore({ onSave: () => { calls.push(1); throw new Error("hook"); } });
  const bad = store.save({ ...store.current(), topics: {} });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0);
  const good = store.save(withPhraseAdded(store.current(), "grid storage"));
  assert.equal(good.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(store.current().topics.p_grid_storage);
});

test("standing status and add: defaults kept, the new floor and alarm, no tags, one version", () => {
  const p = buildDefaultProfile(NOW);
  assert.equal(standingStatus(p, { label: " ", keywords: "a, b" }).reason, "name");
  assert.equal(standingStatus(p, { label: "Rail strike", keywords: "x, ;" }).reason, "keywords");
  assert.equal(standingStatus(p, { label: "sudan", keywords: "khartoum" }).reason, "duplicate");
  assert.deepEqual(standingKeywords("rail strike, Rail Strike; union\nx"), ["rail strike", "union"]);
  const next = withStandingAdded(p, { label: "  Rail   strike ", keywords: "rail strike, train drivers" });
  const story = next.standing_stories.at(-1);
  assert.deepEqual(story, {
    id: "rail_strike", label: "Rail strike", enabled: true, keywords: ["rail strike", "train drivers"],
    tags: [], buckets: [], floor_slots: STANDING_NEW.floor_slots, floor_within: STANDING_NEW.floor_within, silence_hours: STANDING_NEW.silence_hours,
  });
  assert.deepEqual(STANDING_NEW, { floor_slots: 1, floor_within: 15, silence_hours: 24 });
  assert.deepEqual(next.standing_stories.slice(0, 2).map((s) => s.id), ["israel_gaza", "sudan"]);
  assert.deepEqual(validateProfile({ ...next, profile_version: 2 }, SCHEMA), []);
  const absent = buildDefaultProfile(NOW);
  delete absent.standing_stories;
  assert.deepEqual(withStandingAdded(absent, { label: "Rail strike", keywords: "rail" }).standing_stories.map((s) => s.id),
    ["israel_gaza", "sudan", "rail_strike"], "an absent list means the defaults, which are kept");
  assert.equal(standingId(next, "Rail strike"), "rail_strike_2");
  assert.equal(standingId(next, "2026 election"), "s_2026_election");
  const full = structuredClone(p);
  while (full.standing_stories.length < STANDING_MAX) full.standing_stories.push({ ...STANDING_DEFAULTS[1], id: `s_${full.standing_stories.length}`, label: `S ${full.standing_stories.length}` });
  assert.equal(standingStatus(full, { label: "One more", keywords: "more" }).reason, "full");
  const [compiled] = standingStories({ standing_stories: [story] });
  assert.ok(qualifies({ titles: ["Rail strike halts trains"], topics: ["economy"] }, compiled), "no tags: any headline with a keyword counts");
});

test("follow: a story's headlines prefill a name and keywords that make a valid standing story", () => {
  const pool = [
    "Trump signs order on tariffs", "Markets fall as Trump weighs tariffs", "Apple unveils new iPhone",
    "Fed holds rates steady", "Singapore MRT line delayed", "Heat wave in Europe",
  ];
  const own = ["Sudan's army retakes El Fasher airport from RSF", "RSF withdraws from El Fasher as Sudan army advances"];
  const suggestion = suggestStanding(own, [...pool, ...own]);
  assert.equal(suggestion.label, "El Fasher");
  assert.deepEqual(suggestion.keywords.slice(0, 3), ["el fasher", "rsf", "sudan"]);
  assert.ok(suggestion.keywords.every((k) => k === k.toLowerCase() && k.length >= 2));
  const next = withStandingAdded(buildDefaultProfile(NOW), suggestion);
  assert.ok(next, "the suggestion is accepted as is");
  const story = next.standing_stories.at(-1);
  assert.equal(story.id, "el_fasher");
  const stories = storiesFromPool({ articles: own.map((title, i) => ({ id: `a${i}`, source_id: "s", title, published_at: NOW })), clusters: [] });
  const [compiled] = standingStories({ standing_stories: [story] });
  assert.ok(stories.every((s) => qualifies(s, compiled)), "the followed story's own headlines qualify for it");
  assert.equal(suggestStanding(["Bank of England holds rates as inflation cools"], pool).label, "Bank of England");
  assert.equal(suggestStanding(["Donald Trump says tariffs stay"], pool).label, "Donald Trump");
  assert.deepEqual(suggestStanding([], pool), { label: "", keywords: [] });
});

test("standing remove and Undo through the store: one version each, exact restore", () => {
  const store = makeStore();
  const v0 = store.history()[0].version;
  const add = commitEdit(store, (p) => withStandingAdded(p, { label: "Rail strike", keywords: "rail strike" }));
  assert.ok(add.ok);
  assert.equal(store.history()[0].version, v0 + 1);
  const snapshot = structuredClone(store.current().standing_stories);
  const removed = commitEdit(store, (p) => withStandingRemoved(p, "rail_strike"));
  assert.ok(removed.ok);
  assert.equal(store.history()[0].version, v0 + 2);
  assert.deepEqual(store.current().standing_stories.map((s) => s.id), ["israel_gaza", "sudan"]);
  assert.equal(commitEdit(store, (p) => withStandingRemoved(p, "rail_strike")), null, "removing what is gone writes nothing");
  store.revert(removed.before);
  assert.equal(store.history()[0].version, v0 + 3);
  assert.deepEqual(store.current().standing_stories, snapshot);
  const sudan = commitEdit(store, (p) => withStandingRemoved(p, "sudan"));
  assert.ok(sudan.ok, "a default story can be removed too");
  assert.deepEqual(store.current().standing_stories.map((s) => s.id), ["israel_gaza", "rail_strike"]);
});
