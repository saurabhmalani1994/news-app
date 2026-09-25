// S34: "Clear history", the one destructive action this screen offers (a confirm sheet
// asks first, in place of the app's usual quiet Undo, since there is nothing sensible to
// undo back to once every row is gone). Empties both IndexedDB stores and returns the
// ids removed, in history/prune.js's own {opened, shown} shape, so a caller can hand the
// same value straight to history/summary.js's pruneSummary and keep the compact
// localStorage summary from drifting out of step.
export async function clearHistory({ openedStore, shownStore }) {
  const [opened, shown] = await Promise.all([openedStore.list(), shownStore.list()]);
  const openedIds = opened.map((r) => r.id);
  const shownIds = shown.map((r) => r.id);
  await Promise.all([
    ...openedIds.map((id) => openedStore.delete(id)),
    ...shownIds.map((id) => shownStore.delete(id)),
  ]);
  return { opened: openedIds, shown: shownIds };
}
