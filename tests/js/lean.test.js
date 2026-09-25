// L1: the lean marker's renderer (js/lean.js), its sheet (text only, R26), the two
// Display switches (you-edits.js, profile.schema.json, ProfileStore) and rank-gate.js
// applying them before first paint; R43's one shared "Read here" choice
// (reader/core.js readChoice). A small stand-in document records what the renderer
// builds and throws on any HTML-parsing entry point, so a feed or repo string can only
// ever arrive as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  LEAN_SCALE, NOT_ON_US_SCALE, basisText, countryCode, countryName, leanHit, leanMark, leanMarker, leanSheetContent,
  leanWord, setBasis, OUTLET_NOT_STORY,
} from "../../app/static/js/lean.js";
import { readChoice } from "../../app/static/js/reader/core.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { validateProfile } from "../../app/static/js/profile/validate.js";
import { MemoryStorage, ProfileStore } from "../../app/static/js/profile/store.js";
import { leanColorOn, leanMarkersOn, withLeanColor, withLeanMarkers } from "../../app/static/js/profile/you-edits.js";
import { profileKey } from "../../app/static/js/ranker.js";

const schema = JSON.parse(readFileSync(new URL("../../app/static/profile.schema.json", import.meta.url), "utf-8"));

// --- A stand-in document: elements that record attributes, children and text. ---
class Node {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.parentNode = null;
    this._text = "";
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(_) { throw new Error("innerHTML used"); }
  set outerHTML(_) { throw new Error("outerHTML used"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML used"); }
  get all() { return [this, ...this.children.flatMap((c) => c.all)]; }
  querySelector(sel) { return this.all.find((n) => n !== this && n.className.split(" ").includes(sel.replace(/^\./, ""))) || null; }
}
const doc = { createElement: (tag) => new Node(tag) };

test("each US-scale bucket draws five dots, its own named by its class; hidden from screen readers", () => {
  LEAN_SCALE.forEach((lean, index) => {
    assert.deepEqual(leanMark(lean), { kind: "scale", lean, index, label: `Lean: ${lean}` });
    const node = leanMarker(lean, { doc });
    assert.equal(node.tag, "span");
    assert.equal(node.className, `lean lean--${lean}`);
    assert.equal(node.getAttribute("aria-hidden"), "true");
    assert.equal(node.children.length, 5);
    assert.ok(node.children.every((d) => d.tag === "i" && d.children.length === 0 && d.textContent === ""));
  });
});

test("state media shows the word State, no dots", () => {
  assert.equal(leanMark("state").label, "Lean: state media");
  const node = leanMarker("state", { doc });
  assert.equal(node.className, "lean lean--state");
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].className, "lean-state");
  assert.equal(node.textContent, "State");
});

test("non-us, a missing lean and anything unknown get no marker at all", () => {
  for (const lean of ["non-us", undefined, null, "", "far-left", "__proto__", "constructor", 3]) {
    assert.equal(leanMark(lean), null, String(lean));
    assert.equal(leanMarker(lean, { doc }), null, String(lean));
    assert.equal(leanHit("npr", lean, doc), null, String(lean));
    assert.equal(leanSheetContent({ lean }, doc), null, String(lean));
  }
  assert.equal(leanWord("non-us"), "");
  assert.equal(leanWord("toString"), "");
});

// --- U3: one marker family. Outside the US scale, the outlet's home country. ---

test("a non-us outlet shows its home country's code, a US-scale or state one never does", () => {
  assert.deepEqual(leanMark("non-us", "PK"), { kind: "country", lean: "non-us", code: "PK", label: "Country: PK" });
  const node = leanMarker("non-us", { country: "PK", doc });
  assert.equal(node.className, "lean lean--country");
  assert.equal(node.getAttribute("aria-hidden"), "true");
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].className, "lean-code");
  assert.equal(node.textContent, "PK");
  assert.equal(leanMarker("center", { country: "US", doc }).children.length, 5, "dots, not a code");
  assert.equal(leanMarker("state", { country: "QA", doc }).textContent, "State");
  const labelled = leanMarker("non-us", { country: "SG", labelled: true, doc });
  assert.equal(labelled.getAttribute("role"), "img");
  assert.equal(labelled.getAttribute("aria-label"), "Country: SG");
  assert.equal(labelled.children[0].getAttribute("aria-hidden"), "true");
});

