// U3 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/u3_check.mjs <built dist dir> [<screenshot dir>] [<dist built before U3>]
// Serves the built site the way Cloudflare Pages does (pretty URLs, the build's own CSP
// headers) in headless Chrome at 360x780 CSS px, DPR 3, and checks the two-line meta and
// the one marker family:
//   - across a full build, every panel and every folded row: no source name of 24
//     characters or fewer is cut, none is cut to nothing, with summaries on every story
//     (the default); the same count with summaries on the lead stories only is printed;
//   - every row shows its marker: five dots on the US scale (its bucket a solid dot, the
//     rest hollow rings), "State", or its home country's code for an outlet outside it;
//   - line 2 shows exactly when the row has "N sources" or "Read here", except beside a
//     river thumbnail, where every row leads line 2 with its age; each line is 11dp;
//   - a tap on a marker opens the lean sheet (a country code: the country, the line that
//     US ratings do not apply), on a row and on the other-side line, whose label names the
//     outlet then its marker, never the lean in words; a tap on line 2 below the marker
//     still reaches the coverage view or the story;
//   - Lean markers off: no dots, codes or State, and no gap where one was; Color on: only
//     the solid dots take color, codes and State stay grey;
//   - CLS on Today with markers on and off, dark and light, and zero CSP violations.
// Exits 1 on any failure. Screenshots (optional) are named u3-*.png; with a third
// argument the same meta line is also zoomed on the build from before U3.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg, beforeArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const site = await serve(dist, parseHeaders(readFileSync(join(dist, "_headers"), "utf-8")));
const before = beforeArg ? await serve(resolve(beforeArg), parseHeaders(readFileSync(join(resolve(beforeArg), "_headers"), "utf-8"))) : null;
const chrome = await launch("u3-check");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
});
if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0; window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

async function shot(name, clip) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

function store(display) {
  const base = buildDefaultProfile("2026-09-24T00:00:00Z");
  if (!display) return null;
  const next = structuredClone(base);
  next.display = { ...next.display, ...display };
  return { history: [{ version: 1, timestamp: base.updated_at, profile: base },
    { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...next, profile_version: 2 } }] };
}

const cspAll = [];
async function visit(stored, scheme = "dark", origin = site.origin) {
  cspAll.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}/` });
  await sleep(600);
  await evaluate(stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : "localStorage.clear()");
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`).catch(() => false)) break;
    await sleep(100);
  }
  await sleep(700);
}

/** Every row in every panel, folded ones opened, as measured: its name shown and whole,
 * its marker, its two lines. Leaves the page as it found it. */
const ROWS = `(() => {
  const data = JSON.parse(document.getElementById("rank-input").content.textContent);
  const leads = new Map(data.pool.clusters.map((c) => [c.id, c.lead]));
  const byId = new Map(data.pool.articles.map((a) => [a.id, a]));
  const panels = [...document.querySelectorAll(".panel")];
  const hidden = panels.map((p) => p.hidden);
  const shut = [...document.querySelectorAll("details.more-rest")].filter((d) => !d.open);
  panels.forEach((p) => { p.hidden = false; });
  shut.forEach((d) => { d.open = true; });
  const shown = (n) => !!n && n.getClientRects().length > 0;
  const out = [];
  for (const panel of panels) {
    for (const li of panel.querySelectorAll("li.story[data-sid]")) {
      const sid = li.dataset.sid;
      const source = byId.get(leads.get(sid) || sid)?.source_id;
      const meta = li.querySelector(".meta");
      const name = meta.querySelector(".meta-source");
      const lean = meta.querySelector(".lean");
      const lines = [...meta.querySelectorAll(".meta-line")].filter(shown);
      const second = meta.querySelector(".meta-line--2");
      const beside = !!li.querySelector(".story-media") && li.classList.contains("story--river")
        && (document.documentElement.classList.contains("summaries-top") || !li.querySelector(".dek"));
      out.push({ panel: panel.dataset.section, sid, source, lean: data.leans[source] || null, country: (data.countries || {})[source] || null,
        name: name?.textContent || "", nameShown: name ? name.clientWidth : 0, nameFull: name ? name.scrollWidth : 0,
        cls: lean?.className || null, drawn: shown(lean), dots: lean ? lean.querySelectorAll("i").length : 0,
        filled: lean ? [...lean.querySelectorAll("i")].findIndex((d) => getComputedStyle(d).opacity === "1") : -1,
        code: lean?.querySelector(".lean-code")?.textContent || "", state: lean?.querySelector(".lean-state")?.textContent || "",
        lineH: lines.map((l) => Math.round(l.getBoundingClientRect().height * 10) / 10), metaH: meta.getBoundingClientRect().height,
        has2: !!second && second.children.length > 0, beside,
        ageShown: shown(meta.querySelector(".meta-age")),
        countCut: [...meta.querySelectorAll(".meta-count, .meta-age")].some((n) => n.scrollWidth > n.clientWidth + 1) });
    }
  }
  panels.forEach((p, i) => { p.hidden = hidden[i]; });
  shut.forEach((d) => { d.open = false; });
  return out;
})()`;

