// S35 (R24): strict validation for an imported backup file. Feed content is hostile
// input (R26); an imported *file* is worse, since the owner picks it off disk and it
// could be anything, from a stray download to something deliberately hostile. Nothing
// here is ever rendered as HTML (the You page draws every field through textContent,
// same as every other feed-sourced string, R26); this module's job is only to keep a
// malformed or oversized file from wedging the merge or the store underneath it.
//
// checkIntegrity-style, not a JSON Schema: the shape is small and fixed, and the
// dangerous cases (huge arrays, prototype-pollution keys, wrong types) are easier to
// name directly than to express as a schema someone has to keep in sync with this file.

import { validateProfile } from "../profile/validate.js";
import { buildDefaultProfile } from "../profile/default-profile.js";
import { ARCHIVE_MAX_ITEMS } from "../follow-archive.js";

export const MAX_SAVED = 20_000;
export const MAX_HISTORY = 50_000;
export const MAX_STRING = 2000;
// S35b: the Timeline archive (S30, follow-archive.js), added to the backup at version
// 2. A follow's own item list is already capped to ARCHIVE_MAX_ITEMS live, so an
// imported list past that cap is refused outright rather than silently truncated, the
// same "reject, don't repair" stance every other array here takes; the real 30-day
// prune runs again at merge time (backup/merge.js), same as the live archive.
export const MAX_ARCHIVE_FOLLOWS = 2000;
const ARCHIVE_KEY_RE = /^(phrase|story):[A-Za-z0-9_-]{1,150}$/;
const ARCHIVE_ITEM_KEYS = ["id", "title", "outlet", "time", "markers", "url"];
const MARKER_KEYS = ["lean", "country"];

// Own-key checks throughout (Object.hasOwn), never `in` or bracket reads that could
// walk the prototype chain (profile/validate.js's own comment on this, S37): a key
// named __proto__, constructor or prototype is refused outright rather than merged in,
// so an imported file can never widen what a later `for...in` or a careless `{...x}`
// spread would see on Object.prototype.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDangerousKey(value) {
  if (!plainObject(value)) return false;
  return Object.keys(value).some((k) => DANGEROUS_KEYS.has(k));
}

function isShortString(value, max = MAX_STRING) {
  return typeof value === "string" && value.length <= max;
}

const MAX_TOPICS = 50;

/** One saved or history record: every field the app writes is a plain string, number,
 * boolean or null, or (history's own `topics`) a short array of short strings, nothing
 * else nested, so a hostile object (or one carrying __proto__ as a field) is refused
 * rather than partly trusted. */
function validRecord(record, requiredKeys) {
  if (!plainObject(record) || hasDangerousKey(record)) return false;
  if (!requiredKeys.every((k) => Object.hasOwn(record, k))) return false;
  if (!isShortString(record.id, 200)) return false;
  for (const [key, value] of Object.entries(record)) {
    if (DANGEROUS_KEYS.has(key)) return false;
    if (value === null) continue;
    if (typeof value === "string" && value.length > MAX_STRING) return false;
    if (Array.isArray(value)) {
      if (value.length > MAX_TOPICS || !value.every((v) => isShortString(v, 200))) return false;
      continue;
    }
    if (typeof value === "object") return false; // everything else here is flat
  }
  return true;
}

function validateRecordArray(list, label, requiredKeys, max, errors) {
  if (!Array.isArray(list)) { errors.push(`${label}: expected an array`); return []; }
  if (list.length > max) { errors.push(`${label}: ${list.length} entries, more than ${max} allowed`); return []; }
  const bad = list.filter((r) => !validRecord(r, requiredKeys));
  if (bad.length) errors.push(`${label}: ${bad.length} entries have the wrong shape`);
  return list;
}

/** One Timeline card snapshot (follow-archive.js snapshotFromStory): known keys only
 * (id, title, outlet, time, markers, url), every string short and flat, `markers` a
 * plain {lean, country} object with nothing else in it, `time` a real date. */
function validArchiveItem(item) {
  if (!plainObject(item) || hasDangerousKey(item)) return false;
  const keys = Object.keys(item);
  if (!keys.every((k) => ARCHIVE_ITEM_KEYS.includes(k))) return false;
  if (!ARCHIVE_ITEM_KEYS.every((k) => Object.hasOwn(item, k))) return false;
  if (!isShortString(item.id, 200)) return false;
  if (!isShortString(item.time, 100) || Number.isNaN(Date.parse(item.time))) return false;
  if (!isShortString(item.title)) return false;
  if (!isShortString(item.outlet)) return false;
  if (!isShortString(item.url)) return false;
  if (!plainObject(item.markers) || hasDangerousKey(item.markers)) return false;
  const markerKeys = Object.keys(item.markers);
  if (!markerKeys.every((k) => MARKER_KEYS.includes(k))) return false;
  if (!isShortString(item.markers.lean, 100)) return false;
  if (!isShortString(item.markers.country, 100)) return false;
  return true;
}

/** The Timeline archive object, keyed by follow (`"phrase:<id>"` or `"story:<id>"`,
 * follow-archive.js archiveKey). Absent entirely reads as `{}` (a version 1 file, or a
 * version 2 file that happened to have nothing to archive yet), never an error: R24's
 * own "import must still accept the previous version" rule. Present, it is held to the
 * same strictness as everything else: a plain object, known-shaped keys, each value a
 * capped array of known-shaped items; one bad key or one bad item refuses the whole
 * file rather than importing part of it. */
