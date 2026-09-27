// S35b: the Timeline archive (S30, follow-archive.js) joins the one-file backup at
// format version 2. Export carries it keyed by follow; validate holds it to the same
// strictness as everything else (known keys, caps, no dangerous keys, R26 text only);
// merge unions per follow by story id, keeps the newer, then prunes exactly as the live
// archive does, and drops a follow the imported profile no longer has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { serializeBackup, BACKUP_VERSION } from "../../app/static/js/backup/serialize.js";
import { validateBackup, MAX_ARCHIVE_FOLLOWS } from "../../app/static/js/backup/validate.js";
import { mergeArchiveById, mergeArchives, importCounts, confirmMessage } from "../../app/static/js/backup/merge.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { ARCHIVE_MAX_ITEMS } from "../../app/static/js/follow-archive.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-26T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

function item(id, hoursAgo, extra = {}) {
  return {
    id, title: "A story", outlet: "Wire", time: new Date(NOW_MS - hoursAgo * 3_600_000).toISOString(),
    markers: { lean: "center", country: "US" }, url: "https://example.com/x", ...extra,
  };
}

function validBackup(archives = {}) {
  return serializeBackup({ profile: buildDefaultProfile(NOW), saved: [], history: { opened: [], shown: [] }, archives, now: NOW });
}

test("serializeBackup: version 2 and later (3 since B11), archives keyed by follow round-trips", () => {
  const backup = serializeBackup({
    profile: buildDefaultProfile(NOW), saved: [], history: { opened: [], shown: [] },
    archives: { "phrase:p1": [item("s1", 1)] }, now: NOW,
  });
  assert.equal(backup.format_version, 3); // B11 bumped 2 to 3; archives still ride along
  assert.equal(BACKUP_VERSION, 3);
  assert.deepEqual(backup.archives["phrase:p1"], [item("s1", 1)]);
});

test("serializeBackup: a missing or non-object archives argument exports as {}", () => {
  assert.deepEqual(serializeBackup({ profile: buildDefaultProfile(NOW), saved: [], history: {}, now: NOW }).archives, {});
  assert.deepEqual(serializeBackup({ profile: buildDefaultProfile(NOW), saved: [], history: {}, archives: ["not", "an", "object"], now: NOW }).archives, {});
});

test("validateBackup: accepts a well-formed archives object, arrays passed through", () => {
  const backup = validBackup({ "phrase:p1": [item("s1", 1)], "story:sudan": [item("s2", 2)] });
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.data.archives["phrase:p1"].length, 1);
  assert.equal(result.data.archives["story:sudan"].length, 1);
});

test("validateBackup: a version 1 file with no archives field is accepted, archives reads as {}", () => {
  const backup = validBackup();
  backup.format_version = 1;
  delete backup.archives;
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.archives, {});
});

test("hostile: archives that is not a plain object is refused", () => {
  for (const bad of [["array"], "a string", 42]) {
    const backup = validBackup();
    backup.archives = bad;
    assert.equal(validateBackup(backup, SCHEMA).ok, false, JSON.stringify(bad));
  }
});

test("hostile: __proto__ on the archives object itself is refused", () => {
  const backup = validBackup();
  backup.archives = JSON.parse('{"__proto__":{"polluted":true},"phrase:p1":[]}');
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(!Object.prototype.polluted);
});

test("hostile: a follow key that is not phrase:<id> or story:<id> is refused", () => {
  for (const key of ["p1", "phrase:", "topic:p1", "phrase:" + "x".repeat(200), "__proto__:x"]) {
    const backup = validBackup({ [key]: [item("s1", 1)] });
    assert.equal(validateBackup(backup, SCHEMA).ok, false, key);
  }
});

test("hostile: a follow's item carrying __proto__ or an unknown key is refused", () => {
  const backup = validBackup();
  backup.archives = { "phrase:p1": [JSON.parse('{"id":"s1","title":"a","outlet":"o","time":"2026-09-26T00:00:00Z","markers":{"lean":"","country":""},"url":"https://x","__proto__":{"polluted":true}}')] };
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
  assert.ok(!Object.prototype.polluted);

  const backup2 = validBackup({ "phrase:p1": [{ ...item("s1", 1), extra: "nope" }] });
  assert.equal(validateBackup(backup2, SCHEMA).ok, false);
});

test("hostile: a follow's item missing a required key, or with a bad markers object, is refused", () => {
  const missing = validBackup({ "phrase:p1": [{ id: "s1", title: "a", time: "2026-09-26T00:00:00Z" }] });
  assert.equal(validateBackup(missing, SCHEMA).ok, false);

  const badMarkers = validBackup({ "phrase:p1": [{ ...item("s1", 1), markers: { lean: "center", country: "US", extra: "x" } }] });
  assert.equal(validateBackup(badMarkers, SCHEMA).ok, false);

  const badTime = validBackup({ "phrase:p1": [{ ...item("s1", 1), time: "not a date" }] });
  assert.equal(validateBackup(badTime, SCHEMA).ok, false);
});

