// S14: the coverage view (js/coverage.js's pure grouping) in the S24 sheet. V1: the
// card's "N sources" trigger now opens the versions carousel (js/versions-view.js),
// whose footer, "All versions by lean", opens this sheet for the same cluster.
// DESIGN-v1 section 6 / DESIGN-v1.1 section 5: real headlines side by side, grouped
// by lean, never an AI summary (R13). Bottom sheet, not a full page: the
// content is a flat, scrollable list of short rows, the same shape and density the
// sheet already carries for story actions, and .sheet already scrolls past 80vh
// (style.css), so no cluster size runs out of room.
import { openSheet, closeSheet, isSheetOpen } from "./sheet.js";
import { buildCoverage, coverageContext, LEAN_LABELS } from "./coverage.js";
import { relativeAge } from "./offline-format.js";
import { leanMarker } from "./lean.js";
import { STORAGE_KEY } from "./profile/store.js";
import { pageInput } from "./page-input.js";

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

/** The stored profile's mutes.sources, read fresh at each open so a mute saved since
 * the page loaded counts (H6 item 3: the sheet's outlet counts must agree with the
 * row's "N sources" and V1's carousel, both of which drop a muted outlet). [] when
 * storage cannot be read or nothing is stored: the shipped default mutes nothing. */
function storedMutes() {
  try {
    const history = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")?.history;
    if (Array.isArray(history) && history.length) {
      return history[history.length - 1].profile?.mutes?.sources || [];
    }
  } catch {
    // storage blocked: fall through
  }
  return window.almanacProfile?.mutes?.sources || [];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Opens the in-app reader for a row tapped inside the (currently open) sheet. The
 * sheet sits above the reader (style.css z-index), so the reader is closed first,
 * through the same history-back path the scrim and Escape use (sheet.js closeSheet),
 * and only once that has actually taken effect is a synthetic click on a throwaway
 * `a.story-link[data-body]` dispatched: reader.js's own document click listener opens
 * it from there, so this file never has to import or duplicate reader.js's logic. */
function openReaderAfterSheetCloses(id, url) {
  const dispatch = () => {
    const a = document.createElement("a");
    a.className = "story-link";
    a.href = url;
    a.dataset.body = id;
    a.style.position = "fixed";
    a.style.inset = "0";
    a.style.width = "1px";
    a.style.height = "1px";
    a.style.opacity = "0";
    a.style.pointerEvents = "none";
    document.body.append(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    a.remove();
  };
  if (!isSheetOpen()) { dispatch(); return; }
  const onPop = () => {
    removeEventListener("popstate", onPop);
    dispatch();
  };
  addEventListener("popstate", onPop);
  closeSheet();
}

function ownershipLabel(value) {
  if (!value) return null;
  // sources.json values are already closed, hand-written labels ("state-owned"); only
  // the hyphen needs turning into a space for the plain-words bar (R34).
  return value.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function rowNode(row, now) {
  const a = el("a", "coverage-row");
  a.href = row.url || "#";
  if (!row.url) a.setAttribute("aria-disabled", "true");
  const head = el("span", "coverage-row-head");
  head.append(el("span", "coverage-outlet", row.sourceName));
  const label = ownershipLabel(row.ownership);
  // L1: the outlet's lean marker, named for screen readers (js/lean.js); U3: its country
  // code when it sits outside the US scale. State media that already carries its
  // ownership label says so once, not twice.
  const marker = row.lean === "state" && label ? null : leanMarker(row.lean, { labelled: true, country: row.country });
  if (marker) head.append(marker);
  if (label) head.append(el("span", "coverage-ownership", label));
  const time = relativeAge(row.publishedAt, now);
  if (time) {
    const t = el("time", "coverage-time", time);
    t.dateTime = row.publishedAt;
    head.append(t);
  }
  a.append(head, el("span", "coverage-headline", row.headline));
  a.addEventListener("click", (event) => {
    event.preventDefault();
    if (!row.url) return;
    if (row.hasBody) openReaderAfterSheetCloses(row.id, row.url);
    else window.open(row.url, "_blank", "noopener,noreferrer");
  });
  return a;
}

function alsoNode(also) {
  if (!also.length) return null;
  const names = also.map((a) => a.sourceName).filter(Boolean);
  if (!names.length) return null;
  return el("p", "coverage-also", `Also carried by ${names.join(", ")}`);
}

function groupNode(group, now) {
  const wrap = el("div", "coverage-group");
  wrap.dataset.bucket = group.bucket;
  wrap.append(el("h3", "coverage-group-label", LEAN_LABELS[group.bucket] || group.bucket));
  for (const row of group.rows) {
    wrap.append(rowNode(row, now));
    const also = alsoNode(row.also);
    if (also) wrap.append(also);
  }
  return wrap;
}

function coverageContent(cluster, ctx) {
  const now = Date.now();
  const { summary, groups } = buildCoverage(cluster, ctx);
  const wrap = el("div", "coverage");
  wrap.append(el("p", "coverage-summary", summary.text));
  if (groups.length > 1) wrap.append(jumpNode(groups, wrap));
  for (const group of groups) wrap.append(groupNode(group, now));
  return wrap;
}

/** C2: one button per lean group ("Left 2", "International 6") that scrolls the sheet
 * to that group, whose label then stays pinned under the sheet's header while its rows
 * scroll (style.css .coverage-group-label). Labels are LEAN_LABELS, the app's own. */
function jumpNode(groups, wrap) {
  const nav = el("nav", "coverage-jump");
  nav.setAttribute("aria-label", "Jump to a lean");
  for (const group of groups) {
    const button = el("button", "coverage-jump-item");
    button.type = "button";
    button.append(el("span", "", LEAN_LABELS[group.bucket] || group.bucket), el("span", "coverage-jump-count", String(group.rows.length)));
    button.addEventListener("click", () => {
      // The sheet panel is the scroller. scrollIntoView would also scroll its fixed
      // ancestors and push the sheet's own header off screen, so this sets the panel's
      // offset directly: the group's top, less the sticky header's height.
      const target = [...wrap.querySelectorAll(".coverage-group")].find((g) => g.dataset.bucket === group.bucket);
      const panel = wrap.closest(".sheet");
      if (!target || !panel) return;
      const head = document.getElementById("sheet-drag")?.offsetHeight || 0;
      const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - head;
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
    });
    nav.append(button);
  }
  return nav;
}

/** Opens the coverage sheet for cluster `sid`; `opener` takes focus back on close.
 * False when the page holds no such cluster. `pageInputOverride` (S30): a follow's own
 * page (You, /profile#interest or #story) holds no #rank-input of its own (it draws its
 * stories from a background fetch of the front page, profile-screen.js's `front.input`),
 * so it passes that decoded input straight through instead of this module reading the
 * local document, reusing this same sheet rather than a new renderer. */
export function openCoverage(sid, opener, pageInputOverride) {
  const input = pageInputOverride || getInput();
  const cluster = (input.pool?.clusters || []).find((c) => c.id === sid);
  if (!cluster) return false;
  const content = coverageContent(cluster, coverageContext(input, { muted: storedMutes() }));
  openSheet({ title: "Coverage", content, opener });
  return true;
}
