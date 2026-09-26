// S26: the Saved screen. Reads S24's savesStore (IndexedDB, browser only) and renders
// the same card the river uses (app/build.py STORY: .story.story--river, reused as-is,
// so D3's card and tab-strip polish flows through here too), newest saved first
// (saved-list.js sortedSaves). A tap opens the in-app reader for a has_body story
// exactly the way a home card does: the row's own <a class="story-link" data-body="…">
// is all reader.js's existing global click handler needs, so nothing here duplicates
// that wiring. A story with no body, or no url at all, behaves the same as any other
// card (link-out, or no link).
//
// The overflow here is deliberately not story-actions.js's seven-item menu: a saved
// story only ever offers Unsave, in the same quiet toast-and-Undo voice as any other
// action (toast.js). It reuses toggleSave/undoSave (S24) and the S26 pin/unpin sync
// (actions/save-pin.js), so a story unsaved from here and one unsaved from its own card
// elsewhere agree. The button is deliberately not classed "story-overflow": that class
// alone is what story-actions.js's own global click listener keys off, and it would
// open its own, wrong, menu on a Saved row (see style.css's ".saved-overflow" note).
//
// S34: the History segment fills the seam S26 left (#saved-segment, #history-panel,
// app/build.py). Its rows are the device's own history/store.js records: opened stories
// always, shown-but-never-opened ones (14 days) behind the Seen filter, grouped by day
// (history/group.js) and locally searched (history/search.js), nothing ever sent
// anywhere. A tap reopens: history/reopen.js decides the in-app reader (a cached body,
// or the story still in the live pool with one) or a link out, from the record's own
// title/outlet/url, never the pool's, since the pool a History row's story once lived in
// has usually long since rotated out (R23 keeps opened a year). That is also why this
// screen owns the click, rather than letting reader.js's own generic listener (built for
// a live, on-page card) run its pool lookups against a row it cannot place: every History
// row click is stopped here, reopened with reader.js's exported openWithFacts, and
// recorded with the row's own good data (never storyAttributes' pool-dependent one,
// which would just as happily overwrite a rich record with blanks). Its own overflow
// offers Save, the same toggleSave/pin flow as any other card; "Clear history" is the
// one destructive action here, so it asks first with a sheet.js confirm, never Undo.
import { savesStore } from "./actions/store.js";
import { toggleSave, undoSave } from "./actions/saves.js";
import { syncSavePin, syncUndoPin } from "./actions/save-pin.js";
import { bodyCache } from "./reader/cache.js";
import { loadBody } from "./reader/core.js";
import { openWithFacts } from "./reader.js";
import { nowIso } from "./profile/time.js";
import { relativeAge } from "./offline-format.js";
import { sortedSaves } from "./saved-list.js";
import { openSheet, closeSheet } from "./sheet.js";
import { showToast } from "./toast.js";
import { leanHit, leanMarker } from "./lean.js";
import { openedStore, shownStore } from "./history/store.js";
import { groupHistoryByDay, visibleHistory } from "./history/group.js";
import { searchHistory } from "./history/search.js";
import { articleIdFor, reopenTarget } from "./history/reopen.js";
import { clearHistory } from "./history/clear.js";
import { recordOpened } from "./history/record.js";
import { noteSeen, pruneSummary } from "./history/summary.js";
import { pageInput } from "./page-input.js";

const MIDDOT = "·";
// The sheet's own close glyph (app/build.py SHEET), reused here as "remove": a plain X
// reads as "take this off the list" without a second, unrelated icon to keep in sync.
const UNSAVE_ICON_D = "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z";
const OVERFLOW_ICON_D = "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z";
// story-actions.js's own bookmark glyph (ICONS.save), reused so a Save offered from a
// History row's menu looks like the one every other card's overflow already offers.
const SAVE_ICON_D = "M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z";

