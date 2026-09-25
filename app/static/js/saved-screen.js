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
// S34 seam: a History segment joins this screen later, switching #saved-list between
// saves and history entries. #saved-segment (empty, hidden, right under the title,
// app/build.py) is where that segmented control goes; this slice never fills or shows it.
import { savesStore } from "./actions/store.js";
import { toggleSave, undoSave } from "./actions/saves.js";
import { syncSavePin, syncUndoPin } from "./actions/save-pin.js";
import { bodyCache } from "./reader/cache.js";
import { loadBody } from "./reader/core.js";
import { nowIso } from "./profile/time.js";
import { relativeAge } from "./offline-format.js";
import { sortedSaves } from "./saved-list.js";
import { openSheet, closeSheet } from "./sheet.js";
import { showToast } from "./toast.js";

const MIDDOT = "·";
// The sheet's own close glyph (app/build.py SHEET), reused here as "remove": a plain X
// reads as "take this off the list" without a second, unrelated icon to keep in sync.
const UNSAVE_ICON_D = "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z";
const OVERFLOW_ICON_D = "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z";

const list = document.getElementById("saved-list");
const empty = document.getElementById("saved-empty");

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

// Rendered on arrival at #saved, and every time it is arrived at again: the list can
// have changed (a save or unsave made from another tab's card) since the last visit.
if (isSavedScreen()) render();
addEventListener("hashchange", () => { if (isSavedScreen()) render(); });
