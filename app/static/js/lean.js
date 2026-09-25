// L1: the lean marker, a quiet five-dot scale after a source name (left, center-left,
// center, center-right, right; the source's own bucket filled, the other four hollow
// rings), "STATE" in the meta voice for state media. U3: one marker family for every
// source, so an outlet outside the US left-right axis ("non-us") shows the two-letter
// code of its home country (sources.json `country`, ISO 3166-1 alpha-2) in the same
// small caps as "STATE", the angle it writes from. Only a source with neither a lean nor
// a country gets nothing. It reads as metadata, in the meta tone, and never adds height
// to a line (style.css ".lean").
//
// One renderer for every place a source name shows: story rows (app/build.py writes
// the same markup at build time, app/lean.py), the coverage view, the reader's byline,
// the You page's source picker, and the bundles carousel later (docs/DESIGN-bundles.md).
// The lean is about the outlet, never the story (R10: lean is repo owned, sources.json).
//
// Every feed or repo string reaches the page as text only (R26): nothing here builds or
// parses markup. `doc` is injectable so Node tests run these with a stand-in document.

export const LEAN_SCALE = Object.freeze(["left", "center-left", "center", "center-right", "right"]);

// Plain words for the sheet and for screen readers (R34: no jargon).
const WORDS = Object.freeze({
  left: "Left",
  "center-left": "Center-left",
  center: "Center",
  "center-right": "Center-right",
  right: "Right",
  state: "State media",
});

const COUNTRY = /^[A-Z]{2}$/;

/** `value` when it has the ISO 3166-1 alpha-2 shape (two upper-case letters), else null. */
export function countryCode(value) {
  return typeof value === "string" && COUNTRY.test(value) ? value : null;
}

// Intl's English region names, with the two whose official form reads long in a sheet.
const COUNTRY_WORDS = Object.freeze({ HK: "Hong Kong", MO: "Macao" });

/** The country's name in English ("Pakistan"), or the code itself where the device has
 * no region names. */
