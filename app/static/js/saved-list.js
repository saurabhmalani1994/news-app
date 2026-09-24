// S26: the pure part of the Saved screen, kept free of the DOM so Node can test list
// order without a page (saved-screen.js is the thin layer that reads savesStore.list()
// and hands it here). Records are actions/saves.js's buildSaveSnapshot shape.

/** Newest saved first, by the `time` a save was made (ISO strings sort lexicographically
 * the same as chronologically). Array.prototype.sort is a stable sort in every engine
 * this app targets, so two saves made in the same instant keep the order the store
 * returned them in. */
export function sortedSaves(records) {
  return [...records].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
}