const SCALE = ["left", "center-left", "center", "center-right", "right"];

/** Scrolls a panel so the first row whose source is `name` sits 120dp under the tabs;
 * opens its fold if it has one. False when no row names it. */
async function toName(panel, name) {
  const ok = await evaluate(`(() => { const p = document.getElementById("section-${panel}");
    const li = [...p.querySelectorAll("li.story[data-sid]")].find((l) => l.querySelector(".meta-source")?.textContent === ${JSON.stringify(name)});
    if (!li) return false;
    const fold = li.closest("details"); if (fold) fold.open = true;
    p.scrollTop = li.offsetTop - 120; return true; })()`);
  await sleep(400);
  return ok;
}

async function tab(id) {
  await evaluate(`document.getElementById("tab-${id}").click()`);
  await sleep(600);
}

/** A 2x close-up (6 device px per dp) of the meta of the first row naming `name`. */
async function zoom(file, name) {
  const b = await evaluate(`(() => { const m = [...document.querySelectorAll("#section-today .meta")].find((n) => n.querySelector(".meta-source")?.textContent === ${JSON.stringify(name)});
    if (!m) return null; const li = m.closest("li"); const fold = li.closest("details"); if (fold) fold.open = true;
    document.getElementById("section-today").scrollTop = li.offsetTop - 200; return true; })()`);
  if (!b) return false;
  await sleep(400);
  const r = await evaluate(`(() => { const m = [...document.querySelectorAll("#section-today .meta")].find((n) => n.querySelector(".meta-source")?.textContent === ${JSON.stringify(name)});
    const b = m.getBoundingClientRect(); return { x: b.left - 6, y: b.top - 8, width: 332, height: b.height + 16 }; })()`);
  await shot(file, { ...r, scale: 2 });
  return true;
}

// 1. Markers on (the default), dark: every row's name, marker and lines.
await visit(null, "dark");
const clsOn = await evaluate("window.__cls");
let rows = await evaluate(ROWS);
const short = rows.filter((r) => r.name && r.name.length <= 24);
const cutShort = short.filter((r) => r.nameFull > r.nameShown + 1);
const cutAll = rows.filter((r) => r.nameFull > r.nameShown + 1);
check(rows.length > 0 && rows.every((r) => r.name), `${rows.length} rows across every panel all name their source`);
check(cutShort.length === 0, `no source name of 24 characters or fewer is cut (${short.length} rows; cut ${cutShort.length}: ${[...new Set(cutShort.map((r) => r.name))].join(", ")})`);
check(rows.every((r) => r.nameShown >= Math.min(r.nameFull, 120)), "no source name is cut below 120dp, so never to nothing");
console.log(`  names cut, summaries on every story: ${cutAll.length} of ${rows.length} (${[...new Set(cutAll.map((r) => `${r.name} (${r.name.length})`))].join(", ")})`);
const scale = rows.filter((r) => SCALE.includes(r.lean));
const state = rows.filter((r) => r.lean === "state");
const coded = rows.filter((r) => !SCALE.includes(r.lean) && r.lean !== "state");
check(scale.length > 0 && scale.every((r) => r.drawn && r.dots === 5 && r.filled === SCALE.indexOf(r.lean)),
  `${scale.length} US-scale rows show five dots, their own bucket solid`);
check(state.every((r) => r.drawn && r.dots === 0 && r.state === "State"), `${state.length} state-media rows show State`);
check(coded.length > 0 && coded.every((r) => r.drawn && r.cls === "lean lean--country" && r.code === r.country),
  `${coded.length} rows outside the US scale show their home country (${[...new Set(coded.map((r) => r.code))].sort().join(" ")})`);
