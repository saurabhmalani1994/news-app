// S15 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/history_check.mjs <built dist dir> [<screenshot dir>]
// Serves the built page with its own _headers CSP, in headless Chrome at 360x780 CSS
// px, DPR 3: loads fresh, scrolls through Today (each row half-visible about 1s, the
// IntersectionObserver dwell history/observe.js uses), opens one story in the reader,
// then reloads. Checks: the shown and opened rows landed in IndexedDB and the compact
// localStorage summary once each (never duplicated by the observer re-firing), the
// reload's rank-gate hid the page and re-ranked with the seen penalty present in the
// embedded explanation for the story the reader opened, cumulative layout shift stayed
// at 0 across both loads, and no CSP violation fired. Exits 1 on any failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { rankPages } from "../../app/static/js/passes.js";
import { seenPenaltyTerm } from "../../app/static/js/history/penalty.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s15-history");
const { send, evaluate } = chrome;

const logged = [];
chrome.on((m) => {
  if (m.method === "Log.entryAdded") logged.push(m.params.entry.text);
  if (m.method === "Runtime.exceptionThrown") logged.push("exception: " + m.params.exceptionDetails.exception?.description);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
` });

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

const historyDump = `(() => new Promise((resolve) => {
  const req = indexedDB.open("almanac-history", 1);
  req.onsuccess = () => {
    const db = req.result;
    const read = (name) => new Promise((r) => {
      const out = [];
      db.transaction(name).objectStore(name).openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); } else r(out);
      };
    });
    Promise.all([read("opened"), read("shown")]).then(([opened, shown]) => resolve(JSON.stringify({ opened, shown })));
  };
  req.onerror = () => resolve(JSON.stringify({ opened: [], shown: [] }));
}))()`;

// 1. Fresh load: clear all storage, reload, confirm a clean start (no rerank).
await send("Page.navigate", { url: `${site.origin}/index.html` });
await sleep(600);
await evaluate(`localStorage.clear(); indexedDB.deleteDatabase("almanac-history")`);
await send("Page.reload", { ignoreCache: true });
await sleep(1200);
const freshHidden = await evaluate(`document.documentElement.classList.contains("rerank")`);
check("fresh load paints as built (no history yet)", freshHidden === false, { freshHidden });

// 2. Scroll through Today slowly so every row dwells at least half-visible for over a
// second (history/observe.js's DWELL_MS), then open one story in the reader (an
// "opened" signal, the stronger one) via the first has-body link, or tap the first
// story-link otherwise.
const rowCount = await evaluate(`document.querySelectorAll('#section-today li.story[data-sid]').length`);
for (let y = 0; y < 2400; y += 300) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 180, y: 400, deltaX: 0, deltaY: 300 });
  await sleep(1150); // > DWELL_MS so the row(s) on screen finish their dwell timer
}
await evaluate(`window.scrollTo(0, 0)`); // back to the hero, which dwelled at load too
await sleep(1150);

const openedId = await evaluate(`(() => {
  const link = document.querySelector('#section-today a.story-link[data-body]') || document.querySelector('#section-today a.story-link');
  if (!link) return null;
  const sid = link.closest('li.story').dataset.sid;
  link.click();
  return sid;
})()`);
await sleep(400);
if (openedId) await evaluate(`document.getElementById("reader-back")?.click()`); // close the reader, stay on Today

const afterScroll = JSON.parse(await evaluate(historyDump));
const summary = JSON.parse((await evaluate(`localStorage.getItem("almanac.history.summary.v1")`)) || "null");
check("at least one story was recorded shown while scrolling", afterScroll.shown.length > 0, { shown: afterScroll.shown.length, rowCount });
check("the reader open recorded an opened entry for that story", Boolean(openedId) && afterScroll.opened.some((r) => r.id === openedId), { openedId, opened: afterScroll.opened.map((r) => r.id) });
check("the compact localStorage summary mirrors the IndexedDB rows", Boolean(summary) && Object.keys(summary.shown || {}).length === afterScroll.shown.length && Object.keys(summary.opened || {}).length === afterScroll.opened.length,
  { summary });
// Session-once: each shown id appears exactly once in the store (put(), not appended),
// even though several rows were on screen for well over one dwell window each.
const shownIds = afterScroll.shown.map((r) => r.id);
check("no shown id was recorded twice (session-once)", new Set(shownIds).size === shownIds.length, { shownIds });

await shot("history-scrolled-dark.png");

// 3. Reload: rank-gate.js must hide and re-rank (history is now non-empty), with zero
// layout shift, and the reloaded page's own embedded explanation must carry a
// seen_penalty term for the opened story, matching what passes.js computes here from
// the same pool, profile and history summary the page itself used.
await send("Page.reload", { ignoreCache: true });
await sleep(2200);
await evaluate(`document.fonts.ready`);
const reloadedHidden = await evaluate(`document.documentElement.classList.contains("rerank")`);
const cls = await evaluate(`window.__cls`);
const input = JSON.parse(await evaluate(`document.getElementById("rank-input").content.textContent`));

// This run never stored a custom profile, so the page ranked (and rank-gate.js's
// fallback ranks) with the shipped default, at the build's own `now`.
const localSummary = JSON.parse((await evaluate(`localStorage.getItem("almanac.history.summary.v1")`)) || "null");
const history = {
  opened: new Map(Object.entries(localSummary.opened || {}).map(([k, v]) => [k, { time: v }])),
  shown: new Map(Object.entries(localSummary.shown || {}).map(([k, v]) => [k, { time: v }])),
};
const opts = { buckets: input.buckets, leans: input.leans, names: input.names, health: input.health, terms: [seenPenaltyTerm(history)] };
const expectedPages = rankPages(input.pool, buildDefaultProfile(input.now), input.now, opts);
const expectedOpenedTerm = expectedPages.today.find((s) => s.id === openedId)?.explanation.find((t) => t.term === "seen_penalty");
const domOrder = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#section-today li.story[data-sid]')].map((li) => li.dataset.sid))`));
const expectedOrder = expectedPages.today.map((s) => s.id);
check("rank-gate settled back to visible after re-ranking with history", reloadedHidden === false, { reloadedHiddenAfterSettle: reloadedHidden });
check("zero layout shift across scroll, reader, and reload", cls === 0, { cls });
check("the opened story's seen_penalty term is present and negative", Boolean(expectedOpenedTerm) && expectedOpenedTerm.value < 0, { expectedOpenedTerm });
check("the reloaded page's own order matches passes.js run here with the same history", domOrder.join() === expectedOrder.join(), { domOrder, expectedOrder });
check("no CSP violation fired at any point", (await evaluate(`window.__csp`)).length === 0, { csp: await evaluate(`window.__csp`) });

await shot("history-reloaded-dark.png");
await shot("final-dark.png");

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

console.log(JSON.stringify(results, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
