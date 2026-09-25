// D3 browser proof and sweep shots, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/d3_polish.mjs <built dist dir> [<screenshot dir>] [--sweep]
// Serves the built page with the build's own dist/_headers (the live CSP) in headless
// Chrome at 360x780 CSS px, DPR 3, and checks the D3 chrome polish:
// no scroller shows a scrollbar (every panel's, the reader's and the strip's client width
// equals its box width) while each still scrolls; the active tab is bold yet no tab
// changes width when the selection moves; the underline is one element that slides on a
// tap (a transition is running mid-tap) and, mid-swipe, sits part way between the two
// tabs, following the pager; nothing shifts (CLS 0) and no CSP report fires. With a
// screenshot dir it saves final-dark, tabs-swipe-dark, nav-dark, reader-dark and
// final-light; with --sweep also every other screen, dark then light. Exits 1 on failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const sweep = args.includes("--sweep");
const [distArg, shotsArg] = args.filter((a) => !a.startsWith("--"));
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("d3-polish");
const { send, evaluate } = chrome;
const json = async (expr) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__shift = 0; window.__csp = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true });
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
async function load(scheme, path = "index.html", ready = `document.documentElement.dataset.sections === "ready"`) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}/${path}` });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`document.readyState === "complete" && document.fonts.status === "loaded" && (${ready})`)) break;
    await sleep(100);
  }
  await sleep(400);
}
async function tapAt(x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function tapTab(id) {
  const b = await json(`(() => { const r = document.getElementById("tab-${id}").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await tapAt(b.x, b.y);
}
const inkRect = () => json(`(() => { const r = document.querySelector(".tabs-ink").getBoundingClientRect(); return { x: r.left, w: r.width }; })()`);
const tabRect = (id) => json(`(() => { const r = document.getElementById("tab-${id}").getBoundingClientRect(); return { x: r.left + 6, w: r.width - 12 }; })()`);
const near = (a, b, d = 0.75) => Math.abs(a - b) <= d;

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 1. Today top, dark: no scrollbar on any scroller, and each still scrolls.
await load("dark");
await shot("final-dark.png");
const bars = await json(`[...document.querySelectorAll(".panel, .pager, .tabs-scroll, .reader-scroll, .sheet-body")].map((n) => ({ c: n.className, gutter: n.offsetWidth - n.clientWidth, hbar: n.offsetHeight - n.clientHeight - (parseFloat(getComputedStyle(n).borderTopWidth) + parseFloat(getComputedStyle(n).borderBottomWidth)) })).filter((n) => n.gutter > 0 || n.hbar > 0)`);
const scrolls = await json(`(() => { const p = document.getElementById("section-today"); p.scrollTop = 400; const t = p.scrollTop; p.scrollTop = 0; return t; })()`);
check("no-scrollbars", bars.length === 0 && scrolls === 400, { withBar: bars, todayScrolled: scrolls });

// 2. Bold active tab, fixed widths: every visible tab's width is the same whichever is selected.
const ids = await json(`[...document.querySelectorAll(".tab")].filter((t) => !t.hidden).map((t) => t.dataset.section)`);
const widths = () => json(`[...document.querySelectorAll(".tab")].filter((t) => !t.hidden).map((t) => t.getBoundingClientRect().width)`);
const w0 = await widths();
const weight = await json(`[getComputedStyle(document.querySelector('.tab[aria-selected="true"]')).fontWeight, getComputedStyle(document.querySelector('.tab[aria-selected="false"]:not([hidden])')).fontWeight]`);
const shift0 = await evaluate("window.__shift");
const target = ids[2];
await tapTab(target);
await sleep(60);
const midTap = await json(`(() => { const s = getComputedStyle(document.querySelector(".tabs-ink")); return { anims: document.querySelector(".tabs-ink").getAnimations().length, transition: s.transitionDuration }; })()`);
await sleep(400);
const w1 = await widths();
const inkAfterTap = await inkRect();
const want = await tabRect(target);
check("bold-fixed-width", weight[0] === "700" && weight[1] !== "700" && JSON.stringify(w0) === JSON.stringify(w1),
  { activeWeight: weight[0], inactiveWeight: weight[1], widthsBefore: w0.map((w) => +w.toFixed(2)), widthsAfter: w1.map((w) => +w.toFixed(2)) });
check("ink-slides-on-tap", midTap.anims > 0 && near(inkAfterTap.x, want.x) && near(inkAfterTap.w, want.w), { midTap, ink: inkAfterTap, want });

// 3. Swipe: mid-gesture the ink sits between the two tabs; after, under the new one.
await evaluate(`document.getElementById("tab-${ids[0]}").click()`);
await sleep(400);
const a = await tabRect(ids[0]);
const b = await tabRect(ids[1]);
const steps = [320, 290, 260, 230, 200, 175];
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: steps[0], y: 420 }] });
for (const x of steps.slice(1)) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 420 }] }); await sleep(16); }
await sleep(120);
const mid = await inkRect();
const pagerMid = await json(`document.getElementById("pager").scrollLeft / document.getElementById("pager").clientWidth`);
await shot("tabs-swipe-dark.png");
for (let i = 1; i <= 6; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 175 - i * 22, y: 420 }] }); await sleep(16); }
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(1000);
const end = await inkRect();
const landed = await evaluate(`document.querySelector('.tab[aria-selected="true"]').dataset.section`);
const bEnd = await tabRect(ids[1]);
check("ink-tracks-swipe", mid.x > a.x + 1 && mid.x < b.x - 1 && pagerMid > 0.05 && pagerMid < 0.95 && landed === ids[1] && near(end.x, bEnd.x) && near(end.w, bEnd.w),
  { from: a, to: b, mid, pagerFraction: +pagerMid.toFixed(3), landed, end });