const list = document.getElementById("saved-list");
const empty = document.getElementById("saved-empty");
const segmentSaved = document.getElementById("segment-saved");
const segmentHistory = document.getElementById("segment-history");
const savedPanel = document.getElementById("saved-panel");
const historyPanel = document.getElementById("history-panel");
const historySearchInput = document.getElementById("history-search");
const historySeenToggle = document.getElementById("history-seen-toggle");
const historyEmpty = document.getElementById("history-empty");
const historyEmptyHead = document.getElementById("history-empty-head");
const historyEmptyText = document.getElementById("history-empty-text");
const historyGroupsEl = document.getElementById("history-groups");
const historyClearButton = document.getElementById("history-clear");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgIcon(className, size, d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function media(image) {
  if (!image) return null;
  const span = el("span", "story-media story-media--thumb");
  const img = document.createElement("img");
  img.className = "story-img";
  img.width = 88;
  img.height = 88;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = image;
  span.append(img);
  return span;
}

function metaLine(record) {
  const meta = el("span", "meta");
  // U3: the meta is a stack of lines (style.css .meta-line); a Saved row has one.
  const line = el("span", "meta-line");
  const age = relativeAge(record.time, Date.now());
  const saved = age ? `Saved ${age}` : "Saved";
  if (record.source) {
    line.append(el("span", "meta-source", record.source));
    line.append(el("span", "meta-rest", ` ${MIDDOT} ${saved}`));
  } else {
    line.append(el("span", "meta-rest", saved));
  }
  meta.append(line);
  return meta;
}

function row(record) {
  const li = el("li", "story story--river");
  li.dataset.sid = record.id;
  const open = record.url ? document.createElement("a") : document.createElement("span");
  open.className = "story-link";
  if (record.url) {
    open.setAttribute("href", record.url);
    open.setAttribute("target", "_blank");
    open.setAttribute("rel", "noopener noreferrer");
    if (record.has_body && record.article_id) open.dataset.body = record.article_id;
  }
  const body = el("span", "story-body");
  const thumb = media(record.image);
  if (thumb) body.append(thumb);
  body.append(el("span", "headline headline--river", record.title));
  body.append(metaLine(record));
  open.append(body);
  const overflow = el("button", "saved-overflow");
  overflow.type = "button";
  overflow.setAttribute("aria-label", "Story actions");
  overflow.setAttribute("aria-haspopup", "dialog");
  overflow.append(svgIcon("story-overflow-icon", 20, OVERFLOW_ICON_D));
  li.append(open, overflow);
  return li;
}

async function render() {
  const records = sortedSaves(await savesStore.list().catch(() => []));
  list.replaceChildren(...records.map(row));
  list.hidden = records.length === 0;
  empty.hidden = records.length > 0;
}

const pinDeps = { cache: bodyCache, fetchBody: loadBody };

// --- S34: History -----------------------------------------------------------------

// The page's own embedded ranking input (app/build.py #rank-input), the same one
// observe.js and reader.js each keep their own cached parse of: `bodies` says which
// articles the live pool can still open in the reader (history/reopen.js's
// poolHasBody), `leans`/`countries` are sources.json's own catalog (R10), looked up by
// source id so an outlet's marker (U3) still shows even once its own articles have
// rotated out of the pool.
let poolCache = null;
function poolInput() {
  if (!poolCache) {
    try {
      poolCache = pageInput();
    } catch {
      poolCache = { bodies: {}, leans: {}, countries: {} };
    }
  }
  return poolCache;
}

function poolHasBody(sid, articleId) {
  const candidates = poolInput().bodies?.[sid];
  return Array.isArray(candidates) && candidates.some((c) => Array.isArray(c) && c[0] === articleId);
}

/** The reopen decision for one history record, resolved once per render (not per
 * keystroke: loadHistoryCache below is the only place this runs). `bodyCache.get` is
 * the one async part; a device with no IndexedDB (old browser, private-mode block)
 * just never counts as cached, same fallback every other history/store.js caller uses. */
async function resolveReopen(record) {
  const articleId = articleIdFor(record);
  let cached = false;
  if (articleId) {
    try { cached = Boolean(await bodyCache.get(articleId)); } catch { cached = false; }
  }
  const target = reopenTarget(record, { cached, poolHasBody: articleId ? poolHasBody(record.id, articleId) : false });
  return { ...record, reopen: target };
}

let historyCache = null; // { opened: [...resolved], shown: [...resolved] }
let historySeen = false;
let historyQuery = "";
let activeSegment = "saved"; // "Saved stays the default" (the brief's own words)
const historyRecords = new WeakMap(); // <li> -> its resolved record, for the click handler

async function loadHistoryCache() {
  const [openedRaw, shownRaw] = await Promise.all([
    openedStore.list().catch(() => []),
    shownStore.list().catch(() => []),
  ]);
  const [opened, shown] = await Promise.all([
    Promise.all(openedRaw.map(resolveReopen)),
    Promise.all(shownRaw.map(resolveReopen)),
  ]);
  historyCache = { opened, shown };
}

function historyMetaLine(record) {
  const meta = el("span", "meta");
  const line = el("span", "meta-line");
  const age = relativeAge(record.time, Date.now());
  const label = record.kind === "shown" ? "Seen" : "Opened";
  const when = age ? `${label} ${age}` : label;
  if (record.source) {
    line.append(el("span", "meta-source", record.source));
    if (record.source_id) {
      const input = poolInput();
      const marker = leanMarker(input.leans?.[record.source_id], { country: input.countries?.[record.source_id] });
      if (marker) line.append(marker);
    }
    line.append(el("span", "meta-rest", ` ${MIDDOT} ${when}`));
  } else {
    line.append(el("span", "meta-rest", when));
  }
  meta.append(line);
  return meta;
}

/** Same STORY markup order app/build.py writes: the link, then (U3) the marker's own
 * 48dp hit target as its sibling, never nested inside it, then the overflow. */
function historyRow(record) {
  const li = el("li", "story story--river");
  li.dataset.sid = record.id;
  const target = record.reopen || { mode: "none" };
  let open;
  if (target.mode === "none") {
    open = el("span", "story-link");
  } else {
    open = document.createElement("a");
    open.className = "story-link";
    open.setAttribute("href", target.mode === "link" ? target.url : record.url || "#");
    open.setAttribute("target", "_blank");
    open.setAttribute("rel", "noopener noreferrer");
    if (target.mode === "reader") open.dataset.body = target.id;
  }
  const body = el("span", "story-body");
  const thumb = media(record.image);
  if (thumb) body.append(thumb);
  body.append(el("span", "headline headline--river", record.title));
  body.append(historyMetaLine(record));
  open.append(body);
  li.append(open);
  if (record.source_id) {
    const input = poolInput();
    const hit = leanHit(record.source_id, input.leans?.[record.source_id], document, input.countries?.[record.source_id]);
    if (hit) li.append(hit);
  }
  const overflow = el("button", "history-overflow");
  overflow.type = "button";
  overflow.setAttribute("aria-label", "Story actions");
  overflow.setAttribute("aria-haspopup", "dialog");
  overflow.append(svgIcon("story-overflow-icon", 20, OVERFLOW_ICON_D));
  li.append(overflow);
  historyRecords.set(li, record);
  return li;
}

function historyGroupNode(group) {
  const wrap = el("div", "history-group");
  wrap.append(el("h2", "history-day", group.label));
  const ol = el("ol", "river river--top history-day-list");
  ol.append(...group.records.map(historyRow));
  wrap.append(ol);
  return wrap;
}

async function renderHistory({ reload = false } = {}) {
  if (reload || !historyCache) await loadHistoryCache();
  const rows = visibleHistory(historyCache.opened, historyCache.shown, { seen: historySeen });
  const filtered = searchHistory(rows, historyQuery);
  const groups = groupHistoryByDay(filtered, Date.now());
  const totalRecorded = historyCache.opened.length + historyCache.shown.length;
  historyGroupsEl.replaceChildren(...groups.map(historyGroupNode));
  historyGroupsEl.hidden = groups.length === 0;
  historyClearButton.hidden = totalRecorded === 0;
  if (totalRecorded === 0) {
    historyEmptyHead.textContent = "Nothing opened yet";
    historyEmptyText.textContent = "Stories you open will be grouped here by day, so one the algorithm quietly deprioritizes is never really gone.";
    historyEmpty.hidden = false;
  } else if (groups.length === 0) {
    historyEmptyHead.textContent = "No matches";
    historyEmptyText.textContent = "Try a different search, or turn on Seen to include stories you scrolled past.";
    historyEmpty.hidden = false;
  } else {
    historyEmpty.hidden = true;
  }
}

/** The "normal opened rule" (the brief's own words): reopening a History row records an
 * ordinary opened event, from the row's own already-good fields, never storyAttributes'
 * pool lookup (which would overwrite title/source with blanks for a story the pool no
 * longer has). record.js's own session-once guard means this is a no-op the rest of the
 * session, so it never refreshes the seen penalty's clock beyond what a first open did. */
function markHistoryReopened(record, articleId) {
  const attrs = {
    title: record.title, source: record.source_id || "", source_name: record.source,
    url: record.url, image: record.image, topics: record.topics, article_id: articleId,
  };
  recordOpened(openedStore, record.id, attrs, nowIso, (snapshot) => noteSeen(localStorage, "opened", snapshot.id, snapshot.time))
    .catch(() => {});
}

function isPlainClick(event) {
  return (event.button ?? 0) === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

async function saveFromHistory(record) {
  const attrs = {
    title: record.title, source: record.source_id || "", source_name: record.source, url: record.url,
    image: record.image, has_body: (record.reopen || {}).mode === "reader", article_id: articleIdFor(record),
  };
  const result = await toggleSave(savesStore, record.id, attrs, nowIso);
  syncSavePin(result, pinDeps).catch(() => {});
  showToast(result.action === "added" ? "Saved" : "Removed from Saved", {
    onAction: async () => {
      await undoSave(savesStore, record.id, result.action, result.previous);
      syncUndoPin(result.action, result.record, result.previous, pinDeps).catch(() => {});
    },
  });
}

function openHistorySaveSheet(li, record) {
  savesStore.get(record.id).catch(() => null).then((existing) => {
    const label = existing ? "Unsave" : "Save";
    const button = el("button", "sheet-item");
    button.type = "button";
    button.dataset.action = "save";
    button.append(svgIcon("sheet-item-icon", 22, SAVE_ICON_D), el("span", "sheet-item-text", label));
    const menu = el("div", "sheet-menu");
    menu.setAttribute("role", "menu");
    menu.append(button);
    menu.addEventListener("click", (event) => {
      if (!event.target.closest(".sheet-item")) return;
      closeSheet();
      saveFromHistory(record);
    });
    openSheet({ title: "Story actions", content: menu, opener: li.querySelector(".history-overflow") });
  });
}

historyGroupsEl.addEventListener("click", (event) => {
  const overflowButton = event.target.closest(".history-overflow");
  if (overflowButton) {
    event.preventDefault();
    const li = overflowButton.closest("li.story[data-sid]");
    const record = li && historyRecords.get(li);
    if (record) openHistorySaveSheet(li, record);
    return;
  }
  const link = event.target.closest("a.story-link, span.story-link");
  if (!link) return;
  const li = link.closest("li.story[data-sid]");
  const record = li && historyRecords.get(li);
  if (!record) return;
  // Owns the row from here: reader.js's own generic listener (built for a live, on-page
  // card) never sees this click, so it never runs its pool-dependent open() against a
  // row it cannot place.
  event.stopPropagation();
  const articleId = articleIdFor(record);
  markHistoryReopened(record, articleId);
  const target = record.reopen || { mode: "none" };
  if (target.mode === "reader" && isPlainClick(event)) {
    event.preventDefault();
    const facts = {
      sid: record.id, title: record.title || "", dek: "", credit: "",
      source: record.source || "", sourceId: record.source_id || "",
      published: "", photo: null, href: record.url || "",
    };
    openWithFacts(target.id, facts, link, true);
  }
  // Otherwise (a link-only row, or a modified click on a reader-eligible one): the
  // anchor's own href and target="_blank" carry the tap out, same as any other card.
});

historySearchInput.addEventListener("input", () => {
  historyQuery = historySearchInput.value;
  renderHistory();
});

historySeenToggle.addEventListener("click", () => {
  historySeen = historySeenToggle.getAttribute("aria-checked") !== "true";
  historySeenToggle.setAttribute("aria-checked", String(historySeen));
  renderHistory();
});

function openClearHistorySheet() {
  const message = el("p", "sheet-message", "This removes every opened and seen story from this device. It cannot be undone.");
  const cancel = el("button", "sheet-item");
  cancel.type = "button";
  cancel.dataset.action = "cancel";
  cancel.append(el("span", "sheet-item-text", "Cancel"));
  const confirm = el("button", "sheet-item sheet-item--destructive");
  confirm.type = "button";
  confirm.dataset.action = "clear";
  confirm.append(el("span", "sheet-item-text", "Clear history"));
  const menu = el("div", "sheet-menu");
  menu.setAttribute("role", "menu");
  menu.append(message, cancel, confirm);
  menu.addEventListener("click", async (event) => {
    const action = event.target.closest(".sheet-item")?.dataset.action;
    if (action === "cancel") {
      closeSheet();
    } else if (action === "clear") {
      closeSheet();
      const removed = await clearHistory({ openedStore, shownStore });
      pruneSummary(localStorage, removed);
      await renderHistory({ reload: true });
      showToast("History cleared");
    }
  });
  openSheet({ title: "Clear history", content: menu, opener: historyClearButton });
}

historyClearButton.addEventListener("click", openClearHistorySheet);

function showSegment(name) {
  activeSegment = name;
  const isHistory = name === "history";
  segmentSaved.setAttribute("aria-selected", String(!isHistory));
  segmentHistory.setAttribute("aria-selected", String(isHistory));
  savedPanel.hidden = isHistory;
  historyPanel.hidden = !isHistory;
  if (isHistory) renderHistory();
  else render();
}

segmentSaved.addEventListener("click", () => showSegment("saved"));
segmentHistory.addEventListener("click", () => showSegment("history"));

// --- S26: Saved --------------------------------------------------------------------

async function unsave(sid) {
  const result = await toggleSave(savesStore, sid, {}, nowIso);
  if (result.action !== "removed") return; // a row on this screen is always already saved
  syncSavePin(result, pinDeps).catch(() => {});
  await render();
  showToast("Removed from Saved", {
    onAction: async () => {
      await undoSave(savesStore, sid, result.action, result.previous);
      syncUndoPin(result.action, result.record, result.previous, pinDeps).catch(() => {});
      await render();
    },
  });
}

function openUnsaveSheet(li) {
  const button = el("button", "sheet-item");
  button.type = "button";
  button.dataset.action = "unsave";
  button.append(svgIcon("sheet-item-icon", 22, UNSAVE_ICON_D), el("span", "sheet-item-text", "Unsave"));
  const menu = el("div", "sheet-menu");
  menu.setAttribute("role", "menu");
  menu.append(button);
  const sid = li.dataset.sid;
  menu.addEventListener("click", (event) => {
    if (!event.target.closest(".sheet-item")) return;
    closeSheet();
    unsave(sid);
  });
  openSheet({ title: "Story actions", content: menu, opener: li.querySelector(".saved-overflow") });
}

list.addEventListener("click", (event) => {
  const button = event.target.closest(".saved-overflow");
  if (!button) return;
  event.preventDefault();
  const li = button.closest("li.story[data-sid]");
  if (li) openUnsaveSheet(li);
});

function isSavedScreen() {
  return location.hash.slice(1) === "saved";
}

// Rendered on arrival at #saved, and every time it is arrived at again: whichever
// segment is active, its list can have changed (a save, an unsave, an open elsewhere,
// S34's own History) since the last visit. Saved stays the default: activeSegment only
// ever changes from a tap on the segmented control itself.
if (isSavedScreen()) showSegment(activeSegment);
addEventListener("hashchange", () => { if (isSavedScreen()) showSegment(activeSegment); });
