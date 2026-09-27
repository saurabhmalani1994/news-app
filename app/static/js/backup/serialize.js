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

export const BACKUP_VERSION = 1;

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
 * @param {Function|string} [args.now] - nowIso() or an ISO string, for deterministic tests.
 */
export function serializeBackup({ profile, saved, history, now }) {
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
  };
}
