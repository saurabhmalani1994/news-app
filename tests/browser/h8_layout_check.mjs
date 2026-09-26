// H8 browser proof, run by hand (needs Chrome):
//   node tests/browser/h8_layout_check.mjs <dist> [<shots dir>] [--from <previous deploy's dist>]
// The owner's phone (2026-09-26, installed PWA, a Live tab up) showed a ~150dp empty band
// above the tab strip: T2's overflow <symbol> sprite, the first child of the flex column
// <body class="app">, was a laid-out 360x150 SVG, because the HTML `hidden` attribute
// does not hide an SVG element. This proof loads the Home screen behind the simulated
// Access gate (cdp.mjs serve) at 360x780, scale 3, dark, in a browser tab and in an app
// window (display-mode: standalone, as the installed PWA), first from the network and
// then again under the service worker, on Today, on the Live tab and back on Today:
//   - the Live tab is shown (build the dist from tests/browser/fixtures/live_pool.py);
//   - no empty band: the tab strip starts at the top of the viewport, and nothing in the
//     body before the screens takes any height;
//   - order: the tab strip, then Today's masthead directly below it, inside the panel;
//   - no horizontal overflow: the document is no wider than the viewport, the active
//     panel fills it exactly, and no other panel shows any pixel of itself in it.
// With --from, it also replays the upgrade: an app window installs the previous deploy's
// service worker, the site is redeployed with <dist>, and the same profile reopens until
// the new build controls the page, then runs the same checks. Exits 1 on any failure.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const fromDist = fromAt >= 0 ? resolve(args.splice(fromAt, 2)[1]) : null;
const dist = resolve(args[0] || "dist");
const shots = args[1] ? resolve(args[1]) : null;
if (shots) mkdirSync(shots, { recursive: true });

const results = {};
let ok = true;
const check = (name, failures, detail = {}) => {
  results[name] = { pass: failures.length === 0, failures, ...detail };
  ok &&= failures.length === 0;
};

// Page side: every layout failure on the current screen, as strings.
const LAYOUT = `(() => {
  const f = [];
  const W = innerWidth;
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  const rect = (el) => el.getBoundingClientRect();
  const live = document.getElementById("tab-live");
  if (!live || live.hidden) f.push("no Live tab shown");
  const tabs = document.querySelector("#screen-home .tabs");
  const t = rect(tabs);
  if (!near(t.top, 0)) f.push("tab strip starts at " + t.top + "px, not at the top");
  const screens = document.querySelector(".screens");
  for (const el of document.body.children) {
    if (el === screens) break;
    const r = rect(el);
    const pos = getComputedStyle(el).position;
    if (r.height > 0 && pos !== "absolute" && pos !== "fixed") f.push("band: <" + el.tagName.toLowerCase() + "." + el.getAttribute("class") + "> takes " + r.width + "x" + r.height + " above the screens");
  }
  const hit = document.elementFromPoint(W / 2, 2);
  if (!hit || !tabs.contains(hit)) f.push("the top of the viewport is not the tab strip: " + (hit && hit.tagName));
  const section = document.querySelector('.tab[aria-selected="true"]')?.dataset.section;
  const panel = document.getElementById("section-" + section);
  if (!panel) f.push("no panel for the selected tab " + section);
  else {
    const p = rect(panel);
    if (!near(p.left, 0) || !near(p.width, W)) f.push("active panel " + section + " at x " + p.left + ", " + p.width + " wide, not 0 and " + W);
    if (p.top < t.bottom - 0.5) f.push("active panel starts above the tab strip's bottom");
  }
  if (section === "today") {
    const m = rect(document.querySelector("#section-today .masthead"));
    if (!near(m.top, t.bottom)) f.push("masthead top " + m.top + " is not right below the tabs (" + t.bottom + ")");
  }
  for (const other of document.querySelectorAll(".panel")) {
    if (other === panel) continue;
    const r = rect(other);
    if (r.width > 0 && r.height > 0 && r.left < W - 0.5 && r.right > 0.5) f.push("panel " + other.id + " shows in the viewport, x " + r.left + " to " + r.right);
  }
  const de = document.documentElement;
  if (de.scrollWidth > W) f.push("document is " + de.scrollWidth + "px wide in a " + W + "px viewport");
  if (document.body.scrollWidth > W) f.push("body is " + document.body.scrollWidth + "px wide");
  const pager = document.getElementById("pager");
  if (panel && !near(pager.scrollLeft, panel.offsetLeft - pager.offsetLeft)) f.push("pager scrolled to " + pager.scrollLeft + ", panel at " + panel.offsetLeft);
  return JSON.stringify({ failures: f, standalone: matchMedia("(display-mode: standalone)").matches, tabsTop: t.top, section });
})()`;

