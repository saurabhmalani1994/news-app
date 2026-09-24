import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ProfileStore, MemoryStorage, STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"),
);

function makeStore(overrides = {}) {
  let tick = 0;
  return new ProfileStore({
    storage: new MemoryStorage(),
    schema: SCHEMA,
    seedDefault: buildDefaultProfile,
    now: () => `2026-09-24T00:00:0${tick++}Z`,
    ...overrides,
  });
}

test("first read seeds the shipped default as version 1", () => {
  const store = makeStore();
  const profile = store.current();
  assert.equal(profile.profile_version, 1);
  assert.equal(profile.topics.singapore.affinity, 0.9);
});

test("save validates: an invalid profile is rejected and nothing is written", () => {
  const store = makeStore();
  const bad = store.current(); // also seeds the store on first access
  const before = store.storage.getItem(STORAGE_KEY);
  delete bad.trust;
  const result = store.save(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(store.storage.getItem(STORAGE_KEY), before);
});

test("save does not require the caller's own updated_at to already be schema valid, since it is overwritten", () => {
  // Regression: a draft round-tripped through current() carries whatever updated_at
  // the store last wrote. If a past version was ever stamped with an out-of-pattern
  // value (millisecond precision, say), validating the caller's copy before stamping
  // would reject a perfectly good edit for a field the caller never touched.
  const store = makeStore();
  const draft = store.current();
  draft.updated_at = "2026-09-24T05:24:46.505Z"; // has milliseconds, fails the pattern
  draft.topics.singapore.affinity = 0.5;
  const result = store.save(draft);
  assert.equal(result.ok, true);
  assert.match(result.profile.updated_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
});

test("save stamps a new version number and timestamp, ignoring the caller's own", () => {
  const store = makeStore();
  const draft = store.current();
  draft.profile_version = 999;
  draft.updated_at = "1999-01-01T00:00:00Z";
  draft.topics.singapore.affinity = 0.95;
  const result = store.save(draft);
  assert.equal(result.ok, true);
  assert.equal(result.profile.profile_version, 2);
  assert.notEqual(result.profile.updated_at, "1999-01-01T00:00:00Z");
});

test("current() reflects the latest saved version", () => {
  const store = makeStore();
  const draft = store.current();
  draft.topics.singapore.affinity = 0.5;
  store.save(draft);
  assert.equal(store.current().topics.singapore.affinity, 0.5);
});

test("history lists every version, newest first, without full profile bodies", () => {
  const store = makeStore();
  const draft = store.current();
  draft.topics.singapore.affinity = 0.5;
  store.save(draft);
  const history = store.history();
  assert.deepEqual(history.map((h) => h.version), [2, 1]);
  assert.ok(!("profile" in history[0]));
});

test("getVersion returns a past snapshot unchanged, and throws for an unknown version", () => {
  const store = makeStore();
  const draft = store.current();
  draft.topics.singapore.affinity = 0.5;
  store.save(draft);
  assert.equal(store.getVersion(1).topics.singapore.affinity, 0.9);
  assert.equal(store.getVersion(2).topics.singapore.affinity, 0.5);
  assert.throws(() => store.getVersion(99), /no such profile version/);
});

test("revert is one tap and non-destructive: it appends a new version with the old content", () => {
  const store = makeStore();
  const draft = store.current();
  draft.topics.singapore.affinity = 0.5;
  store.save(draft); // version 2

  const result = store.revert(1);
  assert.equal(result.ok, true);
  assert.equal(result.profile.profile_version, 3);
  assert.equal(result.profile.topics.singapore.affinity, 0.9);
  // History is append only: nothing was lost by reverting.
  assert.deepEqual(store.history().map((h) => h.version), [3, 2, 1]);
  assert.equal(store.current().topics.singapore.affinity, 0.9);
});

test("store.diff matches diffProfiles between the two named versions", () => {
  const store = makeStore();
  const draft = store.current();
  draft.topics.singapore.affinity = 0.5;
  store.save(draft);
  const changes = store.diff(1, 2);
  assert.deepEqual(changes, [
    { path: "$.topics.singapore.affinity", kind: "changed", before: 0.9, after: 0.5 },
  ]);
});

test("mutating a profile returned by current() does not affect the stored version", () => {
  const store = makeStore();
  const profile = store.current();
  profile.topics.singapore.affinity = 0;
  assert.equal(store.current().topics.singapore.affinity, 0.9);
});
