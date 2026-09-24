// U2 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/you_check.mjs <built dist dir> [<screenshot dir>]
// Serves the built site the way Cloudflare Pages does (pretty URLs, the build's own CSP
// headers) in headless Chrome at 360x780 CSS px, DPR 3, and checks the redesigned You
// page: every interest is a row with a level word; tapping one opens its page; a level
// tap writes exactly one version and offers Undo; Back returns to You at the same
// scroll; the sources page lists every catalog source, search filters by name, a toggle
// writes mutes.sources; the old S12 deep links land on the new views; the page still
// renders offline under the service worker. Zero CSP violations and CLS 0 throughout
// (synthetic clicks are not user input, so any shift they caused would count).
// Saves you-dark.png, you-light.png, interest-dark.png, sources-dark.png.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const catalog = JSON.parse(readFileSync(join(dist, "source-catalog.json"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("u2-you");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
});
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; (window.__shifts ||= []).push({ at: location.hash, value: e.value, nodes: e.sources.map((x) => x.node ? (x.node.className || x.node.nodeName) + ":" + (x.node.textContent || "").slice(0, 30) : "?") }); } }).observe({ type: "layout-shift", buffered: true });` });

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const shot = async (name) => {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
};
const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass, ...detail }; ok &&= Boolean(pass); };
const ready = () => evaluate("document.getElementById('settings-root').getAttribute('aria-busy') !== 'true' && document.getElementById('settings-root').childElementCount > 0");
const versions = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.length`);
const cls = () => evaluate("window.__cls");
const csp = () => evaluate("window.__csp.length");
async function open(path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}${path}` });
  for (let i = 0; i < 40 && !(await ready().catch(() => false)); i++) await sleep(100);
  await sleep(400);
}

// 1. The You page: one row per interest with a level word, the sources count row.
await open("/profile");
await evaluate("localStorage.clear(); sessionStorage.clear()");
await open("/profile");
const you = JSON.parse(await evaluate(`JSON.stringify({
  rows: [...document.querySelectorAll("#topics-list a.setting-row")].map((a) => [a.dataset.topic, a.querySelector(".setting-value")?.textContent]),
  labels: [...document.querySelectorAll(".settings-label")].map((h) => h.textContent),
  sources: document.getElementById("sources-row")?.querySelector(".setting-label").textContent,
  health: document.querySelector('a[href="/health"]') !== null,
  title: document.title,
})`));
check("you_rows", you.rows.length === 6 && you.rows.every(([, word]) => /^(More|Normal|Less|Off|Top \d+)$/.test(word)), you);
check("you_sources_count", you.sources === `${catalog.sources.length} of ${catalog.sources.length} sources on`, { sources: you.sources });
check("you_sections", ["Your interests", "Standing stories", "News sources", "Display", "Health", "Advanced"].every((l) => you.labels.includes(l)), { labels: you.labels });
await shot("you-dark.png");
await open("/profile", "light");
await shot("you-light.png");
await open("/profile");

// 2. Tap an interest after scrolling a little; its page opens at the top.
await evaluate("scrollTo(0, 180)");
await sleep(200);
const beforeY = await evaluate("scrollY");
await evaluate(`document.querySelector('#topics-list a[data-topic="ai"]').click()`);
await sleep(400);
const interest = JSON.parse(await evaluate(`JSON.stringify({ hash: location.hash, title: document.getElementById("page-title").textContent, y: scrollY,
  levels: [...document.querySelectorAll(".level-option")].map((b) => [b.textContent, b.getAttribute("aria-checked")]),
  fields: [...document.querySelectorAll(".setting-label")].map((s) => s.textContent) })`));
check("interest_opens", interest.hash === "#interest/ai" && interest.title === "AI" && interest.y === 0
  && interest.fields.includes("Affinity") && interest.fields.includes("Half-life"), interest);
await shot("interest-dark.png");

// 3. One level tap is one version, with Undo in the toast; Undo is one more (a revert).
const v0 = await versions();
await evaluate(`[...document.querySelectorAll(".level-option")].find((b) => b.textContent === "More").click()`);
await sleep(300);
const v1 = await versions();
const toast = await evaluate(`JSON.stringify({ text: document.getElementById("toast-text").textContent, undo: !document.getElementById("toast-action").hidden })`);
const afterLevel = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.topics.ai.affinity`);
check("level_one_version", v1 === v0 + 1 && afterLevel === 0.9 && JSON.parse(toast).undo, { v0, v1, afterLevel, toast: JSON.parse(toast) });
await evaluate(`document.getElementById("toast-action").click()`);
await sleep(300);
const undone = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.topics.ai.affinity`);
check("undo_reverts", undone === 0.6 && (await versions()) === v1 + 1, { undone });

// 4. Back returns to You at the same scroll position (the masthead arrow, then the system Back).
await evaluate(`document.getElementById("masthead-back").click()`);
await sleep(400);
const backY = await evaluate("JSON.stringify({ hash: location.hash, y: scrollY, view: document.getElementById('settings-root').dataset.view })");
check("back_arrow_restores_scroll", JSON.parse(backY).view === "you" && Math.abs(JSON.parse(backY).y - beforeY) <= 1, { beforeY, back: JSON.parse(backY) });
await evaluate(`document.getElementById("sources-row").click()`);
await sleep(400);
await evaluate("history.back()");
await sleep(400);
const sysBack = JSON.parse(await evaluate("JSON.stringify({ y: scrollY, view: document.getElementById('settings-root').dataset.view })"));
check("system_back_restores_scroll", sysBack.view === "you" && Math.abs(sysBack.y - beforeY) <= 1, { beforeY, sysBack });

// 5. The sources page: every source once, grouped; search filters; a toggle writes mutes.sources.
await evaluate(`document.getElementById("sources-row").click()`);
await sleep(400);
const listed = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("[data-source]")].map((r) => r.dataset.source))`));
check("sources_all_listed", listed.length === catalog.sources.length && new Set(listed).size === listed.length, { listed: listed.length });
const firstId = listed[0];
const vs = await versions();
await evaluate(`document.querySelector('[data-source="${firstId}"] input.switch').click()`);
await sleep(300);
const muted = JSON.parse(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.mutes.sources)`));
const countLine = await evaluate(`document.querySelector(".search-count").textContent`);
check("source_toggle_mutes", muted.includes(firstId) && (await versions()) === vs + 1 && countLine.startsWith(`${catalog.sources.length - 1} of`), { firstId, muted, countLine });
await evaluate(`(() => { const s = document.querySelector(".search-field"); s.focus(); s.value = "times"; s.dispatchEvent(new Event("input")); })()`);
await sleep(200);
const filtered = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("[data-source]")].filter((r) => !r.hidden).map((r) => r.dataset.name))`));
const expected = catalog.sources.filter((s) => s.name.toLowerCase().includes("times")).length;
check("search_filters", filtered.length === expected && filtered.every((n) => /times/i.test(n)), { filtered, expected });
await evaluate("document.activeElement.blur(); scrollTo(0, 0); document.getElementById('toast').hidden = true");
await sleep(200);
await shot("sources-dark.png");

