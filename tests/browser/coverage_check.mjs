// S14 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/coverage_check.mjs <built dist dir> [<screenshot dir>]
// Headless Chrome at 360x780 CSS px, DPR 3, dark. Checks: the "N sources" meta trigger
// opens the versions carousel (V1), whose footer "All versions by lean" opens the
// coverage sheet; the summary line and every group/row/also-carried-by match
// the cluster's own fields, zero layout shift on open, dismiss by the browser back
// button (the sheet first, then the carousel under it), zero CSP violations throughout.
// Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s14-coverage");
const { send, evaluate } = chrome;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
`,
});

await send("Page.navigate", { url: `${site.origin}/index.html` });
await sleep(900);

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
const violations = () => evaluate("window.__csp");
// Since V1 the row trigger opens the versions carousel; the sheet is its footer link.
async function openSheetFor(sid) {
  await evaluate(`document.querySelector('.story-coverage[data-sid="${sid}"]').click()`);
  await sleep(500);
  await evaluate(`document.getElementById("bv-all").click()`);
  await sleep(500);
}
async function backTwice() {
  await evaluate("history.back()");
  await sleep(400);
  await evaluate("history.back()");
  await sleep(400);
}

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 0. Loaded; find the biggest cluster on the page by its own button count of rows in
// the embedded pool, not by rank (importance ranks it high but does not guarantee #1).
const biggest = JSON.parse(await evaluate(`(() => {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const clusters = input.pool.clusters.filter((c) => c.independent_sources > 1);
  const top = clusters.slice().sort((a, b) => b.article_ids.length - a.article_ids.length)[0];
  const dupClusters = clusters.filter((c) => (c.near_duplicates || []).length > 0);
  return JSON.stringify({
    sid: top.id, articleCount: top.article_ids.length, independent: top.independent_sources,
    leans: top.lean_buckets.length, buttonExists: !!document.querySelector('.story-coverage[data-sid="' + top.id + '"]'),
    dupSid: dupClusters[0]?.id || null,
  });
})()`));
check("the biggest live cluster carries a coverage trigger", biggest.buttonExists, biggest);
await shot("initial-dark.png");

// 1. Open the sheet from the biggest cluster's card, through its versions carousel.
await openSheetFor(biggest.sid);
const opened = JSON.parse(await evaluate(`(() => {
  const summary = document.querySelector(".coverage-summary")?.textContent || "";
  const groupLabels = [...document.querySelectorAll(".coverage-group-label")].map((h) => h.textContent);
  const rows = [...document.querySelectorAll(".coverage-row")];
  const rowCount = rows.length;
  const alsoCount = document.querySelectorAll(".coverage-also").length;
  const ownershipShown = [...document.querySelectorAll(".coverage-ownership")].map((n) => n.textContent);
  return JSON.stringify({
    hidden: document.getElementById("sheet-root").hidden,
    isOpen: document.getElementById("sheet-root").classList.contains("is-open"),
    label: document.getElementById("sheet-label").textContent,
    summary, groupLabels, rowCount, alsoCount, ownershipShown,
    historyPushed: history.state && history.state.almanacSheet === 1,
  });
})()`));
await shot("final-dark.png");
check("sheet opens over the biggest cluster with its own summary and history pushed",
  opened.hidden === false && opened.isOpen && opened.label === "Coverage" && opened.historyPushed
    && opened.summary.includes(`${biggest.independent} independent`) && opened.summary.includes(`${biggest.leans}`),
  { opened, biggest });
check("groups appear in the fixed taxonomy order (left, center-left, center, center-right, right, state, non-us)",
  (() => {
    const order = ["Left", "Center-left", "Center", "Center-right", "Right", "State-affiliated", "International"];
    const positions = opened.groupLabels.map((l) => order.indexOf(l));
    return positions.every((p) => p >= 0) && positions.every((p, i) => i === 0 || p >= positions[i - 1]);
  })(),
  { groupLabels: opened.groupLabels });

// 2. Every article in this cluster is accounted for: rows plus also-carried-by names.
const accounted = JSON.parse(await evaluate(`(() => {
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const cluster = input.pool.clusters.find((c) => c.id === "${biggest.sid}");
  const rowHeadlines = [...document.querySelectorAll(".coverage-headline")].map((n) => n.textContent);
  const clusterHeadlines = new Set(cluster.article_ids.map((id) => input.pool.articles.find((a) => a.id === id)?.title));
  const allShown = rowHeadlines.every((h) => clusterHeadlines.has(h));
  return JSON.stringify({ rowCount: rowHeadlines.length, articleCount: cluster.article_ids.length, allShown });
})()`));
check("row count is at most the article count, and every shown headline is a real member",
  accounted.rowCount <= accounted.articleCount && accounted.allShown, accounted);

// 3. Zero layout shift from opening the sheet.
const clsAfterOpen = await evaluate("window.__cls");
check("opening the sheet caused zero layout shift", clsAfterOpen === 0, { clsAfterOpen });

// 4. A cluster with a near-duplicate group shows "also carried by" and still accounts
// for every one of its articles.
if (biggest.dupSid) {
  await backTwice();
  await openSheetFor(biggest.dupSid);
  const dupCheck = JSON.parse(await evaluate(`(() => {
    const input = JSON.parse(document.getElementById("rank-input").content.textContent);
    const cluster = input.pool.clusters.find((c) => c.id === "${biggest.dupSid}");
    const also = [...document.querySelectorAll(".coverage-also")].map((p) => p.textContent);
    const rowCount = document.querySelectorAll(".coverage-row").length;
    return JSON.stringify({ also, rowCount, articleCount: cluster.article_ids.length, dupGroups: (cluster.near_duplicates || []).length });
  })()`));
  await shot("also-carried-by-dark.png");
  check("a near-duplicate group collapses under one row reading 'also carried by'",
    dupCheck.also.length > 0 && dupCheck.also.every((t) => t.startsWith("Also carried by ")) && dupCheck.rowCount < dupCheck.articleCount,
    dupCheck);
  await backTwice();
}

// 5. Reopen the biggest cluster and dismiss by the browser's own back button: the sheet
// first (the carousel stays under it), then the carousel, and the page is usable again.
await openSheetFor(biggest.sid);
await evaluate("history.back()");
await sleep(400);
const sheetClosed = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden, carouselOpen: !document.getElementById("bv").hidden })'));
await evaluate("history.back()");
await sleep(400);
const closedByBack = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden, carouselHidden: document.getElementById("bv").hidden, underHome: !document.getElementById("screen-home").inert })'));
check("dismiss by the browser back button, page underneath usable again",
  sheetClosed.hidden === true && sheetClosed.carouselOpen && closedByBack.hidden === true && closedByBack.carouselHidden && closedByBack.underHome,
  { sheetClosed, closedByBack });

check("zero CSP violations for the whole run", (await violations()).length === 0, { violations: await violations() });

console.log(JSON.stringify({ results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