check(rows.every((r) => r.lineH.every((h) => Math.abs(h - 11) < 0.5) && (r.lineH.length === 1 || Math.abs(r.metaH - 27) < 0.5)),
  "every meta line is 11dp, two lines 27dp");
check(rows.filter((r) => !r.beside).every((r) => r.lineH.length === (r.has2 ? 2 : 1) && r.ageShown),
  "away from a thumbnail, line 2 shows exactly when the row has N sources or Read here");
const beside = rows.filter((r) => r.beside);
check(beside.every((r) => r.lineH.length === 2 && !r.ageShown), `beside a thumbnail, all ${beside.length} rows lead line 2 with the age`);
check(rows.every((r) => !r.countCut), "no source count or age is cut");
check(clsOn === 0, `CLS markers on, dark: ${clsOn}`);

// Summaries on the lead stories only: printed, the numbers the report carries.
await visit(store({ summaries: "top" }), "dark");
const clsTop = await evaluate("window.__cls");
const top = await evaluate(ROWS);
const topCut = top.filter((r) => r.nameFull > r.nameShown + 1);
const topShort = topCut.filter((r) => r.name.length <= 24);
console.log(`  names cut, summaries on lead stories only: ${topCut.length} of ${top.length}, ${topShort.length} of 24 characters or fewer, `
  + `each still showing at least ${Math.min(...topShort.map((r) => r.nameShown), Infinity)} of its ${Math.max(...topShort.map((r) => r.nameFull), 0)}dp`);
check(top.every((r) => r.nameShown >= Math.min(r.nameFull, 120)), "summaries on lead stories only: no name cut below 120dp");
check(top.filter((r) => r.beside).every((r) => r.lineH.length === 2), "summaries on lead stories only: every row beside a thumbnail takes two lines");
check(clsTop === 0, `CLS summaries on lead stories only: ${clsTop}`);
await tab("today");
await evaluate(`(() => { const p = document.getElementById("section-today"); const li = p.querySelector("li.story--river"); p.scrollTop = li.offsetTop - 40; })()`);
await sleep(400);
await shot("u3-today-top-dark.png");

// 2. Screens: Today and Asia with the long names, dark and light.
const NAMES = ["The Conversation", "Business Times Singapore", "Washington Examiner", "WSJ World News"];
for (const scheme of ["dark", "light"]) {
  await visit(null, scheme);
  if (scheme === "light") check((await evaluate("window.__cls")) === 0, "CLS markers on, light: 0");
  await evaluate(`(() => { const p = document.getElementById("section-today"); const li = p.querySelector("li.story--river"); p.scrollTop = li.offsetTop - 40; })()`);
  await sleep(400);
  await shot(`u3-today-${scheme}.png`);
  for (const name of NAMES) {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "-");
    let where = "today";
    await tab("asia");
    if (await toName("asia", name)) where = "asia";
    else { await tab("today"); if (!(await toName("today", name))) { console.log(`  (no row names ${name} in this pool)`); continue; } }
    await shot(`u3-${where}-${slug}-${scheme}.png`);
  }
  await tab("asia");
  await evaluate(`document.getElementById("section-asia").scrollTop = 0`);
  await sleep(300);
  await shot(`u3-asia-${scheme}.png`);
  await tab("today");
  // A "Read here · <outlet>" row.
  const read = await evaluate(`(() => { const p = document.getElementById("section-today");
    const li = [...p.querySelectorAll("li.story[data-sid]")].find((l) => l.querySelector(".meta-read-source")?.getClientRects().length);
    if (!li) return null; const fold = li.closest("details"); if (fold) fold.open = true; p.scrollTop = li.offsetTop - 120;
    return { label: li.querySelector(".meta-read-label").textContent, outlet: li.querySelector(".meta-read-source").textContent,
      sep: getComputedStyle(li.querySelector(".meta-read-source"), "::before").content }; })()`);
  await sleep(400);
  if (read) await shot(`u3-read-outlet-${scheme}.png`);
  // B5: a face with full text is what "Read here" opens, and full text scores 15 toward
  // the face, so a pool can hold no row whose text comes from another outlet; l1_check
  // proves that case on its own fixture. When one exists, it must read right.
  if (scheme === "dark" && !read) console.log("  (no Read here row names another outlet in this pool: each row's full text is its own face's)");
  else if (scheme === "dark") check(read.label === "Read here" && read.outlet && read.sep.includes("·"),
    `a row names the other outlet whose text opens: "${read?.label} · ${read?.outlet}"`);
  await zoom(`u3-zoom-after-${scheme}.png`, "BBC World");
}

