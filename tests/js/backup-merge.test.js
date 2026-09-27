// S35 (R24): saved and history union by story id, newer entry wins.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeById, importCounts, confirmMessage } from "../../app/static/js/backup/merge.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const rec = (id, time) => ({ id, title: `story ${id}`, time });

test("mergeById: a new id from the file is added", () => {
  const current = [rec("a", "2026-09-01T00:00:00Z")];
  const imported = [rec("b", "2026-09-02T00:00:00Z")];
  const result = mergeById(current, imported);
  assert.equal(result.merged.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.toWrite, [rec("b", "2026-09-02T00:00:00Z")]);
});

test("mergeById: the same id, file's copy older, is kept as-is and not rewritten", () => {
  const current = [rec("a", "2026-09-05T00:00:00Z")];
  const imported = [rec("a", "2026-09-01T00:00:00Z")];
  const result = mergeById(current, imported);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].time, "2026-09-05T00:00:00Z");
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.toWrite.length, 0);
});

test("mergeById: the same id, file's copy newer, replaces it and is queued to write", () => {
  const current = [rec("a", "2026-09-01T00:00:00Z")];
  const imported = [rec("a", "2026-09-05T00:00:00Z")];
  const result = mergeById(current, imported);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].time, "2026-09-05T00:00:00Z");
  assert.equal(result.updated, 1);
  assert.equal(result.toWrite.length, 1);
});

test("mergeById: empty current, everything from the file is added", () => {
  const result = mergeById([], [rec("a", "2026-09-01T00:00:00Z"), rec("b", "2026-09-02T00:00:00Z")]);
  assert.equal(result.merged.length, 2);
  assert.equal(result.added, 2);
});

test("mergeById: empty file, current is untouched and nothing is queued", () => {
  const current = [rec("a", "2026-09-01T00:00:00Z")];
  const result = mergeById(current, []);
  assert.deepEqual(result.merged, current);
  assert.equal(result.toWrite.length, 0);
});

test("importCounts and confirmMessage: the brief's own example shape", () => {
  const profile = buildDefaultProfile("2026-09-26T00:00:00Z");
  for (let i = 0; i < 12; i++) profile.topics[`t${i}`] = { label: `T${i}`, affinity: 0.5, half_life_hours: 24, enabled: true };
  const savedMerge = { added: 4, updated: 0 };
  const openedMerge = { added: 20, updated: 5 };
  const shownMerge = { added: 6, updated: 0 };
  const counts = importCounts(profile, savedMerge, openedMerge, shownMerge);
  assert.equal(counts.interestCount, Object.keys(profile.topics).length);
  assert.equal(counts.savedDelta, 4);
  assert.equal(counts.historyDelta, 31);
  assert.equal(confirmMessage(counts), `Replace your interests with ${counts.interestCount} from the file? Saved +4, history +31`);
});
