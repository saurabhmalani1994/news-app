import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDefaultProfile, STARTER_TOPICS } from "../../app/static/js/profile/default-profile.js";

test("the default profile seeds exactly the six OWNER-BRIEF buckets", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(
    Object.keys(profile.topics).sort(),
    ["ai", "industrial_biotech", "must_know", "singapore", "us_politics", "world"].sort(),
  );
});

test("must_know's affinity is zeroed and it carries a floor", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(profile.topics.must_know.affinity, 0);
  assert.ok(profile.topics.must_know.floor_slots > 0);
});

test("half-lives match DESIGN-v1.1 R18: 8h world/us_politics/must_know, 12h singapore, 48h ai/biotech", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(profile.topics.world.half_life_hours, 8);
  assert.equal(profile.topics.us_politics.half_life_hours, 8);
  assert.equal(profile.topics.must_know.half_life_hours, 8);
  assert.equal(profile.topics.singapore.half_life_hours, 12);
  assert.equal(profile.topics.ai.half_life_hours, 48);
  assert.equal(profile.topics.industrial_biotech.half_life_hours, 48);
});

test("starts at profile_version 1 and stamps the given timestamp", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(profile.profile_version, 1);
  assert.equal(profile.updated_at, "2026-09-24T00:00:00Z");
});

test("defaults to the current time when no timestamp is given", () => {
  // nowIso() truncates to whole seconds (schema requires second precision, no
  // milliseconds), so the stamped value can read up to a second behind Date.now().
  const before = Date.now();
  const profile = buildDefaultProfile();
  const after = Date.now();
  const stamped = Date.parse(profile.updated_at);
  assert.ok(stamped >= before - 1000 && stamped <= after);
});

test("mutating the returned profile does not mutate the STARTER_TOPICS template", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.topics.singapore.affinity = 0;
  assert.equal(STARTER_TOPICS.singapore.affinity, 0.9);
});

test("trust starts empty: no per-domain overrides until the owner sets one", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(profile.trust, {});
});
