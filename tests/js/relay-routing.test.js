// F3 proof: the relay Worker's pure routing logic, the part that decides the allowlist
// shape without a network call. The Worker's full fetch handler needs a live Workers
// runtime (exercised for real by the deploy-relay workflow and the fetch-through-relay
// job), so this test covers what node --test can check directly: which source ids are
// allowed, and that anything off that exact list resolves to nothing (404 territory).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ALLOWLIST, sourceIdFromPath } from "../../relay/worker.js";

test("allowlist holds exactly the four blocked feeds, nothing else", () => {
  assert.deepEqual(Object.keys(ALLOWLIST).sort(), [
    "import_ai",
    "indian_express",
    "middle_east_eye",
    "times_of_israel",
  ]);
  for (const url of Object.values(ALLOWLIST)) {
    assert.match(url, /^https:\/\//);
  }
});

test("sourceIdFromPath resolves /feed/<id> for an allowlisted id", () => {
  assert.equal(sourceIdFromPath("/feed/times_of_israel"), "times_of_israel");
  assert.equal(sourceIdFromPath("/feed/import_ai"), "import_ai");
});

test("sourceIdFromPath extracts an id even off the allowlist; the caller 404s it", () => {
  assert.equal(sourceIdFromPath("/feed/npr"), "npr");
  assert.equal(ALLOWLIST["npr"], undefined);
});

test("sourceIdFromPath returns null for paths that are not /feed/<id> at all", () => {
  assert.equal(sourceIdFromPath("/"), null);
  assert.equal(sourceIdFromPath("/feed/"), null);
  assert.equal(sourceIdFromPath("/feed/times_of_israel/extra"), null);
  assert.equal(sourceIdFromPath("/other/times_of_israel"), null);
});
