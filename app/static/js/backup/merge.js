// S35 (R24): merging an imported backup's saved list and history stores into what the
// device already holds. Union by story id, keep the newer entry (by its own `time`
// field); the profile is never merged field by field, it is replaced wholesale after an
// explicit confirm (profile-screen.js), since "replace" is what the brief asks for
// there and a field-by-field merge of two owners' opinions has no obviously right answer.

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
 * own example counts it: "Saved +4, history +31"). */
export function importCounts(profile, savedMerge, openedMerge, shownMerge) {
  return {
    interestCount: Object.keys(profile?.topics || {}).length,
    savedDelta: savedMerge.added + savedMerge.updated,
    historyDelta: openedMerge.added + openedMerge.updated + shownMerge.added + shownMerge.updated,
  };
}

export function confirmMessage({ interestCount, savedDelta, historyDelta }) {
  return `Replace your interests with ${interestCount} from the file? Saved +${savedDelta}, history +${historyDelta}`;
}
