// S15: "shown" (R17, R23): a card at least half visible for about 1 second, recorded
// with IntersectionObserver, batched and cheap. One timer per row, started only while
// it stays at or past half visible and cleared the moment it is not; a row scrolled
// past quickly never fires. record.js's own session-once guard means a card shown
// three times in one page life still writes at most once, so there is nothing further
// to batch on the write side; the "batched and cheap" the brief asks for is this: no
// timer, no write, no IndexedDB open, for a row that never dwells on screen.
//
// A MutationObserver, not tabs.js itself, picks up rows a section tab or a mute/boost
// re-render adds later, so this file stays decoupled from the tab strip and Live panel
// another slice owns.
//
// Also runs the startup retention prune (history/prune.js) once per page load, off the
// critical path.
import { openedStore, shownStore } from "./store.js";
import { recordShown } from "./record.js";
import { noteSeen, pruneSummary } from "./summary.js";
import { pruneHistory } from "./prune.js";
import { storyAttributes } from "../actions/context.js";
import { nowIso } from "../profile/time.js";
import { pageInput } from "../page-input.js";

const DWELL_MS = 1000;
const THRESHOLD = 0.5;

let cachedInput = null;
function getInput() {
  if (!cachedInput) {
    try {
      cachedInput = pageInput();
    } catch {
      cachedInput = { pool: { articles: [], clusters: [] } };
    }
  }
  return cachedInput;
}

/** The same card snapshot shape story-actions.js's Save and S15's reader.js opened
 * write, read off the DOM row and the page's own embedded input. */
function cardAttrs(li) {
  const sid = li.dataset.sid;
  const input = getInput();
  const attrs = storyAttributes(input, sid, li.dataset.face || null);
  const image = li.dataset.face ? input.fronts?.[li.dataset.face]?.i : input.images?.[sid];
  const link = li.querySelector("a.story-link");
  return {
    ...attrs,
    title: li.querySelector(".headline")?.textContent || "",
    url: link?.getAttribute("href") || "",
    image: image?.hero?.[0] || image?.thumb || null,
  };
}

function mark(li) {
  const sid = li.dataset.sid;
  if (!sid) return;
  recordShown(shownStore, sid, cardAttrs(li), nowIso, (snapshot) => noteSeen(localStorage, "shown", snapshot.id, snapshot.time))
    .catch(() => {}); // no IndexedDB: shown just goes unrecorded, never blocks scrolling
}

const timers = new WeakMap();
const observed = new WeakSet();

function onIntersect(entries) {
  for (const entry of entries) {
    const li = entry.target;
    const dwelling = timers.has(li);
    if (entry.isIntersecting && entry.intersectionRatio >= THRESHOLD) {
      if (dwelling) continue;
      timers.set(li, setTimeout(() => { timers.delete(li); mark(li); }, DWELL_MS));
    } else if (dwelling) {
      clearTimeout(timers.get(li));
      timers.delete(li);
    }
  }
}

let io = null;
function observer() {
  if (!io && "IntersectionObserver" in window) io = new IntersectionObserver(onIntersect, { threshold: THRESHOLD });
  return io;
}

function observeAll(root) {
  const obs = observer();
  if (!obs || !root.querySelectorAll) return;
  for (const li of root.querySelectorAll("li.story[data-sid]")) {
    if (observed.has(li)) continue;
    observed.add(li);
    obs.observe(li);
  }
}

observeAll(document);
if ("MutationObserver" in window) {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.("li.story[data-sid]")) {
          if (!observed.has(node)) { observed.add(node); observer()?.observe(node); }
        } else observeAll(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

// Startup prune: opened past a year, shown-but-not-opened past 14 days, gone from both
// IndexedDB and the compact localStorage summary. Never on the paint path.
pruneHistory({ openedStore, shownStore })
  .then((removed) => pruneSummary(localStorage, removed))
  .catch(() => {});