// 3. Taps: a country code opens its sheet; line 2 below a marker is not the marker's.
await visit(null, "dark");
const codeRow = await evaluate(`(() => { const p = document.getElementById("section-today");
  const li = [...p.querySelectorAll("li.story[data-sid]")].find((l) => l.querySelector(".meta .lean--country") && !l.closest("details"));
  p.scrollTop = li.offsetTop - 200; return li.dataset.sid; })()`);
await sleep(400);
const hitAt = await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${codeRow}"]');
  const m = li.querySelector(".meta .lean").getBoundingClientRect(); const hit = li.querySelector(".lean-hit").getBoundingClientRect();
  return { on: document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2)?.className, w: hit.width, h: hit.height,
    covers: hit.left <= m.left && hit.right >= m.right && hit.top <= m.top && hit.bottom >= m.bottom }; })()`);
check(hitAt.on === "lean-hit" && hitAt.covers && hitAt.w >= 48 && hitAt.h >= 48, `a tap on a country code hits its 48dp target (${hitAt.on})`);
await evaluate(`document.querySelector('#section-today li.story[data-sid="${codeRow}"] .lean-hit').click()`);
await sleep(900);
const sheet = await evaluate(`(() => ({ open: !document.getElementById("sheet-root").hidden, title: document.getElementById("sheet-label").textContent,
  word: document.querySelector(".lean-sheet-word")?.textContent || "", scope: document.querySelector(".lean-sheet-scope")?.textContent || "",
  basis: document.querySelector(".lean-sheet-basis")?.textContent || "", dots: document.querySelectorAll(".lean-sheet-dots").length }))()`);
check(sheet.open && sheet.word.length > 2 && /US left and right ratings do not apply/.test(sheet.scope) && sheet.dots === 0 && sheet.basis.length > 10,
  `a country code opens the sheet: ${sheet.title}, "${sheet.word}", its basis shown`);
await shot("u3-sheet-country-dark.png");
await evaluate(`document.getElementById("sheet-close").click()`);
await sleep(400);
const two = await evaluate(`(() => { const p = document.getElementById("section-today");
  const li = [...p.querySelectorAll("li.story[data-sid]")].find((l) => !l.closest("details") && l.querySelector(".meta-count")
    && l.querySelector(".meta .lean") && !l.querySelector(".other-side"));
  p.scrollTop = li.offsetTop - 200; return li.dataset.sid; })()`);
await sleep(400);
const below = await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${two}"]');
  const m = li.querySelector(".meta .lean").getBoundingClientRect(); const c = li.querySelector(".meta-count").getBoundingClientRect();
  const at = document.elementFromPoint(m.left + m.width / 2, c.top + c.height / 2);
  const gap = document.elementFromPoint(m.left + m.width / 2, c.bottom + 4);
  // V1: the trigger is a 48dp band over "N sources" itself, so under a marker past it
  // the row's own link answers; either way it is the row's, never the marker's.
  const rows = (n) => !!n && n.closest("li.story") === li && !n.classList.contains("lean-hit");
  return { at: at?.className, gap: gap?.className, own: rows(at) && rows(gap) }; })()`);
check(below.own,
  `on a two-line row, line 2 under the marker is the row's, not the marker's (${below.at}; under it, ${below.gap})`);

// 4. The other-side line: the outlet then its marker, never the lean in words.
const other = await evaluate(`(() => { const o = document.querySelector("#section-today .other-side"); if (!o) return null;
  // The line itself in view (B5: a taller hero face can put it under the bottom nav).
  const li = o.closest("li"); const p = document.getElementById("section-today"); p.scrollTop += o.getBoundingClientRect().top - 300;
  return { text: o.querySelector(".other-side-label").textContent, marker: !!o.querySelector(".other-side-label .lean"), sid: li.dataset.sid }; })()`);
