// L1 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/l1_check.mjs <built dist dir with bodies/> [<screenshot dir>]
// Serves the built site the way Cloudflare Pages does (pretty URLs, the build's own CSP
// headers) in headless Chrome at 360x780 CSS px, DPR 3, and checks the lean marker and
// R43's "Read here · <outlet>":
//   - every Today row whose outlet sits on the US scale shows five dots with its own
//     bucket filled, state media shows "State", non-us shows nothing; the meta line
//     stays one 11dp line, the age is never cut, the marker never clipped;
//   - each row's 48dp .lean-hit sits centred on its own row's dots (anchor positioning)
//     and wins a tap there, while a tap on the headline still hits the row's link;
//   - a tap opens the lean sheet: the outlet's name, the bucket in words, the cited
//     basis (from source-catalog.json), and the outlet-not-story line;
//   - You > Display: markers off (none drawn, first paint included) and color on;
//   - "Read here · <outlet>" names the outlet of the row's data-body, a stored trust that
//     flips the pick renames it before first paint, the reader opens exactly that member,
//     and a missing body file falls back to the next member with a "Full text from" line;
//   - CLS on Today with markers on and off, and zero CSP violations.
// Exits 1 on any failure. Screenshots (optional) are named l1-*.png.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { readChoice } from "../../app/static/js/reader/core.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const html = readFileSync(join(dist, "index.html"), "utf-8");
const input = JSON.parse(html.match(/<template id="rank-input">([\s\S]*?)<\/template>/)[1]
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));

// R43 fixtures from the page's own data: a story whose lead has no body and whose
// candidates span two outlets, so trust can flip the pick; and one member to 404.
const leads = new Map(input.pool.clusters.map((c) => [c.id, c.lead]));
const flip = Object.entries(input.bodies).map(([sid, cands]) => ({ sid, cands, lead: leads.get(sid) || sid }))
  .find(({ cands, lead }) => !cands.some((c) => c[0] === lead) && new Set(cands.map((c) => c[1])).size > 1);
let flipTrust = null;
if (flip) {
  const first = readChoice(flip.cands, flip.lead, {});
  const other = flip.cands.find((c) => c[1] !== first.source_id);
  flipTrust = { source: other[1], id: other[0], was: first.id };
}
const missing = flip ? readChoice(flip.cands, flip.lead, {}).id : null;
const extra = missing ? { [`/bodies/${missing}.json`]: (req, res, own) => res.writeHead(404, own).end() } : {};

const site = await serve(dist, headers, extra);
const chrome = await launch("l1-check");
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
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  const probe = () => { const root = document.documentElement;
    if (!document.querySelector("#headlines .meta")) { requestAnimationFrame(probe); return; }
    window.__first = { off: root.classList.contains("lean-off"), color: root.classList.contains("lean-color"),
      drawn: [...document.querySelectorAll(".meta .lean")].filter((n) => n.getClientRects().length).length }; };
  requestAnimationFrame(probe);` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

function store(display, trust) {
  const base = buildDefaultProfile("2026-09-24T00:00:00Z");
  if (!display && !trust) return null;
  const next = structuredClone(base);
  if (display) next.display = { ...next.display, ...display };
  if (trust) next.trust = trust;
  return { history: [{ version: 1, timestamp: base.updated_at, profile: base },
    { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...next, profile_version: 2 } }] };
}

async function visit(stored, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}/` });
  await sleep(600);
  await evaluate(stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : "localStorage.clear()");
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`).catch(() => false)) break;
    await sleep(100);
  }
  await sleep(700);
}

// The Today rows, as drawn: marker, meta geometry, hit target placement.
const ROWS = `(() => {
  const data = JSON.parse(document.getElementById("rank-input").content.textContent);
  const leads = new Map(data.pool.clusters.map((c) => [c.id, c.lead]));
  const byId = new Map(data.pool.articles.map((a) => [a.id, a]));
  return [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => {
    const sid = li.dataset.sid;
    const source = byId.get(leads.get(sid) || sid)?.source_id;
    const meta = li.querySelector(".meta");
    const lean = meta.querySelector(".lean");
    const hit = li.querySelector(".lean-hit");
    const rest = meta.querySelector(".meta-rest");
    const read = meta.querySelector(".meta-read-source");
    const link = li.querySelector("a.story-link");
    const shown = (n) => n && n.getClientRects().length > 0;
    const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, r: r.right }; };
    const filled = lean ? [...lean.children].findIndex((d) => getComputedStyle(d).opacity === "1") : -1;
    const memberSource = link?.dataset.body ? byId.get(link.dataset.body)?.source_id : null;
    return { sid, lean: data.leans[source] || null, cls: lean?.className || null, drawn: shown(lean), filled,
      dots: lean ? lean.querySelectorAll("i").length : 0, state: lean?.textContent || "",
      metaH: meta.getBoundingClientRect().height, metaLines: meta.getClientRects().length,
      metaOver: meta.scrollWidth > meta.clientWidth + 1,
      restCut: rest ? rest.scrollWidth > rest.clientWidth + 1 : false,
      leanBox: shown(lean) ? box(lean) : null, hitBox: shown(hit) ? box(hit) : null, metaBox: box(meta),
      body: link?.dataset.body || null, readName: read?.textContent ?? null, readCut: read ? read.scrollWidth > read.clientWidth + 1 : false,
      expectRead: memberSource && memberSource !== source ? data.names[memberSource] : null, hitLabel: hit?.getAttribute("aria-label") || null };
  });
})()`;

const SCALE = ["left", "center-left", "center", "center-right", "right"];

// 1. Markers on (the default), dark.
await visit(null, "dark");
let rows = await evaluate(ROWS);
const onScale = rows.filter((r) => SCALE.includes(r.lean));
const state = rows.filter((r) => r.lean === "state");
const none = rows.filter((r) => !SCALE.includes(r.lean) && r.lean !== "state");
check(onScale.length > 0 && onScale.every((r) => r.drawn && r.dots === 5 && r.filled === SCALE.indexOf(r.lean)),
  `${onScale.length} US-scale rows show five dots with their own bucket filled`);
check(state.every((r) => r.drawn && r.dots === 0 && /state/i.test(r.state)), `${state.length} state-media rows show "State", no dots`);
check(none.every((r) => r.cls === null && r.hitBox === null), `${none.length} non-us or unrated rows show no marker and no tap target`);
check(rows.every((r) => r.metaLines === 1 && Math.abs(r.metaH - 11) < 0.5), "every meta line is one 11dp line");
check(rows.every((r) => !r.restCut), "no row's source count or age is cut");
const clipped = rows.filter((r) => r.leanBox && r.leanBox.r > r.metaBox.r + 0.5);
check(clipped.length === 0, `no marker runs past its meta line (${clipped.length})`);
const offTarget = rows.filter((r) => r.leanBox && (!r.hitBox || Math.abs(r.hitBox.x - r.leanBox.x) > 1 || Math.abs(r.hitBox.y - r.leanBox.y) > 1 || r.hitBox.w < 48 || r.hitBox.h < 48));
check(offTarget.length === 0, `every row's 48dp tap target is centred on its own dots (${offTarget.length} off)`);
check(onScale.every((r) => r.hitLabel === `Lean: ${r.lean}`), "each tap target is named \"Lean: <bucket>\"");
const reads = rows.filter((r) => r.body);
const others = reads.filter((r) => r.expectRead);
check(reads.length > 0 && reads.every((r) => r.readName === r.expectRead),
  `${reads.length} "Read here" rows name the outlet whose text opens (${others.length} another outlet's, after the mark)`);