function validateArchives(data, errors) {
  if (data.archives === undefined) return {};
  if (!plainObject(data.archives) || hasDangerousKey(data.archives)) {
    errors.push("archives: expected an object keyed by follow.");
    return {};
  }
  const keys = Object.keys(data.archives);
  if (keys.length > MAX_ARCHIVE_FOLLOWS) {
    errors.push(`archives: ${keys.length} follows, more than ${MAX_ARCHIVE_FOLLOWS} allowed`);
    return {};
  }
  const result = {};
  for (const key of keys) {
    if (!ARCHIVE_KEY_RE.test(key)) { errors.push(`archives: invalid follow key ${JSON.stringify(key)}`); continue; }
    const list = data.archives[key];
    if (!Array.isArray(list)) { errors.push(`archives.${key}: expected an array`); continue; }
    if (list.length > ARCHIVE_MAX_ITEMS) { errors.push(`archives.${key}: ${list.length} entries, more than ${ARCHIVE_MAX_ITEMS} allowed`); continue; }
    if (!list.every(validArchiveItem)) { errors.push(`archives.${key}: entries have the wrong shape`); continue; }
    result[key] = list;
  }
  return result;
}

/**
 * Strictly validates a parsed backup file. Returns {ok: true, data} with `data` the
 * same object (never mutated) on success, or {ok: false, errors} with plain-English
 * reasons on failure. `schema` is profile.schema.json, already parsed (the same one
 * ProfileStore validates a save against), so an imported profile is held to exactly the
 * rules a normal edit is.
 */
/** B11: a work watch only file (serialize.js serializeWorkBackup): version 3, scope
 * "work_watch", a profile holding work_watch and nothing else, and no saved, history or
 * archives at all. The rules are held to profile.schema.json by checking them inside a
 * default profile, the same rules a You-page edit meets. */
function validateWorkBackup(data, schema) {
  const errors = [];
  const allowed = ["format_version", "exported_at", "scope", "profile"];
  if (Object.keys(data).some((k) => !allowed.includes(k))) errors.push("A work watch file holds only its rules.");
  if (!isShortString(data.exported_at, 100) || Number.isNaN(new Date(data.exported_at).getTime())) {
    errors.push("Missing or invalid export timestamp.");
  }
  const profile = data.profile;
  if (!plainObject(profile) || hasDangerousKey(profile) || Object.keys(profile).join() !== "work_watch" || !Array.isArray(profile.work_watch)) {
    errors.push("A work watch file's profile holds work_watch only.");
  } else if (schema) {
    const trial = { ...buildDefaultProfile("2026-01-01T00:00:00Z"), work_watch: profile.work_watch };
    const profileErrors = validateProfile(trial, schema);
    if (profileErrors.length) errors.push(`Work rules do not match the app's schema: ${profileErrors[0]}`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { format_version: 3, exported_at: data.exported_at, scope: "work_watch", profile: { work_watch: profile.work_watch }, saved: [], history: { opened: [], shown: [] }, archives: {} } };
}

export function validateBackup(data, schema) {
  const errors = [];
  if (!plainObject(data)) return { ok: false, errors: ["Not a backup file: expected a JSON object."] };
  if (hasDangerousKey(data)) return { ok: false, errors: ["Not a backup file: unsafe field names."] };
  if (![1, 2, 3].includes(data.format_version)) {
    errors.push(`Unknown backup version ${JSON.stringify(data.format_version)}. This build reads versions 1 to 3.`);
  }
  if (data.scope !== undefined) {
    if (data.format_version !== 3 || !["all", "work_watch"].includes(data.scope)) return { ok: false, errors: ["Unknown backup scope."] };
    if (data.scope === "work_watch") return validateWorkBackup(data, schema);
  }
  if (!isShortString(data.exported_at, 100) || Number.isNaN(new Date(data.exported_at).getTime())) {
    errors.push("Missing or invalid export timestamp.");
  }
  if (!plainObject(data.profile) || hasDangerousKey(data.profile)) {
    errors.push("Missing or invalid profile.");
  } else if (schema) {
    const profileErrors = validateProfile(data.profile, schema);
    if (profileErrors.length) errors.push(`Profile does not match the app's schema: ${profileErrors[0]}`);
  }
  const saved = validateRecordArray(data.saved, "saved", ["id", "title", "source", "url", "time"], MAX_SAVED, errors);
  const historyOk = plainObject(data.history) && !hasDangerousKey(data.history);
  if (!historyOk) errors.push("history: expected an object with opened and shown arrays.");
  const opened = historyOk ? validateRecordArray(data.history.opened, "history.opened", ["id", "time"], MAX_HISTORY, errors) : [];
  const shown = historyOk ? validateRecordArray(data.history.shown, "history.shown", ["id", "time"], MAX_HISTORY, errors) : [];
  const archives = validateArchives(data, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { format_version: data.format_version, exported_at: data.exported_at, profile: data.profile, saved, history: { opened, shown }, archives } };
}