test("a country is used only in the ISO alpha-2 shape; anything else is no marker", () => {
  for (const bad of ["pk", "PAK", "P", "", null, undefined, 7, "<b", "__proto__"]) {
    assert.equal(countryCode(bad), null, String(bad));
    assert.equal(leanMark("non-us", bad), null, String(bad));
    assert.equal(leanMarker("non-us", { country: bad, doc }), null, String(bad));
    assert.equal(leanHit("dawn_pk", "non-us", doc, bad), null, String(bad));
  }
  assert.equal(countryName("pk"), "");
});

test("the country's tap target is named for it; the other-side line's carries its own class", () => {
  const hit = leanHit("dawn_pk", "non-us", doc, "PK");
  assert.deepEqual(hit.attrs, { type: "button", "data-lean-source": "dawn_pk", "aria-haspopup": "dialog", "aria-label": "Country: PK" });
  assert.equal(hit.className, "lean-hit");
  assert.equal(leanHit("wsj_world", "center-right", doc, "US", "lean-hit--other").className, "lean-hit lean-hit--other");
});

test("the country sheet names the country, says US ratings do not apply, and keeps basis and ownership as text", () => {
  assert.equal(countryName("PK"), "Pakistan");
  assert.equal(countryName("HK"), "Hong Kong");
  const evil = '<img src=x onerror="alert(1)">';
  const content = leanSheetContent({ lean: "non-us", country: "PK", basis: evil, ownership: "state-funded" }, doc);
  assert.equal(content.querySelector(".lean-sheet-dots"), null, "no scale for an outlet off the US axis");
  assert.equal(content.querySelector(".lean-sheet-word").textContent, "Pakistan");
  assert.equal(content.querySelector(".lean-sheet-scope").textContent, NOT_ON_US_SCALE);
  assert.match(NOT_ON_US_SCALE, /Where this outlet is based/);
  assert.match(NOT_ON_US_SCALE, /US left and right ratings do not apply/);
  assert.equal(content.querySelector(".lean-sheet-basis").textContent, evil, "the basis arrives verbatim, as text");
  assert.equal(content.querySelector(".lean-sheet-label").textContent, "Why no US rating");
  assert.equal(content.querySelector(".lean-sheet-owner").textContent, "State funded");
  assert.equal(content.querySelector(".lean-sheet-note"), null, "it rates nothing, so no outlet-not-story line");
  assert.equal(leanSheetContent({ lean: "non-us" }, doc), null, "no country, no sheet");
});

test("a labelled marker is an image named for its bucket, its dots hidden", () => {
  const node = leanMarker("center-right", { labelled: true, doc });
  assert.equal(node.getAttribute("role"), "img");
  assert.equal(node.getAttribute("aria-label"), "Lean: center-right");
  assert.equal(node.getAttribute("aria-hidden"), null);
  assert.ok(node.children.every((d) => d.getAttribute("aria-hidden") === "true"));
  const state = leanMarker("state", { labelled: true, doc });
  assert.equal(state.getAttribute("aria-label"), "Lean: state media");
  assert.equal(state.children[0].getAttribute("aria-hidden"), "true");
});

test("the row's tap target names the lean and the source, and needs both", () => {
  const hit = leanHit("fox_politics", "right", doc);
  assert.equal(hit.tag, "button");
  assert.equal(hit.className, "lean-hit");
  assert.deepEqual(hit.attrs, { type: "button", "data-lean-source": "fox_politics", "aria-haspopup": "dialog", "aria-label": "Lean: right" });
  assert.equal(leanHit("", "right", doc), null);
  assert.equal(leanHit(undefined, "right", doc), null);
});

