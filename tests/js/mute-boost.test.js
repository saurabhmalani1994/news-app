import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ProfileStore, MemoryStorage } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { resolveTopic, ensureTopic, topicLabel } from "../../app/static/js/actions/topic-resolve.js";
import { withSourceMuted, withTopicMuted, withTopicBoosted, BOOST_AMOUNT } from "../../app/static/js/actions/mute-boost.js";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"),
);

function makeStore() {
  let tick = 0;
  return new ProfileStore({
    storage: new MemoryStorage(), schema: SCHEMA, seedDefault: buildDefaultProfile,
    now: () => `2026-09-24T00:00:0${tick++}Z`,
  });
}

// --- topic-resolve.js --------------------------------------------------------------

test("resolveTopic prefers a tag that is already a profile topic", () => {
  const profile = buildDefaultProfile("t");
  assert.equal(resolveTopic(["asia", "singapore"], profile.topics), "singapore");
});

test("resolveTopic maps a fetcher tag through ranker.js's TAG_TO_TOPIC", () => {
  const profile = buildDefaultProfile("t");
  assert.equal(resolveTopic(["politics"], profile.topics), "us_politics");
  assert.equal(resolveTopic(["biotech"], profile.topics), "industrial_biotech");
});

test("resolveTopic falls back to the first tag's own (mapped) id when none is tracked yet", () => {
  const profile = buildDefaultProfile("t");
  assert.equal(resolveTopic(["asia", "conflict"], profile.topics), "asia");
});

test("resolveTopic is null for a story with no topic tags", () => {
  assert.equal(resolveTopic([], {}), null);
  assert.equal(resolveTopic(undefined, {}), null);
});

test("ensureTopic adds a middling bucket only when the id is missing", () => {
  const profile = buildDefaultProfile("t");
  const same = ensureTopic(profile.topics, "singapore");
  assert.equal(same, profile.topics); // unchanged, same reference
  const added = ensureTopic(profile.topics, "asia");
  assert.equal(added.asia.label, "Asia");
  assert.equal(added.asia.enabled, true);
  assert.equal(profile.topics.asia, undefined); // the input was not mutated
});

test("topicLabel title-cases an unknown tag and keeps AI/US Politics readable", () => {
  assert.equal(topicLabel("asia"), "Asia");
  assert.equal(topicLabel("ai"), "AI");
  assert.equal(topicLabel("us_politics"), "US Politics");
});

// --- mute-boost.js: pure draft builders ---------------------------------------------

test("withSourceMuted adds the source once and is null the second time (no no-op version)", () => {
  const profile = buildDefaultProfile("t");
  const draft = withSourceMuted(profile, "cnn");
  assert.deepEqual(draft.mutes.sources, ["cnn"]);
  assert.equal(withSourceMuted(draft, "cnn"), null);
});

test("withTopicMuted adds a new bucket for an untracked tag and mutes it", () => {
  const profile = buildDefaultProfile("t");
  const draft = withTopicMuted(profile, ["asia"]);
  assert.ok(draft.topics.asia);
  assert.deepEqual(draft.mutes.topics, ["asia"]);
  assert.equal(withTopicMuted(draft, ["asia"]), null);
});

test("withTopicBoosted adds a capped positive boost matching the resolved topic", () => {
  const profile = buildDefaultProfile("t");
  const draft = withTopicBoosted(profile, ["singapore"]);
  assert.equal(draft.boosts.length, 1);
  assert.equal(draft.boosts[0].match_type, "topic");
  assert.equal(draft.boosts[0].match_value, "singapore");
  assert.equal(draft.boosts[0].amount, BOOST_AMOUNT);
  assert.equal(withTopicBoosted(draft, ["singapore"]), null); // already boosted
});

// --- through the real ProfileStore: exactly one version, Undo reverts it -----------

test("mute source saves exactly one new profile version, valid against the schema", () => {
  const store = makeStore();
  const before = store.current();
  const result = store.save(withSourceMuted(before, "cnn"));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.profile.profile_version, before.profile_version + 1);
  assert.deepEqual(store.history().map((h) => h.version), [2, 1]);
});

test("mute topic saves exactly one new version, and Undo (revert) restores the one before it", () => {
  const store = makeStore();
  const before = store.current();
  const beforeVersion = before.profile_version;
  const saved = store.save(withTopicMuted(before, ["asia"]));
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  assert.deepEqual(store.history().map((h) => h.version), [2, 1]);
  assert.ok(store.current().mutes.topics.includes("asia"));

  const reverted = store.revert(beforeVersion); // "Undo"
  assert.equal(reverted.ok, true);
  assert.deepEqual(store.history().map((h) => h.version), [3, 2, 1]);
  assert.deepEqual(store.current().mutes.topics, []); // back to how it was
});

test("boost topic saves exactly one new version, and Undo (revert) restores the one before it", () => {
  const store = makeStore();
  const before = store.current();
  const beforeVersion = before.profile_version;
  const saved = store.save(withTopicBoosted(before, ["singapore"]));
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  assert.deepEqual(store.history().map((h) => h.version), [2, 1]);
  assert.equal(store.current().boosts.length, 1);

  const reverted = store.revert(beforeVersion);
  assert.equal(reverted.ok, true);
  assert.deepEqual(store.history().map((h) => h.version), [3, 2, 1]);
  assert.deepEqual(store.current().boosts, []);
});
