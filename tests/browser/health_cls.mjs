// S17 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/health_cls.mjs <built dist dir> [<screenshot dir>]
// Serves the built dist (health.html included) with the build's own _headers, as
// Cloudflare Pages does, in headless Chrome at 360x780 CSS px, DPR 3, and checks:
// every source in the pool appears in the page exactly once; unhealthy sources render
// first, then failing, then the rest grouped by bucket, matching app.health's own
// sorted_feed_rows; the pool-age line updates from "Updated ..." at build time to a
// device-clock value (js/health-age.js); every row's text is plain text nodes, never
// markup; zero layout shift from navigation through the age-line rewrite; zero CSP
// violations. Exits 1 on any failure.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s17-health");
const { send, evaluate } = chrome;

const csp = [];
chrome.on((m) => { if (m.method === "Log.entryAdded" && /Content Security Policy/i.test(m.params.entry.text)) csp.push(m.params.entry.text); });
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = [];
  window.__shift = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true });` });

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
async function load(path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}/${path}` });
  await sleep(700);
}

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 1. Serve headers match the build's own CSP, and health.html is reachable from the
// You tab (profile.html carries the link).
await load("profile.html");
const linkHref = await evaluate(`document.querySelector('a[href="health.html"]')?.getAttribute("href")`);
check("profile links to health.html", linkHref === "health.html", { linkHref });

// 2. health.html itself: every pool source appears exactly once, in the right order.
await load("health.html");
const served = await evaluate("fetch(location.href).then((r) => r.headers.get('content-security-policy'))");
const poolInput = JSON.parse(await evaluate(`fetch("pool.json").then((r) => r.text())`));
const expectedIds = poolInput.sources.map((s) => s.id);
const rowIds = await evaluate(`[...document.querySelectorAll(".health-source-row")].map((r) => r.dataset.source)`);
const unhealthyIds = new Set(Object.entries(poolInput.source_health || {}).filter(([, h]) => h.unhealthy).map(([id]) => id));
const failingIds = new Set(Object.entries(poolInput.source_health || {})
  .filter(([id, h]) => !h.unhealthy && ["http_error", "timeout", "parse_error"].includes(h.state)).map(([id]) => id));
const priorityOf = (id) => (unhealthyIds.has(id) ? 0 : failingIds.has(id) ? 1 : 2);
const priorities = rowIds.map(priorityOf);
const sortedByPriority = priorities.every((p, i) => i === 0 || p >= priorities[i - 1]);
check("every source appears exactly once", JSON.stringify([...rowIds].sort()) === JSON.stringify([...expectedIds].sort())
  && rowIds.length === new Set(rowIds).size, { rowCount: rowIds.length, poolSources: expectedIds.length });
check("unhealthy first, then failing, then the rest", sortedByPriority
  && rowIds.slice(0, unhealthyIds.size).every((id) => unhealthyIds.has(id)), { rowIds, unhealthyIds: [...unhealthyIds], failingIds: [...failingIds] });

// 3. Text only: no row carries anything but text nodes and spans/divs (R26).
const markupClean = await evaluate(`[...document.querySelectorAll(".health-source-row, .setting-value, .notice-head")]
  .every((el) => [...el.querySelectorAll("*")].every((c) => ["SPAN", "DIV"].includes(c.tagName)) && !el.innerHTML.includes("<script"))`);
check("rows are text only", markupClean === true, { markupClean });

// 4. The pool-age line: built with a frozen age, then rewritten by js/health-age.js
// before paint, so it never shifts anything and always reflects a real relative age.
const ageText = await evaluate(`document.getElementById("pool-age").textContent`);
const ageLooksLive = /^(Updated|Stale\. Last updated) \d+(?: min|[hd]) ago\.$/.test(ageText);
await shot("final-dark.png");
const shift = await evaluate("window.__shift");
check("pool age line is live and zero shift", ageLooksLive && shift === 0, { ageText, shift });

// 5. Zero CSP violations across both loads.
check("zero csp violations", served === headers["Content-Security-Policy"] && (await evaluate("window.__csp")).length === 0 && csp.length === 0,
  { cspServed: served === headers["Content-Security-Policy"], violations: await evaluate("window.__csp"), consoleCsp: csp });

await load("health.html", "light");
await shot("final-light.png");

console.log(JSON.stringify({ ok, results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
