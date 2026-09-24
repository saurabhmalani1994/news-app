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

// S37 regression: the S10 validator looked up property names with `in`, which sees
// Object.prototype, so a key named like a prototype member passed a closed object
// unchecked (found by S19). Every one of these must now be rejected.
const PROTOTYPE_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"];

test("prototype member names are unknown keys in a closed object, at the top level and nested", () => {
  for (const name of PROTOTYPE_NAMES) {
    const top = buildDefaultProfile("2026-09-24T00:00:00Z");
    Object.defineProperty(top, name, { value: 5, enumerable: true, configurable: true, writable: true });
    assert.ok(validateSchema(top, SCHEMA).some((e) => e.includes(`$.${name}: not allowed`)), `top-level ${name}`);

    const nested = JSON.parse(JSON.stringify(buildDefaultProfile("2026-09-24T00:00:00Z")));
    Object.defineProperty(nested.topics.singapore, name, { value: "x", enumerable: true, configurable: true, writable: true });
    assert.ok(validateSchema(nested, SCHEMA).some((e) => e.includes(`$.topics.singapore.${name}: not allowed`)), `nested ${name}`);
  }
});

test("a JSON-parsed __proto__ key is an unknown key, not a prototype swap", () => {
  const raw = JSON.stringify(buildDefaultProfile("2026-09-24T00:00:00Z")).replace(/^\{/, '{"__proto__":{"x":1},');
  const errors = validateSchema(JSON.parse(raw), SCHEMA);
  assert.ok(errors.some((e) => e.includes("$.__proto__: not allowed")));
});

test("a required field is present only as an own key, never through the prototype", () => {
  const schema = { type: "object", required: ["toString", "constructor"], properties: {} };
  const errors = validateSchema({}, schema);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /missing required field "toString"/);
});

test("a muted topic named like a prototype member is not a topic in this profile", () => {
  const profile = buildDefaultProfile("2026-09-24T00:00:00Z");
  profile.mutes.topics = ["constructor", "toString"];
  const errors = checkIntegrity(profile);
  assert.equal(errors.filter((e) => e.includes("is not a topic in this profile")).length, 2);
});
