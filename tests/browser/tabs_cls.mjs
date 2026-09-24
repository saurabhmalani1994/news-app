// S27 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/tabs_cls.mjs <built dist dir> [<screenshot dir>]
// Serves the built page in headless Chrome at 360x780 CSS px, DPR 3, and checks:
// every section panel lists the ranked pool filtered by the one section table, then
// that tab's own post-passes (S13: passes.js rankPages, run here on the page's own
// embedded input), with each tab's other-side link where the passes put it;
// tapping tabs (real input events) and swiping the pager (a synthesized touch gesture)
// shift nothing, counting every layout-shift entry, even those after input; each
// section keeps its own scroll position; every tab and nav label is a single text node;
// the Following and Saved empty states render. Exits 1 on any failure.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { rankPages } from "../../app/static/js/passes.js";
import { SECTIONS } from "../../app/static/js/sections.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!path.startsWith(dist) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "s27-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__shift = 0; window.__shifts = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__shift += e.value; window.__shifts.push(e.value); } }).observe({ type: "layout-shift", buffered: true });` });

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
async function load(scheme, hash = "") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}/index.html${hash}` });
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`)) break;
    await sleep(100);
  }
  await sleep(400);
}
async function tap(section) {
  const box = await json(`(() => { const t = document.getElementById("tab-${section}"); t.scrollIntoView({ inline: "nearest", block: "nearest" });
    const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await sleep(250);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(450);
}
const active = () => evaluate(`document.querySelector('.tab[aria-selected="true"]').dataset.section`);
const scrollOf = (id) => evaluate(`document.getElementById("section-${id}").scrollTop`);

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 1. Lists: each panel equals the ranked pool filtered by the table, in ranked order.
await load("dark");
const input = await json(`JSON.parse(document.getElementById("rank-input").content.textContent)`);
const pages = rankPages(input.pool, buildDefaultProfile(input.now), input.now, { buckets: input.buckets, leans: input.leans, names: input.names });
const lists = await json(`Object.fromEntries([...document.querySelectorAll(".panel")].map((p) => [p.dataset.section, [...p.querySelectorAll("li.story[data-sid]")].map((li) => li.dataset.sid)]))`);
const others = await json(`Object.fromEntries([...document.querySelectorAll(".panel")].map((p) => [p.dataset.section, [...p.querySelectorAll("li.story[data-sid] .other-side")].map((a) => [a.closest("li").dataset.sid, a.dataset.aid])]))`);
const counts = {};
let listsOk = true;
for (const section of SECTIONS) {
  const page = section.all ? pages.today : pages.sections.find((p) => p.id === section.id).stories;
  const want = page.map((s) => s.id);
  const wantOthers = page.filter((s) => s.other_side).map((s) => [s.id, s.other_side.article_id]);
  counts[section.label] = lists[section.id]?.length ?? null;
  if (section.slot) { listsOk &&= (lists[section.id] || []).length === 0; continue; }
  listsOk &&= JSON.stringify(lists[section.id]) === JSON.stringify(want) && JSON.stringify(others[section.id]) === JSON.stringify(wantOthers);
}
results.otherSide = others;
const heroes = await json(`[...document.querySelectorAll(".panel")].filter((p) => !p.hidden).map((p) => [p.dataset.section, p.querySelectorAll(".story--hero").length, p.querySelectorAll(".story--secondary").length, p.querySelectorAll(".story--river").length])`);
check("lists", listsOk, { counts, tiers: heroes });
await shot("final-dark.png");

// 2. Tap switching: no shift at all, the active tab follows, each tab keeps its place.
const before = await evaluate("window.__shift");
await evaluate(`document.getElementById("section-today").scrollTop = 1500`);
await tap("world");
const worldActive = await active();
await shot("world-dark.png");
await evaluate(`document.getElementById("section-world").scrollTop = 800`);
await tap("singapore");
const sgActive = await active();
await evaluate(`document.getElementById("section-singapore").scrollTop = 0`);
await shot("singapore-dark.png");
await tap("asia");
await tap("today");
const todayBack = await scrollOf("today");
await tap("world");
const worldBack = await scrollOf("world");
const inView = await json(`(() => { const t = document.querySelector('.tab[aria-selected="true"]').getBoundingClientRect(); return t.left >= 0 && t.right <= innerWidth; })()`);
const tapShift = (await evaluate("window.__shift")) - before;
check("tap", tapShift === 0 && worldActive === "world" && sgActive === "singapore" && todayBack === 1500 && worldBack === 800 && inView,
  { shift: tapShift, worldActive, sgActive, todayScrollKept: todayBack, worldScrollKept: worldBack, activeTabInView: inView });

// 3. Swipe: a touch drag on the pager snaps to the next section and the tab follows.
await tap("today");
const swipeBefore = await evaluate("window.__shift");
for (let i = 0; i <= 12; i++) {
  const type = i === 0 ? "touchStart" : i === 12 ? "touchEnd" : "touchMove";
  await send("Input.dispatchTouchEvent", { type, touchPoints: i === 12 ? [] : [{ x: 320 - i * 22, y: 420 }] });
  await sleep(16);
}
await sleep(100);
results.swipeDebug = await json(`({ left: document.getElementById("pager").scrollLeft, w: document.getElementById("pager").clientWidth })`);
await sleep(900);
const swiped = await active();
const snapped = await evaluate(`(() => { const p = document.getElementById("pager"); return p.scrollLeft % p.clientWidth === 0; })()`);
const swipeShift = (await evaluate("window.__shift")) - swipeBefore;
check("swipe", swiped === "us-politics" && snapped && swipeShift === 0, { landedOn: swiped, snapped, shift: swipeShift });

// 4. Labels are text only.
const labels = await json(`[...document.querySelectorAll(".tab, .nav-label")].map((n) => ({ text: n.textContent, textOnly: [...n.childNodes].every((c) => c.nodeType === 3) && n.childNodes.length === 1 }))`);
check("labels", labels.every((l) => l.textOnly), { labels: labels.map((l) => l.text) });

// 5. Empty states and the bottom nav.
await load("dark", "#saved");
const saved = await json(`(() => { const s = document.getElementById("screen-saved"); return { visible: getComputedStyle(s).visibility, head: s.querySelector(".empty-head").textContent,
  current: document.querySelector(".nav-item[aria-current]").dataset.screen, navBottom: document.querySelector(".bottom-nav").getBoundingClientRect().bottom }; })()`);
await shot("saved-empty-dark.png");
await evaluate(`location.hash = "#following"`);
await sleep(300);
const following = await json(`(() => { const s = document.getElementById("screen-following"); return { visible: getComputedStyle(s).visibility, head: s.querySelector(".empty-head").textContent }; })()`);
await shot("following-empty-dark.png");
check("empty", saved.visible === "visible" && saved.current === "saved" && following.visible === "visible" && saved.navBottom <= 780, { saved, following });

// 6. Nothing hides under the nav: the last Today row ends above it.
await load("dark");
const clear = await json(`(() => { const p = document.getElementById("section-today"); p.scrollTop = p.scrollHeight;
  const last = p.querySelector(".colophon").getBoundingClientRect(); const nav = document.querySelector(".bottom-nav").getBoundingClientRect(); return { lastBottom: last.bottom, navTop: nav.top }; })()`);
check("nav-clear", clear.lastBottom <= clear.navTop + 0.5, clear);
await load("light");
await shot("final-light.png");
await tap("world");
await shot("world-light.png");

console.log(JSON.stringify({ ok, results }, null, 2));
ws.close();
chrome.kill();
server.close();
process.exit(ok ? 0 : 1);