const shiftAfter = await evaluate("window.__shift");
check("cls", shiftAfter === 0 && shift0 === 0, { shift: shiftAfter });

// 4. The bottom nav: Home current, filled; the others outlined.
const nav = await json(`[...document.querySelectorAll(".nav-item")].map((a) => ({ id: a.dataset.screen, current: a.getAttribute("aria-current") === "page", fill: getComputedStyle(a.querySelector(".nav-shape")).fill, box: a.querySelector(".nav-icon").getBoundingClientRect().width }))`);
check("nav-icons", nav.every((n) => n.box === 24 && (n.current ? n.fill !== "none" : n.fill === "none")) && nav.filter((n) => n.current).length === 1, { nav });
await evaluate(`document.getElementById("tab-${ids[0]}").click()`);
await sleep(300);
if (shotsArg) {
  // The nav at full scale: a 360x120 crop of the bottom of the screen.
  const png = (await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 660, width: 360, height: 120, scale: 1 } })).result.data;
  writeFileSync(join(shotsArg, "nav-dark.png"), Buffer.from(png, "base64"));
}

// 5. The reader, dark: open the first story with a body; no scrollbar in it.
const bodyId = await evaluate(`document.querySelector('#section-today a.story-link[data-body]')?.dataset.body || ""`);
if (bodyId) {
  await evaluate(`document.querySelector('#section-today a.story-link[data-body="${bodyId}"]').click()`);
  for (let i = 0; i < 40; i++) { if (await evaluate(`document.querySelectorAll("#reader-article .reader-body p").length > 0`)) break; await sleep(100); }
  await sleep(300);
  await shot("reader-dark.png");
  const rb = await json(`(() => { const s = document.getElementById("reader-scroll"); return s.offsetWidth - s.clientWidth; })()`);
  check("reader-no-scrollbar", rb === 0, { gutter: rb });
  if (sweep) {
    await evaluate(`document.getElementById("reader-scroll").scrollTop = 1400`);
    await sleep(200);
    await shot("sweep-reader-body-dark.png");
  }
  await evaluate("history.back()");
  await sleep(500);
} else check("reader-no-scrollbar", false, { reason: "no story with a body in this build" });

async function sweepScheme(scheme) {
  await load(scheme);
  await tapTab(ids[3] || ids[1]);
  await sleep(400);
  await shot(`sweep-section-${scheme}.png`);
  await evaluate(`document.getElementById("tab-${ids[0]}").click()`);
  await sleep(300);
  await evaluate(`document.querySelector("#section-today .story--hero .story-overflow, #section-today .story-overflow").click()`);
  await sleep(500);
  await shot(`sweep-sheet-${scheme}.png`);
  if (await evaluate(`!!document.querySelector('.sheet-item[data-action="why"]')`)) {
    await evaluate(`document.querySelector('.sheet-item[data-action="why"]').click()`);
    await sleep(600);
    await shot(`sweep-why-${scheme}.png`);
  }
  await evaluate(`document.getElementById("sheet-close")?.click()`);
  await sleep(400);
  const cov = await evaluate(`!!document.querySelector("#section-today .story-coverage")`);
  if (cov) {
    await evaluate(`document.querySelector("#section-today .story-coverage").scrollIntoView({ block: "center" })`);
    await evaluate(`document.querySelector("#section-today .story-coverage").click()`);
    await sleep(600);
    // Since V1 the trigger opens the versions carousel; the sheet is its footer link.
    await evaluate(`document.getElementById("bv-all")?.click()`);
    await sleep(600);
    await shot(`sweep-coverage-${scheme}.png`);
    await evaluate(`document.getElementById("sheet-close")?.click()`);
    await sleep(400);
    await evaluate(`document.getElementById("bv-close")?.click()`);
    await sleep(400);
  }
  await evaluate(`document.getElementById("section-today").scrollTop = 900`);
  await sleep(200);
  await shot(`sweep-river-${scheme}.png`);
  await evaluate(`location.hash = "#following"`);
  await sleep(400);
  await shot(`sweep-following-${scheme}.png`);
  await load(scheme, "profile.html", "true");
  await shot(`sweep-you-${scheme}.png`);
  await load(scheme, "health.html", "true");
  await shot(`sweep-health-${scheme}.png`);
}
if (sweep) { await sweepScheme("dark"); await sweepScheme("light"); }

// 6. Light: Today top.
await load("light");
await shot("final-light.png");
const csp = await json("window.__csp");
check("csp", csp.length === 0 && errors.length === 0, { csp, errors });

console.log(JSON.stringify({ ok, results }, null, 1));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
