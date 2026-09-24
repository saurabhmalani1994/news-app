import { test } from "node:test";
import assert from "node:assert/strict";

import { nowIso } from "../../app/static/js/profile/time.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateSchema } from "../../app/static/js/profile/validate.js";
import { readFileSync } from "node:fs";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"),
);
const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

// Regression: Date#toISOString() includes milliseconds, which utc_timestamp's pattern
// in profile.schema.json rejects. Caught by hand in the browser (the real default
// clock, not a test's injected one, produced an unsaveable profile); every other test
// injects a fixed timestamp so this path went otherwise unexercised.
test("nowIso has no milliseconds and matches the schema's utc_timestamp pattern", () => {
  assert.match(nowIso(), UTC_TIMESTAMP);
});

test("buildDefaultProfile's own default clock also produces a schema-valid timestamp", () => {
  const profile = buildDefaultProfile();
  assert.deepEqual(validateSchema(profile, SCHEMA), []);
});