console.log(`  another outlet's name cut to fit: ${others.filter((r) => r.readCut).length} of ${others.length}: ${others.map((r) => r.readName).join(", ")}`);
const firstOn = await evaluate("window.__first");
check(!firstOn.off && firstOn.drawn > 0, `first paint has markers (${firstOn.drawn} drawn)`);
const clsOn = await evaluate("window.__cls");
check(clsOn === 0, `CLS markers on: ${clsOn}`);
await shot("l1-today-on-dark.png");

// 2. What a tap at the dots hits, and at the headline, on the first row with dots.
const target = rows.find((r) => r.leanBox && r.dots === 5);
await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${target.sid}"]');
  document.getElementById("section-today").scrollTop = li.offsetTop - 200; })()`);
await sleep(300);
const hits = await evaluate(`(() => {
  const li = document.querySelector('#section-today li.story[data-sid="${target.sid}"]');
  const dots = li.querySelector(".meta .lean").getBoundingClientRect();
  const head = li.querySelector(".headline").getBoundingClientRect();
  const at = (x, y) => document.elementFromPoint(x, y);
  return { dots: at(dots.left + dots.width / 2, dots.top + dots.height / 2)?.className,
    near: at(dots.left + dots.width / 2 + 18, dots.top + dots.height / 2)?.className,
    headline: at(head.left + 10, head.top + head.height / 2)?.closest("a.story-link") ? "story-link" : "other" };
})()`);
check(hits.dots === "lean-hit" && hits.near === "lean-hit", `a tap on or near the dots hits the marker (${hits.dots}, ${hits.near})`);
check(hits.headline === "story-link", "a tap on the headline still opens the story");

// 3. The sheet.
await evaluate(`document.querySelector('#section-today li.story[data-sid="${target.sid}"] .lean-hit').click()`);
await sleep(700);
const sheet = await evaluate(`(() => ({ open: !document.getElementById("sheet-root").hidden, title: document.getElementById("sheet-label").textContent,
  word: document.querySelector(".lean-sheet-word")?.textContent, basis: document.querySelector(".lean-sheet-basis")?.textContent || "",
  basisShown: !!document.querySelector(".lean-sheet-basis")?.getClientRects().length,
  note: document.querySelector(".lean-sheet-note")?.textContent, filled: [...document.querySelectorAll(".lean-sheet-dots i")].findIndex((d) => getComputedStyle(d).opacity === "1") }))()`);
console.log(JSON.stringify(sheet));
const tname = input.names[input.pool.articles.find((a) => a.id === (leads.get(target.sid) || target.sid)).source_id];
check(sheet.open && sheet.title === tname, `the sheet opens titled with the outlet (${sheet.title})`);
check(sheet.basisShown && sheet.basis.length > 10 && !/^F\d+ /.test(sheet.basis), "the sheet shows the cited basis, without the fetch-check note");
check(/outlet/.test(sheet.note || "") && sheet.filled === SCALE.indexOf(target.lean), "the sheet shows the bucket and the outlet-not-story line");
await shot("l1-sheet-dark.png");
await evaluate(`document.getElementById("sheet-close").click()`);
await sleep(400);

// 4. Light, then markers off, then color on.
await visit(null, "light");
await shot("l1-today-on-light.png");
check((await evaluate("window.__cls")) === 0, "CLS markers on, light: 0");
await evaluate(`document.querySelector('#section-today li.story[data-sid="${target.sid}"] .lean-hit').click()`);
await sleep(700);
await shot("l1-sheet-light.png");

for (const scheme of ["dark", "light"]) {
  await visit(store({ lean_markers: false }), scheme);
  const first = await evaluate("window.__first");
  const drawn = await evaluate(`[...document.querySelectorAll(".lean, .lean-hit")].filter((n) => n.getClientRects().length).length`);
  const clsOff = await evaluate("window.__cls");
  check(first.off && first.drawn === 0 && drawn === 0, `markers off (${scheme}): none drawn, first paint included`);
  check(clsOff === 0, `CLS markers off (${scheme}): ${clsOff}`);
  await shot(`l1-today-off-${scheme}.png`);
}
for (const scheme of ["dark", "light"]) {
  await visit(store({ lean_color: true }), scheme);
  const colors = await evaluate(`(() => { const out = {};
    for (const li of document.querySelectorAll("#section-today .meta .lean")) {
      const on = [...li.children].find((d) => getComputedStyle(d).opacity === "1");
      if (on) out[li.className.replace("lean lean--", "")] = getComputedStyle(on).backgroundColor;
    }
    return out; })()`);
  console.log(`  color ${scheme}: ${JSON.stringify(colors)}`);
  const left = colors.left || colors["center-left"];
  const right = colors.right || colors["center-right"];
  check((await evaluate("window.__first")).color && left && right && left !== right && colors.center && colors.center !== left,
    `color on (${scheme}): left, center and right fills differ`);
  check((await evaluate("window.__cls")) === 0, `CLS color on (${scheme}): 0`);
  await shot(`l1-today-color-${scheme}.png`);
}

// 5. R43: trust flips the pick; the row renames before first paint; the reader agrees.
if (flip) {
  await visit(store(null, { [flipTrust.source]: 2 }), "dark");
  const row = (await evaluate(ROWS)).find((r) => r.sid === flip.sid);
  const expect = readChoice(flip.cands, flip.lead, { [flipTrust.source]: 2 });
  const leadSource = input.pool.articles.find((a) => a.id === flip.lead).source_id;
  const expectName = expect.source_id === leadSource ? null : input.names[expect.source_id];
  check(row && row.body === expect.id && row.body !== flipTrust.was && row.readName === expectName,
    `trust re-picks "Read here" to ${row?.readName} (${row?.body}) before first paint`);
  const opened = await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${flip.sid}"]');
    document.getElementById("section-today").scrollTop = li.offsetTop - 100; li.querySelector("a.story-link").click();
    return new Promise((r) => setTimeout(() => r({ hash: location.hash, via: document.querySelector(".reader-via")?.textContent || "",
      source: document.querySelector(".reader-source")?.textContent || "" }), 1500)); })()`);
  check(opened.hash === `#read-${expect.id}` && opened.source.startsWith(input.names[expect.source_id]),
    `the reader opens the named member (${opened.hash}, ${opened.source})`);
  await shot("l1-reader-dark.png");

  // A missing body file: the default pick 404s, the reader falls back and says so.
  await visit(null, "dark");
  const fb = await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${flip.sid}"]');
    document.getElementById("section-today").scrollTop = li.offsetTop - 100; li.querySelector("a.story-link").click();
    return new Promise((r) => setTimeout(() => r({ hash: location.hash, via: document.querySelector(".reader-via")?.textContent || "",
      paras: document.querySelectorAll(".reader-body p").length, note: document.querySelector(".reader-note-head")?.textContent || "" }), 2000)); })()`);
  const next = readChoice(flip.cands, flip.lead, {}, new Set([missing]));
  check(next && fb.hash === `#read-${next.id}` && fb.via === `Full text from ${input.names[next.source_id]}` && fb.paras > 0,
    `a missing body falls back to ${next?.id}: "${fb.via}" (${fb.paras} paragraphs, note "${fb.note}")`);
} else {
  console.log("  (no story with a body-less lead and two outlets with bodies: R43 flip checks skipped)");
}

const csp = await evaluate("window.__csp");
check(csp.length === 0, `CSP violations ${csp.length} ${csp.slice(0, 3).join(" | ")}`);
check(errors.length === 0, `page errors ${errors.length} ${errors.slice(0, 2).join(" | ")}`);
chrome.close();
site.close();
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