// An app window opens its URL before launch() can hand it the Access cookie, so the gate
// is lifted for the launch alone, and the URL it opens is a 404 inside the app's scope
// (no page, no service worker registration): every load this proof checks is gated.
async function openApp(site, name, { app, userDataDir }) {
  if (!app) return launch(name, { userDataDir });
  site.gated = false;
  try {
    const chrome = await launch(name, { app: `${site.origin}/h8-app-window`, userDataDir });
    await sleep(500);
    return chrome;
  } finally {
    site.gated = true;
  }
}

async function setUp(chrome) {
  const { send } = chrome;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
}

async function ready(chrome) {
  for (let i = 0; i < 80; i++) {
    try {
      if (await chrome.evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`)) break;
    } catch { /* navigating */ }
    await sleep(100);
  }
  await sleep(400);
}

async function tap(chrome, selector) {
  const box = JSON.parse(await chrome.evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); t.scrollIntoView({ inline: "center" }); const r = t.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await chrome.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(700);
}

async function shot(chrome, name) {
  if (!shots) return;
  const png = (await chrome.send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

// Today, the Live tab, Today again: each screen's failures under `label`.
async function walk(chrome, label, standalone) {
  const failures = [];
  const look = async (where) => {
    const r = JSON.parse(await chrome.evaluate(LAYOUT));
    if (r.standalone !== standalone) failures.push(`${where}: display-mode standalone is ${r.standalone}`);
    failures.push(...r.failures.map((x) => `${where}: ${x}`));
    await shot(chrome, `${label}-${where}`);
  };
  await look("today");
  if (await chrome.evaluate(`!document.getElementById("tab-live")?.hidden`)) {
    await tap(chrome, "#tab-live");
    await look("live");
    await tap(chrome, "#tab-today");
    await look("today-again");
  }
  return failures;
}

async function session(mode) {
  const standalone = mode === "standalone";
  const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
  const site = await serve(dist, headers);
  const chrome = await openApp(site, `h8-${mode}`, { app: standalone });
  try {
    await setUp(chrome);
    await chrome.send("Page.navigate", { url: `${site.origin}/` });
    await ready(chrome);
    const network = await walk(chrome, `${mode}-network`, standalone);
    await chrome.evaluate("navigator.serviceWorker.ready.then(() => 1)");
    await chrome.send("Page.reload", {});
    await ready(chrome);
    const controlled = await chrome.evaluate("!!navigator.serviceWorker.controller");
    const cached = await walk(chrome, `${mode}-sw`, standalone);
    check(`${mode}_network`, network);
    check(`${mode}_service_worker`, controlled ? cached : ["the service worker never controlled the page", ...cached]);
  } finally {
    chrome.close();
    site.close();
  }
}

const version = (dir) => readFileSync(join(dir, "index.html"), "utf-8").match(/style\.css\?v=([0-9a-f]+)/)?.[1];

// The phone's path: the previous deploy's worker installed in the app, then a redeploy.
async function upgrade() {
  const served = mkdtempSync(join(tmpdir(), "h8-site-"));
  const profile = mkdtempSync(join(tmpdir(), "h8-profile-"));
  cpSync(fromDist, served, { recursive: true });
  const site = await serve(served, parseHeaders(readFileSync(join(fromDist, "_headers"), "utf-8")));
  const want = version(dist);
  let chrome = await openApp(site, "h8-upgrade-old", { app: true, userDataDir: profile });
  try {
    await setUp(chrome);
    await chrome.send("Page.navigate", { url: `${site.origin}/` });
    await ready(chrome);
    await chrome.evaluate("navigator.serviceWorker.ready.then(() => 1)");
    await chrome.send("Page.reload", {});
    await ready(chrome);
    await shot(chrome, "upgrade-before-redeploy");
    chrome.close();
    await sleep(1000);
    rmSync(served, { recursive: true, force: true });
    cpSync(dist, served, { recursive: true });
    let got = null;
    for (let attempt = 0; attempt < 6 && got !== want; attempt++) {
      chrome = await openApp(site, "h8-upgrade-new", { app: true, userDataDir: profile });
      await setUp(chrome);
      await chrome.send("Page.navigate", { url: `${site.origin}/` });
      await ready(chrome);
      for (let i = 0; i < 10 && got !== want; i++) {
        got = await chrome.evaluate(`document.querySelector('link[href*="style.css"]')?.getAttribute("href").split("v=")[1]`);
        if (got !== want) { await sleep(700); await chrome.send("Page.reload", {}); await ready(chrome); }
      }
      if (got !== want) { chrome.close(); await sleep(500); }
    }
    const failures = got === want ? await walk(chrome, "upgrade-after-redeploy", true) : [`the new build (${want}) never reached the page, still ${got}`];
    check("upgrade_from_previous_deploy", failures, { from: version(fromDist), to: want });
  } finally {
    chrome.close();
    site.close();
  }
}

await session("browser");
await session("standalone");
if (fromDist) await upgrade();

console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);
