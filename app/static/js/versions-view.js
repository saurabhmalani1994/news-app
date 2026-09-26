// V1: the story versions carousel (docs/DESIGN-bundles.md section 5, B6 built early on
// today's clusters). The owner's ask: "see the same news story by different sources
// bundled together ... when i open it i can swipe left/right to see all the different
// ones". A tap on a row's "N sources" opens it for that row's cluster.
//
// One full-screen layer over the app (#bv, static chrome from app/build.py), like S25's
// reader, never inline: Home is already a horizontal scroll-snap pager (S27), and a
// nested swiper would fight the tab swipe. Home is never touched underneath, so closing
// just hides the layer and every panel keeps its scroll. Opening pushes a history entry
// (#bundle-<cluster id>), so the phone's back button closes it, and a "Read" inside
// opens the reader above it and returns to the same slide.
//
// The track is native scrolling only: scroll-snap-type x mandatory, one slide per
// width, scroll-snap-stop always, no JS drag. The index strip (one text chip per outlet,
// the active one underlined with the tabs' ink) and the arrow keys move it; with
// prefers-reduced-motion it jumps instead of gliding. Every slide's text is already in
// the page (#rank-input), so nothing is fetched to paint it; every feed string is set as
// text (R26), and word marks are <mark> nodes built with createElement.
//
// Signals: opening counts as opened for the lead's story (R17), as the reader does.
// Settling on any other version records `compared` (history/compared.js), which feeds
// no ranking term.
import {
  MIN_MARK_VERSIONS, buildVersions, faceOf, markSegments, uniqueWords, versionsContext, withWordMarks, wordMarksOn,
} from "./versions.js";
import { leanMark, leanMarker } from "./lean.js";
import { relativeAge } from "./offline-format.js";
import { openCoverage } from "./coverage-view.js";
import { ProfileStore, STORAGE_KEY } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { nowIso } from "./profile/time.js";
import { storyAttributes } from "./actions/context.js";
import { openedStore } from "./history/store.js";
import { recordOpened } from "./history/record.js";
import { noteSeen } from "./history/summary.js";
import { noteCompared } from "./history/compared.js";
import { pageInput as readPageInput } from "./page-input.js";

const layer = document.getElementById("bv");
const closeButton = document.getElementById("bv-close");
const count = document.getElementById("bv-count");
const marksButton = document.getElementById("bv-marks");
const strip = document.getElementById("bv-strip");
const track = document.getElementById("bv-track");
const allButton = document.getElementById("bv-all");
const primaryLink = document.getElementById("bv-primary");
const reader = document.getElementById("reader");
const sheetRoot = document.getElementById("sheet-root");
const underneath = [document.querySelector(".screens"), document.querySelector(".bottom-nav")].filter(Boolean);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const HASH = /^#bundle-([a-z0-9][a-z0-9_-]{0,80})$/;
const WEB = /^https?:\/\/[^\s]+$/i;
const BODY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMPARED_SETTLE_MS = 450;

// The word-mark design sweep (section 5): every treatment stays buildable behind a dev
// flag (localStorage almanac.dev.wordmarks = underline | weight | swipe | key), and
// WORD_MARKS is the one that ships, chosen from the sweep's screenshots.
export const WORD_MARK_TREATMENTS = Object.freeze(["underline", "weight", "swipe", "key"]);
export const WORD_MARKS = "key";
const DEV_FLAG = "almanac.dev.wordmarks";

let input = null;
let ctx = null;
let current = null; // {sid, slides, index, opener, pushed, leadId, seen: Set}
let hideTimer = 0;
let frame = 0;
let jumpTarget = null;
let settleTimer = 0;

