// S35 (R24): the one-file backup export. Everything the device keeps for the reader:
// the profile (interests, phrase interests, standing stories, source settings: the
// whole profile object ProfileStore holds, since profile.schema.json is already closed
// with additionalProperties: false, so nothing else lives there), saved stories, and
// history.
//
// Saved stories: ids plus metadata only, not bodies. A save's own record
// (actions/saves.js buildSaveSnapshot) already never carries the article body; the
// full text lives in the reader's own IndexedDB cache (S25, reader/cache.js), keyed
// separately and sized for a handful of days, not for an owner's whole saved list, and
// re-fetchable from the source's own URL when online. Exporting it would make an
// ordinary backup file arbitrarily large for no gain the owner asked for, so it is left
// out; the saved snapshot (id, title, source, url, image, time, has_body, article_id)
// is exported in full.
//
// History: both opened and shown stores (history/store.js), same snapshot shape
// (history/record.js buildHistorySnapshot), in full: DESIGN-v1.1 R23 already keeps this
// device only for up to a year, so a backup of it is exactly what R24 asks a manual
// export/import to cover.
//
// S35b: version 2 adds the per-follow Timeline archive (S30, follow-archive.js and
// follow-archive-store.js), left out of S35's own export by gap. Keyed by the same
// `kind:id` follow key S30 already uses (archiveKey), each value the follow's own item
// list exactly as stored (already capped to 30 days / 200 items by the live archive
// itself). A version 1 file simply has no `archives` field; validate.js treats that the
// same as an empty one rather than refusing an older file.
//
// B11: version 3 carries the profile's work watch rules (work-watch.js) like any other
// profile field, and adds an optional `scope`. A whole backup has none (or "all"). A
// file with scope "work_watch" holds only {profile: {work_watch: [...]}}: importing it
// replaces the work rules alone and leaves every other interest, saved story, history
// entry and timeline as it is (validate.js, merge.js withWorkImported). Versions 1 and
// 2 still import.

export const BACKUP_VERSION = 3;
export const WORK_SCOPE = "work_watch";

/** almanac-backup-YYYY-MM-DD.json, the date from `now` (an ISO string or a Date). */
export function backupFilename(now) {
  const date = now instanceof Date ? now : new Date(now);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  return `almanac-backup-${iso.slice(0, 10)}.json`;
}

/**
 * @param {object} args
 * @param {object} args.profile - the current profile (ProfileStore#current()).
 * @param {Array} args.saved - saves store records (actions/store.js savesStore.list()).
 * @param {{opened: Array, shown: Array}} args.history - history store records
 *   (history/store.js openedStore/shownStore .list()).
 * @param {Object.<string, Array>} [args.archives] - the Timeline archive, keyed by
 *   follow (follow-archive.js archiveKey), each value that follow's item list
 *   (followArchiveStore.get(key).items). Missing or not an object exports as {}.
 * @param {Function|string} [args.now] - nowIso() or an ISO string, for deterministic tests.
 */
/** B11: a work watch only file: the rules and nothing else. */
export function serializeWorkBackup({ rules, now }) {
  const exportedAt = typeof now === "function" ? now() : now || new Date().toISOString();
  return { format_version: BACKUP_VERSION, exported_at: exportedAt, scope: WORK_SCOPE, profile: { work_watch: Array.isArray(rules) ? rules : [] } };
}

export function serializeBackup({ profile, saved, history, archives, now }) {
  const exportedAt = typeof now === "function" ? now() : now || new Date().toISOString();
  return {
    format_version: BACKUP_VERSION,
    exported_at: exportedAt,
    profile,
    saved: Array.isArray(saved) ? saved : [],
    history: {
      opened: Array.isArray(history?.opened) ? history.opened : [],
      shown: Array.isArray(history?.shown) ? history.shown : [],
    },
    archives: archives && typeof archives === "object" && !Array.isArray(archives) ? archives : {},
  };
}
