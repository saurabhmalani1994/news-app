// H2: profiles saved by older builds are migrated forward once, with every owner edit and
// every stored version kept (app/static/js/profile/migrate.js, ProfileStore's migrate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { migrateProfile } from "../../app/static/js/profile/migrate.js";
import { MemoryStorage, ProfileStore, STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { PASS_DEFAULTS } from "../../app/static/js/passes.js";
import { STANDING_DEFAULTS } from "../../app/static/js/standing.js";
import { LIVE_OVERRIDES_DEFAULTS } from "../../app/static/js/live.js";

const schema = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-24T12:00:00Z";
const clone = (x) => JSON.parse(JSON.stringify(x));

function s10(version = 3) {
  return {
    schema_version: 1, profile_version: version, updated_at: "2026-09-03T08:00:00Z",
    topics: {
      world: { label: "World", affinity: 0.7, half_life_hours: 5, enabled: true },
      must_know: { label: "Must-know", affinity: 0, half_life_hours: 8, enabled: true, floor_slots: 3 },
      climate: { label: "Climate", affinity: 0.75, half_life_hours: 36, enabled: true },
    },
    trust: { reuters: 0.9 },
    boosts: [{ id: "topic-climate", label: "Climate", match_type: "topic", match_value: "climate", amount: 0.3 }],
    mutes: { sources: ["dailymail"], topics: [] },
    seen_penalty: { opened: 1, shown: 0.1 },
  };
}
const SHAPES = {
  s10: s10(),
  s13: { ...s10(), passes: { ...clone(PASS_DEFAULTS), other_side: { per_page: 2 } } },
  s28: { ...s10(), passes: clone(PASS_DEFAULTS), standing_stories: clone(STANDING_DEFAULTS).map((s) => ({ ...s, silence_hours: 48 })) },
  s33: { ...s10(), passes: clone(PASS_DEFAULTS), standing_stories: clone(STANDING_DEFAULTS), live_overrides: { ...clone(LIVE_OVERRIDES_DEFAULTS), blocked_labels: ["Olympics"] } },
  unknown_topic: { ...s10(), topics: { ...s10().topics, space_weather: { label: "Space weather", affinity: 0.4, half_life_hours: 72, enabled: false } }, mutes: { sources: [], topics: ["space_weather"] } },
};
const ADDED = { s10: ["passes", "standing_stories", "live_overrides", "display"], s13: ["standing_stories", "live_overrides", "display"],
  s28: ["live_overrides", "display"], s33: ["display"], unknown_topic: ["passes", "standing_stories", "live_overrides", "display"] };

for (const [name, old] of Object.entries(SHAPES)) {
  test(`${name}: every missing field is added with its default, every owner edit kept`, () => {
    const { profile, added } = migrateProfile(old, NOW);
    assert.deepEqual(added, ADDED[name]);
    assert.deepEqual(validateProfile(profile, schema), []);
    for (const key of Object.keys(old)) assert.deepEqual(profile[key], old[key], key); // nothing the owner set changed
    const defaults = buildDefaultProfile(NOW);
    for (const key of added) assert.deepEqual(profile[key], defaults[key], key);
    assert.deepEqual(migrateProfile(profile, NOW).added, []); // already current: nothing more to do
  });

  test(`${name}: the store saves the migration once, as one new version, history untouched`, () => {
    const storage = new MemoryStorage();
    const history = [1, 2, 3].map((v) => ({ version: v, timestamp: `2026-09-0${v}T08:00:00Z`, profile: { ...clone(old), profile_version: v } }));
    storage.setItem(STORAGE_KEY, JSON.stringify({ history }));
    const store = new ProfileStore({ storage, schema, seedDefault: buildDefaultProfile, now: () => NOW, migrate: migrateProfile });
    const current = store.current();
    const saved = JSON.parse(storage.getItem(STORAGE_KEY)).history;
    assert.equal(saved.length, 4);
    assert.deepEqual(saved.slice(0, 3), history); // every older version byte for byte
    assert.equal(saved[3].version, 4);
    assert.match(saved[3].note, /^migration: /);
    assert.equal(current.profile_version, 4);
    assert.deepEqual(current.topics, old.topics);
    assert.deepEqual(current.boosts, old.boosts);
    // A second load (a new store on the same storage) finds nothing to migrate.
    const again = new ProfileStore({ storage, schema, seedDefault: buildDefaultProfile, now: () => NOW, migrate: migrateProfile });
    again.current();
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).history.length, 4);
    assert.equal(store.revert(3).ok, true); // a pre-migration version is still revertible
  });
}

test("a current profile is not re-saved", () => {
  const storage = new MemoryStorage();
  const store = new ProfileStore({ storage, schema, seedDefault: buildDefaultProfile, now: () => NOW, migrate: migrateProfile });
  store.current();
  assert.equal(store.history().length, 1);
});

test("partial sub-fields are filled, set ones kept", () => {
  const old = { ...s10(), passes: { lean_quota: { window: 12 } }, standing_stories: [{ id: "sudan", label: "Sudan", enabled: false }] };
  const { profile } = migrateProfile(old, NOW);
  assert.equal(profile.passes.lean_quota.window, 12);
  assert.equal(profile.passes.lean_quota.max_share, PASS_DEFAULTS.lean_quota.max_share);
  assert.deepEqual(profile.passes.exploration, PASS_DEFAULTS.exploration);
  const sudan = profile.standing_stories[0];
  assert.equal(sudan.enabled, false);
  assert.deepEqual(sudan.keywords, [...STANDING_DEFAULTS.find((s) => s.id === "sudan").keywords]);
  assert.deepEqual(validateProfile(profile, schema), []);
});

test("a profile that cannot be made valid is left as stored, nothing written", () => {
  const storage = new MemoryStorage();
  const bad = { ...s10(), topics: {} }; // minProperties 1: no migration can fix this
  const history = [{ version: 1, timestamp: NOW, profile: bad }];
  storage.setItem(STORAGE_KEY, JSON.stringify({ history }));
  const store = new ProfileStore({ storage, schema, seedDefault: buildDefaultProfile, now: () => NOW, migrate: migrateProfile });
  assert.deepEqual(store.current().topics, {});
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).history.length, 1);
});
