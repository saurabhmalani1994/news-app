import { test } from "node:test";
import assert from "node:assert/strict";

import { diffProfiles, formatDiff } from "../../app/static/js/profile/diff.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

test("no changes between a profile and its own clone", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = structuredClone(a);
  assert.deepEqual(diffProfiles(a, b), []);
});

test("meta fields (profile_version, updated_at) are excluded by default", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = { ...structuredClone(a), profile_version: 2, updated_at: "2026-09-25T00:00:00Z" };
  assert.deepEqual(diffProfiles(a, b), []);
  assert.equal(diffProfiles(a, b, { includeMeta: true }).length, 2);
});

test("a changed scalar field reports before and after", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = structuredClone(a);
  b.topics.singapore.affinity = 0.95;
  const changes = diffProfiles(a, b);
  assert.deepEqual(changes, [
    { path: "$.topics.singapore.affinity", kind: "changed", before: 0.9, after: 0.95 },
  ]);
});

test("a newly added topic bucket is reported as added", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = structuredClone(a);
  b.topics.climate = { label: "Climate", affinity: 0.3, half_life_hours: 24, enabled: true };
  const changes = diffProfiles(a, b);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "added");
  assert.equal(changes[0].path, "$.topics.climate");
});

test("a removed topic bucket is reported as removed", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = structuredClone(a);
  delete b.topics.ai;
  const changes = diffProfiles(a, b);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "removed");
  assert.equal(changes[0].path, "$.topics.ai");
});

test("boosts diff by id, not by array position", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  a.boosts = [{ id: "b1", label: "One", match_type: "topic", match_value: "ai", amount: 0.1 }];
  const b = structuredClone(a);
  b.boosts[0].amount = 0.2;
  b.boosts.push({ id: "b2", label: "Two", match_type: "keyword", match_value: "midterm", amount: 0.15 });
  const changes = diffProfiles(a, b);
  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ["$.boosts[b1].amount", "$.boosts[b2]"]);
});

test("mute lists diff as sets: order never produces a spurious change", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  a.mutes.sources = ["example.com", "wire.example.org"];
  const b = structuredClone(a);
  b.mutes.sources = ["wire.example.org", "example.com"];
  assert.deepEqual(diffProfiles(a, b), []);
});

test("mute list additions and removals are both reported", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  a.mutes.sources = ["example.com"];
  const b = structuredClone(a);
  b.mutes.sources = ["other.example.com"];
  const changes = diffProfiles(a, b);
  assert.equal(changes.length, 2);
  assert.ok(changes.some((c) => c.kind === "added" && c.after === "other.example.com"));
  assert.ok(changes.some((c) => c.kind === "removed" && c.before === "example.com"));
});

test("formatDiff renders one readable line per change", () => {
  const a = buildDefaultProfile("2026-09-24T00:00:00Z");
  const b = structuredClone(a);
  b.topics.singapore.affinity = 0.95;
  const lines = formatDiff(diffProfiles(a, b));
  assert.deepEqual(lines, ["topics.singapore.affinity: 0.9 -> 0.95"]);
});