// 6. S12's old deep links land on the new views, without an extra Back step.
await open("/profile#topic-singapore");
const oldTopic = await evaluate(`JSON.stringify({ hash: location.hash, title: document.getElementById("page-title").textContent })`);
check("old_topic_link", JSON.parse(oldTopic).hash === "#interest/singapore" && JSON.parse(oldTopic).title === "Singapore", JSON.parse(oldTopic));
await open("/profile#raw-json");
const oldRaw = await evaluate(`JSON.stringify({ hash: location.hash, raw: !!document.getElementById("raw-json"), top: Math.round(document.getElementById("raw-json").getBoundingClientRect().top) })`);
check("old_raw_json_link", JSON.parse(oldRaw).hash === "#advanced" && JSON.parse(oldRaw).raw, JSON.parse(oldRaw));

const totalCls = await cls();
const shiftLog = await evaluate("window.__shifts || []");
const totalCsp = await csp();

// 7. Offline: once the worker controls the page, the You page and the picker still render.
await evaluate("navigator.serviceWorker.ready.then(() => true)");
await open("/profile");
await send("Network.enable");
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await open("/profile#sources");
const offline = JSON.parse(await evaluate(`JSON.stringify({ rows: document.querySelectorAll("[data-source]").length, controlled: !!navigator.serviceWorker.controller })`));
check("offline_sources", offline.rows === catalog.sources.length, offline);
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

check("cls_zero", totalCls === 0 && (await cls()) === 0, { totalCls, shifts: shiftLog });
check("csp_zero", totalCsp === 0 && (await csp()) === 0, { totalCsp });
check("no_errors", errors.length === 0, { errors });

chrome.close();
site.close();
console.log(JSON.stringify(results, null, 2));
console.log(ok ? "U2 YOU CHECK: PASS" : "U2 YOU CHECK: FAIL");
process.exit(ok ? 0 : 1);
