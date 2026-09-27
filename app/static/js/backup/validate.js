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

export const MAX_SAVED = 20_000;
export const MAX_HISTORY = 50_000;
export const MAX_STRING = 2000;

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

/**
 * Strictly validates a parsed backup file. Returns {ok: true, data} with `data` the
 * same object (never mutated) on success, or {ok: false, errors} with plain-English
 * reasons on failure. `schema` is profile.schema.json, already parsed (the same one
 * ProfileStore validates a save against), so an imported profile is held to exactly the
 * rules a normal edit is.
 */
export function validateBackup(data, schema) {
  const errors = [];
  if (!plainObject(data)) return { ok: false, errors: ["Not a backup file: expected a JSON object."] };
  if (hasDangerousKey(data)) return { ok: false, errors: ["Not a backup file: unsafe field names."] };
  if (data.format_version !== 1) {
    errors.push(`Unknown backup version ${JSON.stringify(data.format_version)}. This build reads version 1.`);
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
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { format_version: 1, exported_at: data.exported_at, profile: data.profile, saved, history: { opened, shown } } };
}
