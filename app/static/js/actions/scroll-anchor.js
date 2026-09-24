// S24: keeps a visible panel's scroll position steady across a live re-render (a mute
// or a boost re-ranking the active tab in place). Browser-only DOM math, not Node
// tested; the headless-Chrome proof (tests/browser) checks it against real layout.
//
// Native CSS scroll anchoring (`overflow-anchor`, on by default) already nudges the
// scroll offset when content changes above an anchor node it picked itself, but its
// heuristic anchor can be the very row a mute removes, or one every row below it gets
// re-appended past (tiers.js retier() moves every remaining row, not just the changed
// ones), so it is not trusted here. Instead: find the first story row whose bottom
// edge is still below the panel's own top edge (the first row the reader can see any
// of), note where its top sits before the mutation, run the mutation, then move the
// panel's own scrollTop by exactly how far that row's top moved. A row the mutation
// removed cannot anchor anything; the next one down takes over silently, and rows
// above the viewport are free to appear, disappear or reorder unseen.
export function anchoredRerender(panel, mutate) {
  const rows = [...panel.querySelectorAll("li.story[data-sid]")];
  const panelTop = panel.getBoundingClientRect().top;
  const anchor = rows.find((li) => li.getBoundingClientRect().bottom > panelTop) || rows[0] || null;
  const before = anchor ? anchor.getBoundingClientRect().top : null;
  mutate();
  if (anchor && anchor.isConnected && before !== null) {
    const after = anchor.getBoundingClientRect().top;
    const delta = after - before;
    if (delta) panel.scrollTop += delta;
  }
}