test("the sheet sets every string as text: a hostile basis and ownership stay text", () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const content = leanSheetContent({ lean: "left", basis: evil, ownership: `state-owned ${evil}` }, doc);
  const texts = content.all.map((n) => n._text);
  assert.ok(texts.includes(evil), "the basis arrives verbatim, as text");
  assert.ok(texts.some((t) => t.startsWith("State owned") && t.includes("<script>")), "the ownership too");
  assert.ok(content.all.every((n) => ["div", "p", "span", "i"].includes(n.tag)), "no element but the renderer's own");
  assert.equal(content.querySelector(".lean-sheet-word").textContent, "Left");
  assert.equal(content.querySelector(".lean-sheet-note").textContent, OUTLET_NOT_STORY);
  assert.equal(content.querySelector(".lean-sheet-dots").className, "lean-sheet-dots lean--left");
});

test("the sheet for state media has no scale, and fills its basis later, as text", () => {
  const content = leanSheetContent({ lean: "state", ownership: "state-funded" }, doc);
  assert.equal(content.querySelector(".lean-sheet-dots"), null);
  assert.equal(content.querySelector(".lean-sheet-word").textContent, "State media");
  assert.equal(content.querySelector(".lean-sheet-owner").textContent, "State funded");
  const why = content.querySelector(".lean-sheet-basis").parentNode;
  assert.equal(why.hidden, true, "no basis yet: its part stays hidden");
  setBasis(content, "<b>Qatari</b> state-funded.");
  assert.equal(content.querySelector(".lean-sheet-basis").textContent, "<b>Qatari</b> state-funded.");
  assert.equal(why.hidden, false);
  setBasis(content, 42);
  assert.equal(why.hidden, true, "a non-string basis shows nothing");
});

test("the basis drops a slice's fetch-check note and keeps the rest as written", () => {
  assert.equal(basisText("F5 2026-09-24: live-verified with fetcher.fetch (58 items, newest same-day, description up to 230 chars). Common convention rates it Center-Left."),
    "Common convention rates it Center-Left.");
  const plain = "research/sources-landscape.md RECOMMENDED SET rates NPR Center-Left; US public broadcaster.";
  assert.equal(basisText(plain), plain);
  assert.equal(basisText("F2 feed repair 2026-09-24: kept."), "F2 feed repair 2026-09-24: kept.");
  assert.equal(basisText(undefined), "");
});

// --- The Display switches. ---

test("lean markers default on and grey; an older profile without the fields reads the same", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(leanMarkersOn(p), true);
  assert.equal(leanColorOn(p), false);
  delete p.display;
  assert.equal(leanMarkersOn(p), true);
  assert.equal(leanColorOn(p), false);
});

test("each switch writes its own field and nothing when it would not change", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.equal(withLeanMarkers(p, true), null);
  assert.equal(withLeanColor(p, false), null);
  assert.equal(withLeanMarkers(p, "no"), null);
  const off = withLeanMarkers(p, false);
  assert.deepEqual(off.display, { summaries: "all", lean_markers: false });
  const colored = withLeanColor(off, true);
  assert.deepEqual(colored.display, { summaries: "all", lean_markers: false, lean_color: true });
  assert.equal(p.display.lean_markers, undefined, "the input profile is not mutated");
});

test("the schema takes the two booleans and refuses anything else there", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(validateProfile({ ...p, display: { summaries: "top", lean_markers: false, lean_color: true } }, schema), []);
  assert.ok(validateProfile({ ...p, display: { lean_markers: "off" } }, schema).length > 0);
  assert.ok(validateProfile({ ...p, display: { lean_color: 1 } }, schema).length > 0);
  assert.ok(validateProfile({ ...p, display: { lean_colour: true } }, schema).length > 0);
});

