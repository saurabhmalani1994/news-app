// S35 (R24): the one-file backup, and the strict validation an imported file is held to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { serializeBackup, backupFilename, BACKUP_VERSION } from "../../app/static/js/backup/serialize.js";
import { validateBackup, MAX_SAVED, MAX_HISTORY } from "../../app/static/js/backup/validate.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));
const NOW = "2026-09-26T12:00:00Z";

function savedRecord(id, time = NOW) {
  return { id, title: "A story", source: "Reuters", url: "https://example.com/a", image: null, time, has_body: false, article_id: id };
}
function historyRecord(id, time = NOW) {
  return { id, cluster_id: id, title: "A story", source: "Reuters", source_id: "reuters", url: "https://example.com/a", image: null, topics: [], article_id: id, time };
}

test("serializeBackup: format version, timestamp, profile and both history stores round-trip", () => {
  const profile = buildDefaultProfile(NOW);
  const backup = serializeBackup({ profile, saved: [savedRecord("s1")], history: { opened: [historyRecord("h1")], shown: [] }, now: NOW });
  assert.equal(backup.format_version, BACKUP_VERSION);
  assert.equal(backup.exported_at, NOW);
  assert.deepEqual(backup.profile, profile);
  assert.equal(backup.saved.length, 1);
  assert.equal(backup.history.opened.length, 1);
  assert.equal(backup.history.shown.length, 0);
});

test("serializeBackup: missing saved/history default to empty arrays, never throws", () => {
  const backup = serializeBackup({ profile: buildDefaultProfile(NOW), saved: undefined, history: undefined, now: NOW });
  assert.deepEqual(backup.saved, []);
  assert.deepEqual(backup.history, { opened: [], shown: [] });
});

test("backupFilename: almanac-backup-YYYY-MM-DD.json from the export time", () => {
  assert.equal(backupFilename("2026-09-26T23:59:00Z"), "almanac-backup-2026-09-26.json");
  assert.equal(backupFilename(new Date("2026-01-05T00:00:00Z")), "almanac-backup-2026-01-05.json");
});

function validBackup() {
  return serializeBackup({ profile: buildDefaultProfile(NOW), saved: [savedRecord("s1")], history: { opened: [historyRecord("h1")], shown: [historyRecord("h2")] }, now: NOW });
}

test("validateBackup: accepts a well-formed backup, arrays passed through unchanged", () => {
  const result = validateBackup(validBackup(), SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.data.saved.length, 1);
  assert.equal(result.data.history.opened.length, 1);
});

test("validateBackup: rejects the wrong format_version with a plain message", () => {
  const backup = { ...validBackup(), format_version: 99 };
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /version/i);
});

test("validateBackup: accepts a version 1 file with no archives field, defaulting to {}", () => {
  const backup = validBackup();
  backup.format_version = 1;
  delete backup.archives;
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.archives, {});
});

test("validateBackup: rejects a non-object entirely", () => {
  for (const bad of [null, undefined, "a string", 42, ["array"]]) {
    const result = validateBackup(bad, SCHEMA);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test("validateBackup: rejects a profile that fails the app's own schema", () => {
  const backup = validBackup();
  delete backup.profile.trust;
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /schema/i);
});

test("validateBackup: rejects a missing or garbage export timestamp", () => {
  for (const bad of [undefined, "", "not a date", 12345]) {
    const backup = { ...validBackup(), exported_at: bad };
    assert.equal(validateBackup(backup, SCHEMA).ok, false, JSON.stringify(bad));
  }
});

test("hostile: prototype-pollution keys at the top level are refused outright", () => {
  // JSON.parse gives __proto__ as a plain own key (CreateDataProperty, not the setter),
  // exactly as a hostile file on disk would carry it once parsed.
  const backup = JSON.parse(JSON.stringify(validBackup()).replace(/^\{/, '{"__proto__":{"polluted":true},'));
  assert.ok(Object.hasOwn(backup, "__proto__"), "the test fixture itself must carry it as an own key");
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(!Object.prototype.polluted, "Object.prototype must never be touched by validation itself");
});

test("hostile: a saved record carrying __proto__ or constructor as a field is refused", () => {
  const backup = validBackup();
  backup.saved = [JSON.parse('{"id":"s1","title":"a","source":"r","url":"https://x","time":"2026-09-26T00:00:00Z","__proto__":{"polluted":true}}')];
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(!Object.prototype.polluted);

  const backup2 = validBackup();
  backup2.saved = [{ ...savedRecord("s1"), constructor: "x" }];
  assert.equal(validateBackup(backup2, SCHEMA).ok, false);
});

test("hostile: an oversized saved array is refused with a plain count", () => {
  const backup = validBackup();
  backup.saved = Array.from({ length: MAX_SAVED + 1 }, (_, i) => savedRecord(`s${i}`));
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), new RegExp(String(MAX_SAVED)));
});

test("hostile: an oversized history array is refused", () => {
  const backup = validBackup();
  backup.history.opened = Array.from({ length: MAX_HISTORY + 1 }, (_, i) => historyRecord(`h${i}`));
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, false);
});

test("hostile: HTML in a title is accepted as plain text data (never sanitized here; the page never renders it as HTML)", () => {
  const backup = validBackup();
  backup.saved = [savedRecord("s1")];
  backup.saved[0].title = "<img src=x onerror=alert(1)>";
  const result = validateBackup(backup, SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.data.saved[0].title, "<img src=x onerror=alert(1)>", "kept as an inert string, R26's textContent rule is the page's job");
});

test("hostile: a saved record missing required fields is refused", () => {
  const backup = validBackup();
  backup.saved = [{ id: "s1" }];
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
});

test("hostile: a saved/history array that is not an array at all is refused", () => {
  const backup = validBackup();
  backup.saved = { id: "s1" };
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
  const backup2 = validBackup();
  backup2.history = "not an object";
  assert.equal(validateBackup(backup2, SCHEMA).ok, false);
});

test("hostile: a nested object where a flat string is expected is refused", () => {
  const backup = validBackup();
  backup.saved = [{ ...savedRecord("s1"), title: { toString: () => "safe" } }];
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
});

test("hostile: an oversized string field is refused", () => {
  const backup = validBackup();
  backup.saved = [{ ...savedRecord("s1"), title: "x".repeat(3000) }];
  assert.equal(validateBackup(backup, SCHEMA).ok, false);
});