function pageInput() {
  if (!input) {
    try {
      input = readPageInput();
    } catch {
      input = {};
    }
    ctx = versionsContext(input);
  }
  return input;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(className, d, size = 20) {
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

const CHEVRON = "M9.4 5.6 8 7l5 5-5 5 1.4 1.4 6.4-6.4z";
const ARROW_OUT = "M7 17 17 7M9 7h8v8";

function treatment() {
  try {
    const flag = localStorage.getItem(DEV_FLAG);
    if (WORD_MARK_TREATMENTS.includes(flag)) return flag;
  } catch {
    // storage blocked: the shipped treatment
  }
  return WORD_MARKS;
}

/** The stored profile's latest version, read at each open so a mute or the word-mark
 * switch saved since the page loaded counts; rerank.js's copy when storage cannot be
 * read; null for the shipped default. */
function storedProfile() {
  try {
    const history = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")?.history;
    if (Array.isArray(history) && history.length) return history[history.length - 1].profile;
  } catch {
    // storage blocked: fall through
  }
  return window.almanacProfile || null;
}

let schemaPromise = null;
function loadSchema() {
  if (!schemaPromise) {
    schemaPromise = fetch("profile.schema.json", { credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error(`schema ${r.status}`); return r.json(); })
      .catch((error) => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

let storeInstance = null;
async function getStore() {
  if (!storeInstance) {
    storeInstance = new ProfileStore({ storage: window.localStorage, schema: await loadSchema(), seedDefault: buildDefaultProfile });
  }
  return storeInstance;
}

// --- Signals ---

function markOpened(sid, lead) {
  const data = pageInput();
  const attrs = { ...storyAttributes(data, sid), title: lead?.headline || "", url: lead?.url || "" };
  const image = data.images?.[sid];
  attrs.image = image?.hero?.[0] || image?.thumb || null;
  recordOpened(openedStore, sid, attrs, nowIso, (snapshot) => noteSeen(localStorage, "opened", snapshot.id, snapshot.time))
    .catch(() => {}); // no IndexedDB: comparing still works, just unrecorded
}

function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!current) return;
    const slide = current.slides[current.index];
    if (!slide || slide.id === current.leadId || current.seen.has(slide.id)) return;
    current.seen.add(slide.id);
    noteCompared(localStorage, current.sid, slide.id, nowIso());
  }, COMPARED_SETTLE_MS);
}

// --- Slides ---

function ownershipLabel(value) {
  if (!value) return "";
  return value.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The outlet line: its name, then its marker (L1, U3: five dots, State or a country
 * code, the one shared renderer) as a button into the lean sheet (js/lean-view.js), as
 * the reader's byline does. State media that carries its ownership label says so once. */
function outletLine(slide) {
  const line = el("p", "bv-outlet");
  line.append(el("span", "bv-outlet-name", slide.sourceName));
  const owner = ownershipLabel(slide.ownership);
  const mark = slide.lean === "state" && owner ? null : leanMark(slide.lean, slide.country);
  const marker = mark && leanMarker(slide.lean, { country: slide.country });
  if (marker) {
    const button = el("button", "lean-open");
    button.type = "button";
    button.dataset.leanSource = slide.sourceId;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", mark.label);
    button.append(marker);
    line.append(button);
  }
  return line;
}

/** Ownership, the locality tier (versions.js localityLabel: "" until B4 publishes
 * one) and the age, joined by middots. */
function metaLine(slide, now) {
  const words = [ownershipLabel(slide.ownership), slide.locality, relativeAge(slide.publishedAt, now)].filter(Boolean);
  const line = el("p", "bv-meta", words.join(" · "));
  if (!words.length) line.hidden = true;
  return line;
}

function headlineNode(slide, unique) {
  const h = el("h3", "bv-headline");
  for (const piece of markSegments(slide.headline, unique)) {
    h.append(piece.mark ? el("mark", "bv-mark", piece.text) : document.createTextNode(piece.text));
  }
  return h;
}

/** "Read" (the S25 reader, when the version has full text) or "Open at <outlet>" (link
 * out). The Read link is a story link carrying data-body, so reader.js opens it the
 * way it opens a row, and closing the reader comes back to this slide. */
function actionNode(slide) {
  if (!WEB.test(slide.url)) return null;
  const read = slide.hasBody && BODY_ID.test(slide.id);
  const a = el("a", read ? "story-link bv-action" : "bv-action bv-action--out");
  a.setAttribute("href", slide.url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  if (read) a.dataset.body = slide.id;
  a.append(el("span", "bv-action-text", read ? "Read" : `Open at ${slide.sourceName}`));
  const glyph = icon(read ? "bv-action-icon" : "bv-action-icon bv-action-icon--out", read ? CHEVRON : ARROW_OUT, 18);
  a.append(glyph);
  return a;
}

function moreNode(slide) {
  if (!slide.more.length) return null;
  const wrap = el("section", "bv-more");
  const label = el("h4", "bv-more-label", "More from this outlet");
  wrap.append(label);
  for (const item of slide.more) {
    if (!WEB.test(item.url)) {
      wrap.append(el("p", "bv-more-row", item.headline));
      continue;
    }
    const read = item.hasBody && BODY_ID.test(item.id);
    const a = el("a", read ? "story-link bv-more-row" : "bv-more-row", item.headline);
    a.setAttribute("href", item.url);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    if (read) a.dataset.body = item.id;
    wrap.append(a);
  }
  return wrap;
}

function slideNode(slide, i, n, unique, now) {
  const section = el("section", "bv-slide");
  section.id = `bv-slide-${i}`;
  section.setAttribute("role", "tabpanel");
  section.setAttribute("aria-roledescription", "slide");
  section.setAttribute("aria-label", `${i + 1} of ${n}: ${slide.sourceName}`);
  const inner = el("div", "bv-slide-in");
  inner.append(outletLine(slide), metaLine(slide, now), headlineNode(slide, unique));
  if (slide.dek) inner.append(el("p", "bv-dek", slide.dek));
  const names = slide.also.map((a) => a.sourceName).filter(Boolean);
  if (names.length) inner.append(el("p", "bv-also", `Also carried by ${names.join(", ")}`));
  const action = actionNode(slide);
  if (action) inner.append(action);
  const more = moreNode(slide);
  if (more) inner.append(more);
  section.append(inner);
  return section;
}

function chipNode(slide, i) {
  const chip = el("button", "bv-chip", slide.sourceName);
  chip.type = "button";
  chip.id = `bv-tab-${i}`;
  chip.dataset.index = String(i);
  chip.dataset.label = slide.sourceName;
  chip.setAttribute("role", "tab");
  chip.setAttribute("aria-controls", `bv-slide-${i}`);
  chip.setAttribute("aria-selected", "false");
  chip.tabIndex = -1;
  return chip;
}

function render(slides) {
  const now = Date.now();
  const unique = uniqueWords(slides.map((s) => s.headline));
  strip.replaceChildren(...slides.map(chipNode));
  track.replaceChildren(...slides.map((s, i) => slideNode(s, i, slides.length, unique[i], now)));
  const markable = slides.length >= MIN_MARK_VERSIONS;
  layer.dataset.marks = treatment();
  layer.classList.toggle("bv--markable", markable);
  layer.classList.remove("bv--swiped");
  marksButton.disabled = !markable;
}

/** B9: the footer's primary source link, shown only when this cluster carries a
 * primary_source (DESIGN-bundles section 3: the fetcher's own match already
 * decided it, this just renders the url it wrote). WEB guards against anything
 * but a plain http(s) link ever reaching an href (R26 applies to every
 * feed-adjacent string, this one included). */
function setPrimarySource(cluster) {
  const url = cluster?.primary_source?.url;
  if (typeof url === "string" && WEB.test(url)) {
    primaryLink.href = url;
    primaryLink.hidden = false;
  } else {
    primaryLink.removeAttribute("href");
    primaryLink.hidden = true;
  }
}

function setMarks(on) {
  layer.classList.toggle("bv--plain", !on);
  marksButton.setAttribute("aria-pressed", String(on));
}

// --- Moving between slides ---

function behavior() {
  return reduced.matches ? "instant" : "smooth";
}

/** Marks slide i current: its chip selected and scrolled into view, the count, and
 * every other slide inert (off screen, out of the focus order). No scrolling of the
 * track itself; go() does that. */
function select(i) {
  if (!current) return;
  const n = current.slides.length;
  const index = Math.max(0, Math.min(n - 1, i));
  if (index !== current.index && current.index !== null) layer.classList.add("bv--swiped");
  current.index = index;
  count.textContent = `${index + 1} of ${n}`;
  [...strip.children].forEach((chip, k) => {
    chip.setAttribute("aria-selected", k === index ? "true" : "false");
    chip.tabIndex = k === index ? 0 : -1;
  });
  [...track.children].forEach((slide, k) => { slide.inert = k !== index; });
  const chip = strip.children[index];
  if (chip) {
    const left = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: behavior() });
  }
  settle();
}

function go(i, { focusChip = false } = {}) {
  if (!current) return;
  const index = Math.max(0, Math.min(current.slides.length - 1, i));
  jumpTarget = index;
  track.scrollTo({ left: index * track.clientWidth, behavior: behavior() });
  select(index);
  if (focusChip) strip.children[index]?.focus({ preventScroll: true });
}

track.addEventListener("scroll", () => {
  if (frame || !current) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!current) return;
    const width = track.clientWidth || 1;
    const at = track.scrollLeft / width;
    if (jumpTarget !== null) {
      // A chip or key jump glides across the slides between; the index is already set,
      // so the chips do not flicker through each one on the way.
      if (Math.abs(at - jumpTarget) < 0.01) jumpTarget = null;
      return;
    }
    const i = Math.round(at);
    if (i !== current.index) select(i);
  });
}, { passive: true });

