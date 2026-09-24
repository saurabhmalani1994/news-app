import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateProfile, validateSchema, checkIntegrity } from "../../app/static/js/profile/validate.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const SCHEMA_PATH = fileURLToPath(new URL("../../app/static/profile.schema.json", import.meta.url));
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

test("the shipped default profile validates clean", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(validateProfile(profile, SCHEMA), []);
});

test("a missing required field is reported with its path", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  delete profile.trust;
  const errors = validateSchema(profile, SCHEMA);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\$: missing required field "trust"/);
});

test("an out-of-range affinity is rejected", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.topics.singapore.affinity = 1.5;
  const errors = validateSchema(profile, SCHEMA);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\$\.topics\.singapore\.affinity: above maximum 1/);
});

test("a wrong type is rejected with the expected and actual shape", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.topics.singapore.enabled = "yes";
  const errors = validateSchema(profile, SCHEMA);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected boolean, got string/);
});

test("an unknown field on a closed object is rejected", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.mutes.extra_field = true;
  const errors = validateSchema(profile, SCHEMA);
  assert.ok(errors.some((e) => e.includes("$.mutes.extra_field")));
});

test("topics is an open set: a new bucket the owner adds is schema valid", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.topics.climate = { label: "Climate", affinity: 0.4, half_life_hours: 24, enabled: true };
  assert.deepEqual(validateProfile(profile, SCHEMA), []);
});

test("checkIntegrity rejects a topic id that is not lowercase snake_case", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.topics["Not Valid"] = { label: "x", affinity: 0.1, half_life_hours: 24, enabled: true };
  const errors = checkIntegrity(profile);
  assert.ok(errors.some((e) => e.includes("topic id must be lowercase")));
});

test("checkIntegrity rejects a duplicate boost id", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.boosts = [
    { id: "b1", label: "One", match_type: "topic", match_value: "ai", amount: 0.1 },
    { id: "b1", label: "Two", match_type: "topic", match_value: "world", amount: 0.1 },
  ];
  const errors = checkIntegrity(profile);
  assert.ok(errors.some((e) => e.includes("duplicate boost id")));
});

test("checkIntegrity rejects a mute referencing a topic that does not exist", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.mutes.topics = ["not_a_real_topic"];
  const errors = checkIntegrity(profile);
  assert.ok(errors.some((e) => e.includes("is not a topic in this profile")));
});

test("validateProfile stops at schema errors and does not also run integrity checks", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  delete profile.trust; // schema error
  profile.mutes.topics = ["not_a_real_topic"]; // would also be an integrity error
  const errors = validateProfile(profile, SCHEMA);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing required field "trust"/);
});

test("an unsupported schema keyword raises SchemaError instead of silently passing", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  const badSchema = { type: "object", patternProperties: {} };
  assert.throws(() => validateSchema(profile, badSchema), /unsupported keywords/);
});
