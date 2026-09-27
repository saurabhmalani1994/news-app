// S16 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   python -m app.build --pool tests/fixtures/golden_pool.json --out /tmp/dist_s16
//   node tests/browser/s16_check.mjs /tmp/dist_s16 [<screenshot dir>]
//
// Serves the built site the way Cloudflare Pages does (pretty URLs, the build's own
// _headers) behind the simulated Cloudflare Access gate (BUILDER-RULES "Behind
// Access"): serve()/launch() from cdp.mjs already do this, the same way every other
// proof here does. Seeds the device's own opened-history IndexedDB directly (never
// through a fetch, since R23 says this data never leaves the device) with two weeks of
// reading: last week spread evenly across four topics, this week narrowed onto one, a
// clear case for the narrowing banner (DESIGN-v1.1 section 6, the breadth-number
// brief). Checks: Today shows the banner with the right numbers, dismissing it hides
// it and the dismissal survives a reload, and the You page's Breadth row and its own
// #breadth view show the same score, delta and top-topics lists. Zero CSP violations
// and zero cumulative layout shift throughout. Screenshots (dark and light) land in
// the given directory. Exits 1 on any failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s16-breadth");
const { send, evaluate } = chrome;
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
const csp = () => evaluate("window.__csp.length");
const cls = () => evaluate("window.__cls");
async function waitFor(expr, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await evaluate(expr)) return true;
  }
  throw new Error(`waitFor timed out after ${ms}ms: ${expr}`);
}
async function open(path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}${path}` });
  await waitFor(`document.readyState === "complete"`);
}

// Two weeks of seeded reading, straight into the opened-history IndexedDB store
// (history/store.js's shape): last week (8 days ago) spread evenly across four of the
// app's own interest topics, three opens each (score 100, maximum spread); this week
// (1 day ago) all twelve opens on a single topic (score 0), a full narrowing. Both
// windows clear MIN_SAMPLE (10) comfortably.
const DAY_MS = 86_400_000;
const now = Date.now();
const rec = (id, topics, daysAgo) => ({
  id, cluster_id: id, title: `story ${id}`, source: "Test Source", source_id: "test", url: "https://example.org/" + id,
  image: null, topics, article_id: id, time: new Date(now - daysAgo * DAY_MS).toISOString(),
});
const previousTopics = ["ai", "asia", "singapore", "world"];
const previous = previousTopics.flatMap((t, ti) => [0, 1, 2].map((k) => rec(`prev-${ti}-${k}`, [t], 8)));
const current = [...Array(12).keys()].map((k) => rec(`cur-${k}`, ["singapore"], 1));
const seeded = [...previous, ...current];

await open("/");
await evaluate(`localStorage.clear(); sessionStorage.clear()`);
// Not deleteDatabase: the page (breadth-banner.js, history/observe.js) already holds
// an open connection from the load above, and a delete blocks forever behind an open
// connection nothing here ever closes. Opening the same version and clearing the
// store in place never blocks.
await evaluate(`(() => new Promise((resolve, reject) => {
  const req = indexedDB.open("almanac-history", 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains("opened")) req.result.createObjectStore("opened", { keyPath: "id" });
    if (!req.result.objectStoreNames.contains("shown")) req.result.createObjectStore("shown", { keyPath: "id" });
  };
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(["opened", "shown"], "readwrite");
    tx.objectStore("opened").clear();
    tx.objectStore("shown").clear();
    for (const r of ${JSON.stringify(seeded)}) tx.objectStore("opened").put(r);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error("history store open blocked"));
}))()`);

// 1. Today, freshly loaded with the seeded history: the narrowing banner shows, with
// the exact numbers this seed produces (score 0 this week, a 100% relative drop).
await open("/");
await waitFor(`document.getElementById("breadth-banner").hidden === false`);
const bannerText = await evaluate(`document.getElementById("breadth-banner-text").textContent`);
check("banner shows with the seeded narrowing", bannerText === "Your reading narrowed this week: breadth 0, down 100%. See You.", { bannerText });
await shot("banner-dark.png");
await open("/", "light");
await waitFor(`document.getElementById("breadth-banner").hidden === false`);
await shot("banner-light.png");
await open("/");
await waitFor(`document.getElementById("breadth-banner").hidden === false`);

// 2. Dismissing hides it, and the dismissal survives a reload of the same window.
await evaluate(`document.getElementById("breadth-banner-dismiss").click()`);
const hiddenAfterDismiss = await evaluate(`document.getElementById("breadth-banner").hidden`);
check("dismiss hides the banner", hiddenAfterDismiss === true, { hiddenAfterDismiss });
await open("/");
await sleep(400);
const hiddenAfterReload = await evaluate(`document.getElementById("breadth-banner").hidden`);
check("dismissal survives a reload of the same window", hiddenAfterReload === true, { hiddenAfterReload });

// 3. The You page: the Breadth row's own summary line, then the #breadth view with the
// same score/delta line and both weeks' top topics.
await open("/profile");
await waitFor(`document.getElementById("breadth-row") !== null`);
const rowValue = await evaluate(`document.getElementById("breadth-row").querySelector(".setting-value").textContent`);
check("You row shows the week-over-week line", rowValue === "Breadth 0, down 100 from last week", { rowValue });

await evaluate(`document.getElementById("breadth-row").click()`);
await waitFor(`location.hash === "#breadth" && document.querySelectorAll(".breadth-topic-row").length > 0`);
const breadthView = JSON.parse(await evaluate(`JSON.stringify({
  title: document.getElementById("page-title").textContent,
  summary: document.querySelector(".settings-hint--top")?.textContent,
  labels: [...document.querySelectorAll("#settings-root .settings-label")].map((h) => h.textContent),
  topicRows: [...document.querySelectorAll(".breadth-topic-row")].map((li) => li.textContent.trim()),
})`));
check("breadth view title", breadthView.title === "Breadth", breadthView);
check("breadth view summary line", breadthView.summary === "Breadth 0, down 100 from last week", breadthView);
check("breadth view has both weeks' topic lists", breadthView.labels.includes("Top topics this week") && breadthView.labels.includes("Top topics last week"), breadthView);
const sections = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#settings-root section")].map((s) => ({
  label: s.querySelector("h2")?.textContent,
  rows: [...s.querySelectorAll(".breadth-topic-row")].map((li) => li.textContent.trim()),
})))`));
const thisWeekRows = sections.find((s) => s.label === "Top topics this week")?.rows || [];
const lastWeekRows = sections.find((s) => s.label === "Top topics last week")?.rows || [];
check("this week's topic list names only Singapore", thisWeekRows.length === 1 && thisWeekRows[0].includes("Singapore"), { thisWeekRows });
check("last week's topic list names all four topics", ["AI", "Asia", "Singapore", "World"].every((label) =>
  lastWeekRows.some((t) => t.includes(label))), { lastWeekRows });
await shot("you-breadth-dark.png");
await open("/profile#breadth", "light");
await waitFor(`document.querySelectorAll(".breadth-topic-row").length > 0`);
await shot("you-breadth-light.png");

check("zero CSP violations", (await csp()) === 0, { csp: await csp() });
check("zero cumulative layout shift", (await cls()) === 0, { cls: await cls() });

console.log(JSON.stringify(results, null, 2));
chrome.close();
site.close();
if (!ok) { console.error("S16 breadth-number proof FAILED"); process.exit(1); }
console.log("S16 breadth-number proof passed");