test("hostile: an oversized per-follow archive is refused with a plain count", () => {
  const backup = validBackup({ "phrase:p1": Array.from({ length: ARCHIVE_MAX_ITEMS + 1 }, (_, i) => item(`s${i}`, 1)) });
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), new RegExp(String(ARCHIVE_MAX_ITEMS)));
});

test("hostile: too many followed keys at once is refused with a plain count", () => {
  const archives = {};
  for (let i = 0; i < MAX_ARCHIVE_FOLLOWS + 1; i++) archives[`phrase:p${i}`] = [];
  const backup = validBackup(archives);
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), new RegExp(String(MAX_ARCHIVE_FOLLOWS)));
});

test("hostile: an oversized string field inside an item is refused", () => {
  const backup = validBackup({ "phrase:p1": [{ ...item("s1", 1), title: "x".repeat(3000) }] });
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
});

test("mergeArchiveById: a new id is added, an older file copy is kept as-is, a newer file copy wins", () => {
  const current = [item("a", 5), item("b", 1)]; // b is newer (fewer hours ago)
  const imported = [item("a", 10), item("b", 0.5), item("c", 2)];
  const { merged, added, updated } = mergeArchiveById(current, imported);
  assert.equal(added, 1); // c
  assert.equal(updated, 1); // b (imported is newer)
  assert.equal(merged.find((r) => r.id === "a").time, item("a", 5).time); // file's older "a" loses
  assert.equal(merged.find((r) => r.id === "b").time, item("b", 0.5).time); // file's newer "b" wins
});

test("mergeArchives: unions per follow, prunes to 30 days / 200 items, and drops a follow the profile no longer has", () => {
  const current = new Map([
    ["phrase:p1", [item("old", 40 * 24)]], // older than 30 days, will be pruned regardless
    ["phrase:p1_dup", [item("keep", 1)]],
  ]);
  const imported = {
    "phrase:p1": [item("new", 1)],
    "story:gone": [item("stale", 1)], // not in liveKeys: dropped entirely
  };
  const liveKeys = new Set(["phrase:p1", "phrase:p1_dup"]);
  const result = mergeArchives(current, imported, liveKeys, NOW_MS);
  const keys = result.toWrite.map((w) => w.key);
  assert.ok(keys.includes("phrase:p1"));
  assert.ok(!keys.includes("story:gone"), "a follow missing from liveKeys is never written back");
  const p1 = result.toWrite.find((w) => w.key === "phrase:p1").items;
  assert.deepEqual(p1.map((r) => r.id), ["new"], "the 40-day-old record is pruned away");
  assert.equal(result.timelineDelta, 1); // only "new" is added; p1_dup is untouched (nothing imported for it)
});

test("mergeArchives: an empty imported archives object writes nothing and has zero delta", () => {
  const result = mergeArchives(new Map(), {}, new Set(["phrase:p1"]), NOW_MS);
  assert.deepEqual(result.toWrite, []);
  assert.equal(result.timelineDelta, 0);
});

test("mergeArchives caps a busy follow to 200 items after merging", () => {
  const current = new Map([["phrase:busy", Array.from({ length: 150 }, (_, i) => item(`c${i}`, 1))]]);
  const imported = { "phrase:busy": Array.from({ length: 100 }, (_, i) => item(`n${i}`, 0.5)) };
  const result = mergeArchives(current, imported, new Set(["phrase:busy"]), NOW_MS);
  assert.equal(result.toWrite[0].items.length, ARCHIVE_MAX_ITEMS);
});

test("importCounts and confirmMessage: a nonzero timeline delta is named in the confirm", () => {
  const profile = buildDefaultProfile(NOW);
  const savedMerge = { added: 0, updated: 0 };
  const emptyMerge = { added: 0, updated: 0 };
  const archiveMerge = { timelineDelta: 7 };
  const counts = importCounts(profile, savedMerge, emptyMerge, emptyMerge, archiveMerge);
  assert.equal(counts.timelineDelta, 7);
  assert.match(confirmMessage(counts), /timeline \+7$/);
});

test("importCounts and confirmMessage: no archiveMerge argument reads exactly as before (no timeline mention)", () => {
  const profile = buildDefaultProfile(NOW);
  const emptyMerge = { added: 0, updated: 0 };
  const counts = importCounts(profile, emptyMerge, emptyMerge, emptyMerge);
  assert.equal(counts.timelineDelta, 0);
  assert.ok(!confirmMessage(counts).includes("timeline"));
});
