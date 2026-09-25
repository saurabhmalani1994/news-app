// S25 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/reader_check.mjs <built dist dir with bodies/> [<screenshot dir>]
// Serves the built page with the build's own dist/_headers (the live CSP) in headless
// Chrome at 360x780 CSS px, DPR 3, and checks the in-app reader on a real has_body
// story: opened from a section tab scrolled part way down, with the body held back
// 900ms so the skeleton shows, CLS stays 0 and nothing above the body moves; the
// browser's back restores the tab, the pager and the panel scroll exactly; a second
// open is served from IndexedDB with no request; offline it opens from the cache, and
// an uncached story says so calmly; a missing file (404) and a server error (500) show
// their notes with the link out; a hostile body executes nothing. Every CSP report is
// counted: the only ones allowed are the parse-time style/base reports S37 documented
// (the inert DOMParser document meeting the policy), none from inserting the body.
// Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { BENIGN, HOSTILE, handlerFixtures } from "../js/hostile-bodies.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s25-reader");
const { send, evaluate } = chrome;
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

// Body requests go through the Fetch domain: held back, answered 404/500, or given a
// hostile record, per id. `requests` counts every body request that reached the page.
const plan = { delay: {}, status: {}, body: {} };
const requests = {};
chrome.on(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const id = (/\/bodies\/([^/]+)\.json/.exec(request.url) || [])[1];
  requests[id] = (requests[id] || 0) + 1;
  if (plan.status[id]) {
    await send("Fetch.fulfillRequest", { requestId, responseCode: plan.status[id], responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })), body: "" });
    return;
  }
  if (plan.body[id]) {
    const json = Buffer.from(JSON.stringify(plan.body[id])).toString("base64");
    await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: json });
    return;
  }
  if (plan.delay[id]) await sleep(plan.delay[id]);
  await send("Fetch.continueRequest", { requestId });
});

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/bodies/*" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__pwned = []; window.__shifts = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__shifts.push({ value: e.value, at: e.startTime, input: e.hadRecentInput }); }).observe({ type: "layout-shift", buffered: true });` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
async function until(expr, ms = 6000) {
  for (let t = 0; t < ms; t += 50) {
    if (await evaluate(expr)) return true;
    await sleep(50);
  }
  return false;
}
async function load(path, scheme) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await send("Page.navigate", { url: `${site.origin}/${path}` });
  await sleep(2500);
}

const results = {};
let realOpens = 0;
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

const HOME_STATE = `JSON.stringify((() => {
  const tab = document.querySelector('.tab[aria-selected="true"]');
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  return { tab: tab.dataset.section, pagerLeft: document.getElementById("pager").scrollLeft, panelTop: panel.scrollTop,
    readerHidden: document.getElementById("reader").hidden, hash: location.hash, homeInert: document.querySelector(".screens").inert };
})())`;
const homeState = async () => JSON.parse(await evaluate(HOME_STATE));
const bodyReady = `document.querySelectorAll("#reader-article .reader-body p").length > 0`;
const noteShown = `!!document.querySelector("#reader-article .reader-note")`;
const closeByBrowserBack = async () => { await evaluate("history.back()"); await until(`document.getElementById("reader").hidden`, 2000); await sleep(150); };
const openStory = (id) => (realOpens++, evaluate(`document.querySelector('#section-today a.story-link[data-body="${id}"]').click()`));

// 1. Dark, a section tab with a has_body story, scrolled so the story sits mid screen.
await load("index.html", "dark");
const photos = JSON.parse(await evaluate(`JSON.stringify(Object.keys(JSON.parse(document.getElementById("rank-input").content.textContent).reader || {}))`));
const bodyIds = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#section-today a.story-link[data-body]')].map((a) => a.dataset.body))`));
// H5: each Today row's R43 candidates (every member with a body file). A row with more
// than one falls back to the next member when its pick's file is missing (L1), so the
// missing-file note is only ever the answer for a row with one, or once all are gone.
const members = JSON.parse(await evaluate(`JSON.stringify((() => { const bodies = JSON.parse(document.getElementById("rank-input").content.textContent).bodies || {};
  return Object.fromEntries([...document.querySelectorAll('#section-today a.story-link[data-body]')].map((a) => [a.dataset.body, (bodies[a.closest("li.story")?.dataset.sid] || []).map((c) => c[0])])); })())`));
const picked = JSON.parse(await evaluate(`(async () => {
  const photos = new Set(${JSON.stringify(photos)});
  const tabs = [...document.querySelectorAll(".tab")].filter((t) => !t.hidden).slice(1);
  let best = null;
  for (const tab of tabs) {
    tab.click();
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    const links = [...panel.querySelectorAll("a.story-link[data-body]")];
    const link = links.find((a) => photos.has(a.dataset.body)) || links[0];
    if (link && (!best || (photos.has(link.dataset.body) && !best.photo))) best = { tab: tab.dataset.section, id: link.dataset.body, photo: photos.has(link.dataset.body) };
    if (best?.photo) break;
  }
  const tab = document.querySelector('.tab[data-section="' + best.tab + '"]');
  tab.click();
  await new Promise((r) => setTimeout(r, 500));
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  const link = panel.querySelector('a.story-link[data-body="' + best.id + '"]');
  panel.scrollTop += link.getBoundingClientRect().top - 330;
  await new Promise((r) => setTimeout(r, 400));
  return JSON.stringify(best);
})()`));
const before = await homeState();
check("page has has_body stories", bodyIds.length > 0, { hasBodyRowsToday: bodyIds.length, withReaderPhoto: photos.length, picked });

// 2. Open it, the body held back 900ms: skeleton, then the body, nothing above it moving.
plan.delay[picked.id] = 900;
await evaluate("window.__openAt = performance.now()");
await evaluate(`document.querySelector('#section-${picked.tab} a.story-link[data-body="${picked.id}"]').click()`);
await sleep(350);
const RECTS = `JSON.stringify(["reader-title", "reader-dek", "reader-hero", "reader-byline", "reader-body"].map((c) => { const n = document.querySelector("#reader-article ." + c); return n ? Math.round(n.getBoundingClientRect().top * 100) / 100 : null; }))`;
const loading = JSON.parse(await evaluate(`JSON.stringify({ open: !document.getElementById("reader").hidden, skeleton: !!document.querySelector(".reader-skeleton"), hash: location.hash, busy: document.querySelector(".reader-body").getAttribute("aria-busy") })`));
const rectsLoading = await evaluate(RECTS);
const loaded = await until(bodyReady);
const firstOpenReports = (await evaluate("window.__csp")).length;
await sleep(1200); // photo and fonts settle
const rectsLoaded = await evaluate(RECTS);
const shifts = JSON.parse(await evaluate(`JSON.stringify(window.__shifts.filter((s) => s.at >= window.__openAt))`));
const cls = shifts.reduce((sum, s) => sum + s.value, 0);
const readerFacts = JSON.parse(await evaluate(`JSON.stringify({ title: document.querySelector(".reader-title").textContent.slice(0, 60), source: document.querySelector(".reader-source")?.textContent,
  time: document.querySelector(".reader-time")?.textContent, paragraphs: document.querySelectorAll(".reader-body p").length, figures: document.querySelectorAll(".reader-body figure").length,
  link: document.querySelector(".reader-link")?.textContent, linkHref: document.querySelector(".reader-link")?.getAttribute("href"),
  bodyFont: getComputedStyle(document.querySelector(".reader-body p")).font, bodyColor: getComputedStyle(document.querySelector(".reader-body p")).color,
  measure: Math.round(document.querySelector(".reader-body p").getBoundingClientRect().width) })`));
await shot("final-dark.png");
check("open: skeleton, body, CLS 0, nothing above the body moved", loading.open && loading.skeleton && loaded && cls === 0 && JSON.stringify(rectsLoading) === JSON.stringify(rectsLoaded),
  { loading, cls, shifts: shifts.length, rectsLoading, rectsLoaded, requests: requests[picked.id], ...readerFacts });
await evaluate(`(() => { const s = document.getElementById("reader-scroll"); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.45); })()`);
await sleep(900);
await shot("body-dark.png");

// 3. The browser's back button: the tab, the pager and the panel scroll exactly as left.
await closeByBrowserBack();
const afterBack = await homeState();
check("browser back restores tab and scroll", JSON.stringify(afterBack) === JSON.stringify(before), { before, afterBack });

// 4. Second open: from IndexedDB, no request; closed by the reader's own back button.
const count = requests[picked.id];
await evaluate(`document.querySelector('#section-${picked.tab} a.story-link[data-body="${picked.id}"]').click()`);
const cachedFast = await until(bodyReady, 400);
await evaluate(`document.getElementById("reader-back").click()`);
await until(`document.getElementById("reader").hidden`, 2000);
await sleep(150);
const afterButton = await homeState();
check("cache hit, then the bar's back restores", cachedFast && requests[picked.id] === count && JSON.stringify(afterButton) === JSON.stringify(before),
  { cachedFast, requestsBefore: count, requestsAfter: requests[picked.id], afterButton });

// 5. Offline: the cached story opens; an uncached one says so calmly.
// H5: which row plays which part is fixed by what it is, not by its place on Today: a
// single-body row for the missing file (H4 saw a two-member row fall back, correctly,
// and the check wait for a note that R43 says never comes), a two-plus-member row for
// the every-member-missing case, a row with a reader photo for the hostile body (so the
// reader's own hero sits above the sanitized body, as it does for most real stories).
const others = bodyIds.filter((id) => id !== picked.id && !(members[picked.id] || []).includes(id));
const take = (want) => { const i = others.findIndex(want); return i < 0 ? null : others.splice(i, 1)[0]; };
const missingId = take((id) => (members[id] || []).length <= 1);
const multiId = take((id) => (members[id] || []).length > 1);
const hostileId = take((id) => photos.includes(id)) || take(() => true);
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(200);
await openStory(picked.id);
const offlineCached = await until(bodyReady, 1500);
await closeByBrowserBack();
await openStory(others[0]);
const offlineNote = (await until(noteShown, 3000)) && await evaluate(`document.querySelector(".reader-note-head").textContent`);
const offlineLink = await evaluate(`document.querySelector(".reader-link")?.textContent || ""`);
await closeByBrowserBack();
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
check("offline: cached opens, uncached says so", offlineCached && offlineNote === "You are offline" && offlineLink.startsWith("Read at"), { offlineCached, offlineNote, offlineLink });

// 6. A missing body file and a server error.
const NOTE = `[document.querySelector(".reader-note-head").textContent, !!document.querySelector(".reader-retry"), document.querySelector(".reader-link")?.textContent]`;
plan.status[missingId] = 404;
await openStory(missingId);
const missing = (await until(noteShown, 3000)) && await evaluate(NOTE);
await closeByBrowserBack();
plan.status[others[1]] = 500;
await openStory(others[1]);
const failed = (await until(noteShown, 3000)) && await evaluate(NOTE);
await closeByBrowserBack();
check("missing file and fetch error", missing?.[0] === "The full text is not here anymore" && failed?.[0] === "This story did not load" && failed[1] && !missing[1],
  { missingId, missing, failed });

// 6b. H5: a row with several members, every one of their files missing: the reader
// tries each in turn (R43) and then says the text is gone, with the link out.
let allMissing = null;
if (multiId) {
  for (const m of members[multiId]) plan.status[m] = 404;
  const seen = Object.fromEntries(members[multiId].map((m) => [m, requests[m] || 0]));
  await openStory(multiId);
  const note = (await until(noteShown, 4000)) && await evaluate(NOTE);
  allMissing = { note, tried: members[multiId].filter((m) => (requests[m] || 0) > seen[m]).length, of: members[multiId].length };
  await closeByBrowserBack();
}
check("every member missing: the note", !multiId || (allMissing.note?.[0] === "The full text is not here anymore" && !allMissing.note[1] && allMissing.tried === allMissing.of),
  { multiId, ...(allMissing || { skipped: "no Today row with two or more body files" }) });

// 7. A hostile body under the live CSP: nothing runs, nothing but parse-time reports.
const cspBeforeHostile = (await evaluate("window.__csp")).length;
const handlers = await evaluate(`(() => { const n = new Set(); for (const s of [window, document, document.body, document.createElement("video"), document.createElement("details"), document.createElement("img"), document.createElement("input"), document.createElementNS("http://www.w3.org/2000/svg", "svg")]) for (const k in s) if (/^on[a-z]+$/.test(k)) n.add(k); return [...n]; })()`);
plan.body[hostileId] = { schema_version: 1, article_id: hostileId, source_id: "hostile", source_name: "Hostile Feed", url: "https://news.example/story/1",
  body_html: [...HOSTILE, ...handlerFixtures(handlers), BENIGN].map((f) => f.html).join("\n") };
await openStory(hostileId);
await until(bodyReady, 3000);
await evaluate(`document.querySelectorAll('#reader-article *').forEach((el) => { el.focus?.(); el.dispatchEvent(new Event('mouseover')); })`);
await sleep(1500);
const hostile = JSON.parse(await evaluate(`JSON.stringify({ pwned: window.__pwned, reports: window.__csp.slice(${cspBeforeHostile}),
  scripts: document.querySelectorAll("#reader-article script, #reader-article iframe, #reader-article object, #reader-article embed, #reader-article style").length,
  handlerAttrs: [...document.querySelectorAll("#reader-article .reader-body *")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name) || ["style", "srcset", "formaction"].includes(a.name))).length,
  chromeAttrs: [...document.querySelectorAll("#reader-article *")].filter((el) => !el.closest(".reader-body") && [...el.attributes].some((a) => /^on/i.test(a.name)
    || (a.name === "style" && !(el.classList.contains("reader-hero-img") && /^--box: [0-9]+ \\/ [0-9]+;$/.test(a.value))))).length,
  heroBox: document.querySelector("#reader-article .reader-hero-img")?.getAttribute("style") ?? null,
  badLinks: [...document.querySelectorAll("#reader-article a[href]")].filter((a) => !a.href.startsWith("https:")).length })`));
const parseTime = (v) => /^(style-src-attr|style-src-elem|base-uri) /.test(v);
await closeByBrowserBack();
// H5: handlerAttrs counts only the sanitized body. H4 saw 1 here from the reader's own
// hero photo (H4 item 4's `style="--box: W / H"`, built from two checked integers, not
// feed markup) sitting in #reader-article above the body; chromeAttrs holds the rest of
// the article to the same rule, that one exact style excepted.
check("hostile body executes nothing", hostile.pwned.length === 0 && hostile.scripts === 0 && hostile.handlerAttrs === 0 && hostile.chromeAttrs === 0 && hostile.badLinks === 0 && hostile.reports.every(parseTime),
  { fixtures: HOSTILE.length + handlers.length + 1, hostileId, withHero: hostile.heroBox !== null, pwned: hostile.pwned, parseTimeReports: hostile.reports.length, scripts: hostile.scripts,
    handlerAttrs: hostile.handlerAttrs, chromeAttrs: hostile.chromeAttrs, heroBox: hostile.heroBox, badLinks: hostile.badLinks });
const darkReports = await evaluate("window.__csp");

// 8. Light: the same story opened from its #read- address (a reload, a shared link).
await load(`index.html#read-${picked.id}`, "light");
const lightOpen = await until(bodyReady, 4000);
await sleep(1200);
await shot("final-light.png");
const lightReports = await evaluate("window.__csp");
const lightBack = await evaluate(`(() => { document.getElementById("reader-back").click(); return new Promise((r) => setTimeout(() => r(document.getElementById("reader").hidden && location.hash === ""), 400)); })()`);
check("light, opened from its address", lightOpen && lightBack, { lightOpen, lightBack });

// Every report, by where it came from. The real bodies' reports are the same kind S37
// documented for hostile HTML: Chrome reporting a feed style attribute while the inert
// DOMParser document is built. Nothing the reader inserted may report anything.
const all = [...darkReports, ...lightReports];
const realParse = darkReports.length - hostile.reports.length + lightReports.length;
check("CSP: no violations but parse-time style reports", all.every(parseTime),
  { total: all.length, realBodiesParseTime: realParse, realBodyOpens: realOpens, hostileParseTime: hostile.reports.length, other: all.filter((v) => !parseTime(v)).length,
    firstOpenOfPickedStory: firstOpenReports, kinds: [...new Set(all.map((v) => v.split(" ")[0]))] });

console.log(JSON.stringify({ results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