test("ProfileStore saves the switches as one version each and reads them back", () => {
  const store = new ProfileStore({ storage: new MemoryStorage(), schema, seedDefault: buildDefaultProfile, now: () => "2026-09-24T00:00:00Z" });
  const a = store.save(withLeanMarkers(store.current(), false));
  assert.equal(a.ok, true);
  const b = store.save(withLeanColor(store.current(), true));
  assert.equal(b.ok, true);
  assert.equal(leanMarkersOn(store.current()), false);
  assert.equal(leanColorOn(store.current()), true);
  assert.equal(store.history().length, 3);
});

// rank-gate.js applies both before first paint, the same vm harness as history-gate.test.js.
const GATE = readFileSync(new URL("../../app/static/js/rank-gate.js", import.meta.url), "utf-8");
function runGate(stored) {
  const classes = new Set();
  const appended = [];
  const root = {
    getAttribute: () => profileKey(buildDefaultProfile("2026-09-24T00:00:00Z")),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  const values = { "almanac.profile.store.v1": stored ? JSON.stringify({ history: [{ version: 1, profile: stored }] }) : null };
  vm.runInNewContext(GATE, {
    localStorage: { getItem: (k) => (Object.hasOwn(values, k) ? values[k] : null) },
    document: { documentElement: root, createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
    window: {}, setTimeout: () => 0, JSON,
  });
  return { classes: [...classes].sort(), scripts: appended.length };
}

test("rank-gate sets lean-off and lean-color before first paint, and no re-rank for display alone", () => {
  const p = buildDefaultProfile("2026-09-24T00:00:00Z");
  assert.deepEqual(runGate(null), { classes: [], scripts: 0 });
  assert.deepEqual(runGate(p), { classes: [], scripts: 0 });
  assert.deepEqual(runGate({ ...p, display: { lean_markers: false } }), { classes: ["lean-off"], scripts: 0 });
  assert.deepEqual(runGate({ ...p, display: { lean_color: true } }), { classes: ["lean-color"], scripts: 0 });
  assert.deepEqual(runGate({ ...p, display: { summaries: "top", lean_markers: false, lean_color: true } }),
    { classes: ["lean-color", "lean-off", "summaries-top"], scripts: 0 });
});

// --- R43: the one choice a "Read here" row names and the reader opens. ---

const CANDS = [["a1", "bbc", 900, "u"], ["a2", "axios", 4000, "u"], ["a3", "npr", 5000, "u"]];

test("readChoice opens the lead when it has a body, with its source", () => {
  assert.deepEqual(readChoice(CANDS, "a1", { npr: 3 }), { id: "a1", source_id: "bbc" });
});

test("readChoice without the lead follows trust, then length, the build's own rule", () => {
  assert.deepEqual(readChoice(CANDS, "zz"), { id: "a3", source_id: "npr" });
  assert.deepEqual(readChoice(CANDS, "zz", { axios: 1.5 }), { id: "a2", source_id: "axios" });
  assert.deepEqual(readChoice(CANDS, "zz", { npr: 0.2, axios: 0.3 }), { id: "a1", source_id: "bbc" });
});

test("readChoice leaves out members already tried, for the fallback past a missing body", () => {
  assert.deepEqual(readChoice(CANDS, "a1", {}, new Set(["a1"])), { id: "a3", source_id: "npr" });
  assert.deepEqual(readChoice(CANDS, "zz", {}, new Set(["a3"])), { id: "a2", source_id: "axios" });
  assert.equal(readChoice(CANDS, "zz", {}, new Set(["a1", "a2", "a3"])), null);
});

test("readChoice has nothing to open for no candidates or an unsafe id", () => {
  assert.equal(readChoice([], "a1"), null);
  assert.equal(readChoice(undefined, "a1"), null);
  assert.equal(readChoice([["../x", "s", 9, "u"], "junk"], "zz"), null);
});