if (other) {
  await sleep(400);
  const words = /Other side · (left|center-left|center|center-right|right|state|non-us) ·/i;
  check(other.marker && !words.test(other.text), `the other-side line reads "${other.text}" with the row marker`);
  const hit = await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${other.sid}"]');
    const m = li.querySelector(".other-side .lean").getBoundingClientRect();
    return document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2)?.className; })()`);
  check(hit === "lean-hit lean-hit--other", `a tap on the other-side marker hits its own target (${hit})`);
  await shot("u3-other-side-dark.png");
  await evaluate(`document.querySelector('#section-today li.story[data-sid="${other.sid}"] .lean-hit--other').click()`);
  await sleep(900);
  check(!(await evaluate(`document.getElementById("sheet-root").hidden`)), "the other-side marker opens the lean sheet");
  await evaluate(`document.getElementById("sheet-close").click()`);
  await sleep(300);
  await visit(null, "light");
  await evaluate(`(() => { const li = document.querySelector("#section-today .other-side").closest("li"); document.getElementById("section-today").scrollTop = li.offsetTop - 60; })()`);
  await sleep(400);
  await shot("u3-other-side-light.png");
} else {
  console.log("  (no other-side link in this pool: its checks skipped)");
}

// 5. Markers off and color on.
for (const scheme of ["dark", "light"]) {
  await visit(store({ lean_markers: false }), scheme);
  const clsOff = await evaluate("window.__cls");
  const off = await evaluate(`(() => { const drawn = [...document.querySelectorAll(".lean, .lean-hit")].filter((n) => n.getClientRects().length).length;
    const gaps = [...document.querySelectorAll("#section-today .meta-line:first-child")].filter((l) => l.querySelector(".meta-age")).map((l) => {
      const n = l.querySelector(".meta-source").getBoundingClientRect(), s = l.querySelector(".meta-sep").getBoundingClientRect(); return s.left - n.right; });
    return { drawn, gap: Math.max(...gaps) }; })()`);
  check(off.drawn === 0 && off.gap < 0.5, `markers off (${scheme}): no dots, codes or State, and no gap after the name (${off.gap.toFixed(2)}dp)`);
  check(clsOff === 0, `CLS markers off (${scheme}): ${clsOff}`);
  await evaluate(`(() => { const p = document.getElementById("section-today"); const li = p.querySelector("li.story--river"); p.scrollTop = li.offsetTop - 40; })()`);
  await sleep(400);
  await shot(`u3-off-${scheme}.png`);
  await visit(store({ lean_color: true }), scheme);
  const color = await evaluate(`(() => { const out = { fills: {}, words: new Set(), meta: getComputedStyle(document.querySelector(".meta")).color };
    for (const m of document.querySelectorAll("#section-today .meta .lean")) {
      const on = [...m.querySelectorAll("i")].find((d) => getComputedStyle(d).opacity === "1");
      if (on) out.fills[m.className.replace("lean lean--", "")] = getComputedStyle(on).backgroundColor;
      for (const w of m.querySelectorAll(".lean-code, .lean-state")) out.words.add(getComputedStyle(w).color);
    }
    return { fills: out.fills, words: [...out.words], meta: out.meta }; })()`);
  const left = color.fills.left || color.fills["center-left"], right = color.fills.right || color.fills["center-right"];
  check(left && right && left !== right && color.fills.center && color.fills.center !== left && color.words.length === 1 && color.words[0] === color.meta,
    `color on (${scheme}): left, center and right fills differ, codes and State stay the meta grey ${color.words.join(" ")}`);
  check((await evaluate("window.__cls")) === 0, `CLS color on (${scheme}): 0`);
  await evaluate(`(() => { const p = document.getElementById("section-today"); const li = p.querySelector("li.story--river"); p.scrollTop = li.offsetTop - 40; })()`);
  await sleep(400);
  await shot(`u3-color-${scheme}.png`);
  await zoom(`u3-zoom-color-${scheme}.png`, "BBC World");
}

// 6. The same meta line on the build from before U3, for the side by side.
if (before) {
  for (const scheme of ["dark", "light"]) {
    await visit(null, scheme, before.origin);
    await zoom(`u3-zoom-before-${scheme}.png`, "BBC World");
  }
}

cspAll.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
check(cspAll.length === 0, `CSP violations across every load ${cspAll.length} ${cspAll.slice(0, 3).join(" | ")}`);
check(errors.length === 0, `page errors ${errors.length} ${errors.slice(0, 2).join(" | ")}`);
chrome.close();
site.close();
before?.close();
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