// A finger on the track takes over from any glide still under way.
track.addEventListener("pointerdown", () => { jumpTarget = null; }, { passive: true });
track.addEventListener("touchstart", () => { jumpTarget = null; }, { passive: true });

strip.addEventListener("click", (event) => {
  const chip = event.target.closest(".bv-chip");
  if (!chip) return;
  go(Number(chip.dataset.index));
});

layer.addEventListener("keydown", (event) => {
  if (!current) return;
  if (event.key === "Escape") {
    event.preventDefault();
    goBack();
    return;
  }
  const onChip = event.target.closest?.(".bv-chip");
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (step) {
    event.preventDefault();
    go(current.index + step, { focusChip: Boolean(onChip) });
    return;
  }
  if (onChip && (event.key === "Home" || event.key === "End")) {
    event.preventDefault();
    go(event.key === "Home" ? 0 : current.slides.length - 1, { focusChip: true });
  }
});

// --- Opening and closing ---

/** Opens the carousel for cluster `sid`. `opener` takes focus back on close; `push`
 * adds the history entry (false when the address already names it). */
export function openVersions(sid, opener = null, push = true) {
  pageInput();
  const cluster = ctx.clusters.get(sid);
  if (!cluster) return false;
  const profile = storedProfile();
  // B5: the lead slide is the row's face for this profile (faceOf), the version the
  // row itself shows, so the row and the carousel's first slide always agree.
  const muted = profile?.mutes?.sources || [];
  const trust = profile?.trust || {};
  const slides = buildVersions(cluster, ctx, { leadId: faceOf(cluster, ctx, { muted, trust }), muted, trust, nowMs: Date.now() });
  if (!slides.length) return false;
  clearTimeout(hideTimer);
  current = { sid, slides, index: null, opener, pushed: push, leadId: slides[0].id, seen: new Set() };
  render(slides);
  setMarks(wordMarksOn(profile));
  setPrimarySource(cluster);
  if (push) history.pushState({ almanacBundle: sid }, "", `#bundle-${sid}`);
  for (const node of underneath) node.inert = true;
  layer.hidden = false;
  layer.inert = false;
  jumpTarget = null;
  track.scrollTo({ left: 0, behavior: "instant" });
  select(0);
  if (reduced.matches) layer.classList.add("is-open");
  else requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("is-open")));
  closeButton.focus({ preventScroll: true });
  markOpened(sid, slides[0]);
  return true;
}