export function countryName(code) {
  if (!countryCode(code)) return "";
  if (Object.hasOwn(COUNTRY_WORDS, code)) return COUNTRY_WORDS[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

/** What a source's marker shows: {kind: "scale", lean, index, label} for a bucket on
 * the scale, {kind: "state", lean, label} for state media, {kind: "country", lean, code,
 * label} for any other source with a home country (U3: non-us), or null (no lean and no
 * country) for no marker at all. The label is the same bytes app/lean.py writes. */
export function leanMark(lean, country) {
  const index = LEAN_SCALE.indexOf(lean);
  if (index >= 0) return { kind: "scale", lean, index, label: `Lean: ${lean}` };
  if (lean === "state") return { kind: "state", lean, label: "Lean: state media" };
  const code = countryCode(country);
  if (code) return { kind: "country", lean, code, label: `Country: ${code}` };
  return null;
}

export function leanWord(lean) {
  return Object.hasOwn(WORDS, lean) ? WORDS[lean] : "";
}

/**
 * The marker node for `lean` (and, U3, `country`), or null when the source gets none.
 * Five empty <i> dots for a scale bucket (CSS fills the one its `lean--<bucket>` class
 * names), the word "State" for state media, or the country code. By default the whole
 * marker is aria-hidden, for a place where a separate control or the text around it
 * already names it (a story row's .lean-hit button); `labelled` makes the marker itself
 * an image named by its label with its contents hidden, for a place where it stands
 * alone (the coverage view, the source picker). Byte for byte the markup app/lean.py
 * writes at build time.
 */
export function leanMarker(lean, { labelled = false, country = null, doc = globalThis.document } = {}) {
  const mark = leanMark(lean, country);
  if (!mark) return null;
  const node = doc.createElement("span");
  node.className = `lean lean--${mark.kind === "country" ? "country" : mark.lean}`;
  if (labelled) {
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", mark.label);
  } else {
    node.setAttribute("aria-hidden", "true");
  }
  if (mark.kind !== "scale") {
    const word = doc.createElement("span");
    word.className = mark.kind === "state" ? "lean-state" : "lean-code";
    word.textContent = mark.kind === "state" ? "State" : mark.code;
    if (labelled) word.setAttribute("aria-hidden", "true");
    node.append(word);
    return node;
  }
  for (let i = 0; i < LEAN_SCALE.length; i++) {
    const dot = doc.createElement("i");
    if (labelled) dot.setAttribute("aria-hidden", "true");
    node.append(dot);
  }
  return node;
}

/** The row's 48dp tap target for its marker: a sibling of the row's own link, never
 * inside it, laid over the marker by CSS anchor positioning (style.css .lean-hit), so a
 * tap on the marker opens the lean sheet and a tap anywhere else still opens the story.
 * Named for screen readers; null when the source gets no marker. `extraClass` names a
 * second target in the same row (U3: "lean-hit--other", the other-side line's). */
export function leanHit(sourceId, lean, doc = globalThis.document, country = null, extraClass = "") {
  const mark = leanMark(lean, country);
  if (!mark || typeof sourceId !== "string" || !sourceId) return null;
  const button = doc.createElement("button");
  button.className = extraClass ? `lean-hit ${extraClass}` : "lean-hit";
  button.setAttribute("type", "button");
  button.setAttribute("data-lean-source", sourceId);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-label", mark.label);
  return button;
}

// sources.json's lean_basis cites where a rating came from. Some entries open with a
// fetch-check note from the slice that added the source ("F5 2026-09-24: live-verified
// with fetcher.fetch (25 items, ...)."), which says nothing about lean; the sheet
// leaves that sentence out and shows the rest as written. Display only: the file keeps
// every word.
const FETCH_NOTE = /^F\d+ \d{4}-\d{2}-\d{2}: live-verified with fetcher\.fetch \([^)]*\)\.\s*/;

export function basisText(basis) {
  if (typeof basis !== "string") return "";
  return basis.replace(FETCH_NOTE, "").trim();
}

function ownershipWords(value) {
  if (typeof value !== "string" || !value) return "";
  const words = value.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const OUTLET_NOT_STORY = "This rates the outlet as a whole, not this story.";
export const NOT_ON_US_SCALE = "Where this outlet is based. US left and right ratings do not apply to it.";

/**
 * The lean sheet's content for one source: the scale (or "State media") with the
 * bucket in words, why it is rated so (sources.json lean_basis), who owns it where
 * sources.json says, and one line saying the rating is the outlet's, not the story's.
 * U3: for a country marker, the country's name and a line saying that is where the
 * outlet is based and that US left and right ratings do not apply, then the same basis
 * and ownership. `source` is {lean, country, basis, ownership}; every value is set as
 * text (R26). `basis` may arrive later (the catalog is fetched on first open): pass
 * undefined and fill the returned node's `.lean-sheet-basis` with setBasis(). Null for
 * a source with no mark.
 */
export function leanSheetContent(source, doc = globalThis.document) {
  const mark = leanMark(source?.lean, source?.country);
  if (!mark) return null;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const wrap = el("div", "lean-sheet");
  const head = el("div", "lean-sheet-head");
  if (mark.kind === "scale") {
    const scale = el("div", "lean-sheet-scale");
    scale.setAttribute("aria-hidden", "true");
    const dots = el("span", `lean-sheet-dots lean--${mark.lean}`);
    for (let i = 0; i < LEAN_SCALE.length; i++) dots.append(doc.createElement("i"));
    scale.append(el("span", "lean-sheet-end", "Left"), dots, el("span", "lean-sheet-end", "Right"));
    head.append(scale);
  }
  if (mark.kind === "country") {
    head.append(el("p", "lean-sheet-word", countryName(mark.code)), el("p", "lean-sheet-scope", NOT_ON_US_SCALE));
  } else {
    head.append(el("p", "lean-sheet-word", leanWord(mark.lean)));
  }
  wrap.append(head);
  const why = el("div", "lean-sheet-part");
  why.append(el("p", "lean-sheet-label", mark.kind === "country" ? "Why no US rating" : "Why this rating"));
  const basis = el("p", "lean-sheet-basis", basisText(source.basis) || "");
  why.append(basis);
  why.hidden = !basis.textContent;
  wrap.append(why);
  const owner = ownershipWords(source.ownership);
  if (owner) {
    const part = el("div", "lean-sheet-part");
    part.append(el("p", "lean-sheet-label", "Ownership"), el("p", "lean-sheet-owner", owner));
    wrap.append(part);
  }
  if (mark.kind !== "country") wrap.append(el("p", "lean-sheet-note", OUTLET_NOT_STORY));
  return wrap;
}

/** Fills a lean sheet's "Why this rating" once the catalog arrives (text only, R26). */
export function setBasis(content, basis) {
  const node = content?.querySelector?.(".lean-sheet-basis");
  if (!node) return;
  node.textContent = basisText(basis);
  node.parentNode.hidden = !node.textContent;
}
