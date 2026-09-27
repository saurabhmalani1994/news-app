// S35 (R24): merging an imported backup's saved list and history stores into what the
// device already holds. Union by story id, keep the newer entry (by its own `time`
// field); the profile is never merged field by field, it is replaced wholesale after an
// explicit confirm (profile-screen.js), since "replace" is what the brief asks for
// there and a field-by-field merge of two owners' opinions has no obviously right answer.
//
// S35b: the same union-by-id-keep-newer shape for the Timeline archive (S30), one
// follow at a time, then the same prune the live archive already applies on every
// record (pruneFollowArchive, 30 days / 200 items, follow-archive.js). A follow the
// (already-replaced) profile no longer has is dropped rather than merged back in:
// nothing would ever read it again, and following.js's own followList is what decides
// "still exists" everywhere else on the page.

import { pruneFollowArchive } from "../follow-archive.js";

/** Union of one follow's `current` items and `incoming` items by story id, keeping
 * whichever has the later `time`. Unpruned; the caller prunes after merging every
 * follow's own union (mergeArchives below). */
export function mergeArchiveById(current, incoming) {
  const byId = new Map((current || []).map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  for (const record of incoming || []) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      added++;
    } else if (new Date(record.time).getTime() > new Date(existing.time).getTime()) {
      byId.set(record.id, record);
      updated++;
    }
  }
  return { merged: [...byId.values()], added, updated };
}

/**
 * Merges an imported backup's whole Timeline archive into the device's own, one follow
 * at a time. `currentByKey` is a Map of follow key to that follow's current items
 * (only the keys the caller bothered to read need be present); `importedByKey` is
 * `validateBackup`'s own `data.archives` (plain object, possibly `{}`); `liveKeys` is a
 * Set of the follow keys the profile that will be saved still has (following.js
 * followList, mapped through archiveKey) — a key in the file but not in `liveKeys` is
 * dropped outright. Returns `{toWrite: [{key, items}], timelineDelta}`, `items` already
 * pruned and ready for `followArchiveStore.put(key, items)`, `timelineDelta` the net
 * new-or-newer items across every follow, for the confirm's own count.
 */
export function mergeArchives(currentByKey, importedByKey, liveKeys, nowMs) {
  const toWrite = [];
  let timelineDelta = 0;
  for (const key of Object.keys(importedByKey || {})) {
    if (!liveKeys.has(key)) continue;
    const current = (currentByKey && currentByKey.get(key)) || [];
    const { merged, added, updated } = mergeArchiveById(current, importedByKey[key]);
    toWrite.push({ key, items: pruneFollowArchive(merged, nowMs) });
    timelineDelta += added + updated;
  }
  return { toWrite, timelineDelta };
}

/** Union of `current` and `imported` by `id`, keeping whichever copy has the later
 * `time`. Returns the merged array (current's order first, new ids appended) and the
 * records that need writing back to the store: brand new ids, plus any id where the
 * imported copy won (unchanged ids are never rewritten). */
export function mergeById(current, imported) {
  const byId = new Map(current.map((r) => [r.id, r]));
  const toWrite = [];
  let added = 0;
  let updated = 0;
  for (const record of imported) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      toWrite.push(record);
      added++;
    } else if (new Date(record.time).getTime() > new Date(existing.time).getTime()) {
      byId.set(record.id, record);
      toWrite.push(record);
      updated++;
    }
  }
  return { merged: [...byId.values()], toWrite, added, updated };
}

/** The confirm message's counts: how many interests the file would replace with, and
 * the net new saved/history rows a merge would add (added and updated together, since
 * both are "the file's information", counted as one running total the way the brief's
 * own example counts it: "Saved +4, history +31"). `archiveMerge` is optional
 * (mergeArchives' own result); omitted, the Timeline count is 0 and confirmMessage
 * leaves it out entirely, so a version 1 file's confirm reads exactly as it always has. */
export function importCounts(profile, savedMerge, openedMerge, shownMerge, archiveMerge) {
  return {
    interestCount: Object.keys(profile?.topics || {}).length,
    savedDelta: savedMerge.added + savedMerge.updated,
    historyDelta: openedMerge.added + openedMerge.updated + shownMerge.added + shownMerge.updated,
    timelineDelta: archiveMerge?.timelineDelta || 0,
  };
}

export function confirmMessage({ interestCount, savedDelta, historyDelta, timelineDelta = 0 }) {
  const base = `Replace your interests with ${interestCount} from the file? Saved +${savedDelta}, history +${historyDelta}`;
  return timelineDelta ? `${base}, timeline +${timelineDelta}` : base;
}