function close() {
  if (!current) return;
  const { opener } = current;
  current = null;
  clearTimeout(settleTimer);
  layer.classList.remove("is-open");
  for (const node of underneath) node.inert = false;
  const done = () => {
    if (current) return;
    layer.hidden = true;
    strip.replaceChildren();
    track.replaceChildren();
    setPrimarySource(null);
  };
  if (reduced.matches) done();
  else hideTimer = setTimeout(done, 190);
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

/** The layer's own close: a history step when it added one, so history stays as the
 * owner left it; otherwise (opened from a #bundle- address) it closes in place. */
function goBack() {
  if (!current) return;
  if (current.pushed && history.state?.almanacBundle === current.sid) history.back();
  else {
    history.replaceState(null, "", location.pathname + location.search);
    close();
  }
}

closeButton.addEventListener("click", goBack);

marksButton.addEventListener("click", async () => {
  if (!current || marksButton.disabled) return;
  const on = marksButton.getAttribute("aria-pressed") !== "true";
  setMarks(on);
  try {
    const store = await getStore();
    const draft = withWordMarks(store.current(), on);
    if (draft) store.save(draft);
  } catch {
    // offline with no cached schema, or storage blocked: the switch still holds for now
  }
});

allButton.addEventListener("click", () => {
  if (current) openCoverage(current.sid, allButton);
});

// Back and forward. A layer above this one (the reader, a sheet) pushes its own entry
// over #bundle-; stepping back onto #bundle- closes that layer and leaves this one.
addEventListener("popstate", (event) => {
  const sid = event.state?.almanacBundle;
  if (sid) {
    if (!current || current.sid !== sid) openVersions(sid, null, false);
    if (current) current.pushed = true;
    return;
  }
  if (event.state?.almanacReader || event.state?.almanacSheet) return;
  close();
});

// The reader and the sheet each un-inert the app under them when they close; while
// this layer is still open, the app under it stays inert.
const keepUnder = () => {
  if (current) for (const node of underneath) node.inert = true;
};
for (const node of [reader, sheetRoot].filter(Boolean)) {
  new MutationObserver(keepUnder).observe(node, { attributes: true, attributeFilter: ["hidden", "class"] });
}

// The row trigger (app/build.py STORY_COVERAGE, over "N sources"): its own cluster.
document.addEventListener("click", (event) => {
  const button = event.target.closest?.(".story-coverage");
  if (!button) return;
  event.preventDefault();
  openVersions(button.dataset.sid, button, true);
});

// A #bundle-<id> address (a reload, a link typed in) opens that story's versions when
// the page has it; otherwise the address is dropped and Home shows.
function fromAddress() {
  const match = HASH.exec(location.hash);
  if (!match || current?.sid === match[1]) return;
  if (!openVersions(match[1], null, false)) history.replaceState(null, "", location.pathname + location.search);
}
addEventListener("hashchange", fromAddress);
fromAddress();
