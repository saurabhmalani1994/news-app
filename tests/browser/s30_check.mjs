// S30 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/s30_check.mjs [<screenshot dir>]
// Builds the app from a pool made here (W3's own 40 busy fillers, a phrase interest's
// matches, and a "Ferry strike" standing story with active coverage) and serves it
// behind the simulated Access gate (cdp.mjs serve), Galaxy S23 (360x780, DPR 3), dark
// and light, with a stored profile holding the phrase and the ferry story (the shipped
// defaults, Israel and Gaza and Sudan, ride along with no matching articles at all, so
// their silence alarm is active):
//   1. Front page load records every current match into the local archive
//      (follow-archive.js, follow-archive-store.js), once per follow.
//   2. The phrase's own page (/profile#interest/<id>): Timeline groups the archive by
//      day (Today), Coverage's one-line count and its per-story rows open the S14
//      coverage sheet.
//   3. The ferry standing story's page (/profile#story/ferry): same Timeline and
//      Coverage, no silence notice (its alarm is off).
//   4. Sudan's page (/profile#story/sudan, a shipped default with nothing in this pool):
//      the silence notice (standing.js silenceNotices) at the top of the page.
//   5. A plain reload of the phrase's page, with no re-visit to the front page: the
//      Timeline still shows the same archive, proving it survived in IndexedDB, not
//      only in the page's own memory.
// CLS 0 throughout, zero CSP violations, no console errors, every request carried the
// Access cookie. Exits 1 on any failure. The phrase is invented.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCESS_LOGIN, PAGE_INPUT, launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { phraseQuery, watchTagSync } from "../../app/static/js/phrase.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { withPhraseAdded } from "../../app/static/js/profile/you-edits.js";
import { rankPages, pageOptions } from "../../app/static/js/passes.js";
import { followMatches } from "../../app/static/js/following.js";
import { followCoverageSummary } from "../../app/static/js/follow-coverage.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(tmpdir(), "almanac-s30-check");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const PHRASE = process.env.S30_PHRASE || "Meridian Bridge";
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");
const FERRY = { id: "ferry", label: "Ferry strike", enabled: true, keywords: ["ferry strike", "ferry workers"], tags: [], buckets: [], floor_slots: 0, floor_within: 15, silence_hours: 0 };

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

function s30Pool() {
  const iso = (hours) => new Date(NOW_MS - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const art = (id, source, hours, title, extra = {}) => ({ id, source_id: source, url: `https://example.org/${id}`, title, published_at: iso(hours), topics: ["world"], ...extra });
  const tag = watchTagSync(phraseQuery(PHRASE));
  const fillers = Array.from({ length: 40 }, (_, i) => art(`f${String(i).padStart(2, "0")}`, i % 2 ? "bbc" : "npr", 0.5 + i * 0.1,
    `Busy world filler story number ${i} from a crowded news day`, { topics: ["world", "us_politics"], dek: `A crowded day in the news, part ${i}, with little to add.` }));
  return {
    schema_version: 1,
    generated_at: iso(0),
    sources: [{ id: "npr", name: "NPR", feed_url: "https://example.org/npr" }, { id: "bbc", name: "BBC", feed_url: "https://example.org/bbc" },
      { id: "reuters", name: "Reuters", feed_url: "https://example.org/reuters" }],
    articles: [
      ...fillers,
      art("h1", "npr", 3, `${PHRASE} repairs begin on Monday`, { dek: "Crews will work overnight for a month." }),
      art("d1", "bbc", 4, "City council votes on transit", { dek: `The ${PHRASE.toLowerCase()} will close at night.` }),
      art("s1", "npr", 2, "Ferry crossings cancelled as talks stall"),
      art("s2", "bbc", 6, "Ferry workers vote to walk out"),
      art("s3", "reuters", 10, "Ferry strike enters its second day"),
    ],
    // The phrase's two matches share one cluster, so its own page has a real
    // multi-outlet story to open the S14 coverage sheet for (step 2 below); the ferry
    // matches stay singletons, which followCoverageSummary and the Timeline both
    // already handle (S14's own coverage view needs 2+ outlets, following.js's
    // matching does not).
    clusters: [{ id: "phrase_cluster", article_ids: ["h1", "d1"], near_duplicates: [], independent_sources: 2, lean_buckets: [] }],
    counts: { fetched: 46, published: 46, drops: {}, leniency: {} },
  };
}

function build() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const poolPath = join(TMP, "s30_pool.json");
  writeFileSync(poolPath, JSON.stringify(s30Pool()));
  const dist = join(TMP, "dist");
  execFileSync(PYTHON, ["-m", "app.build", "--pool", poolPath, "--out", dist], { cwd: ROOT, stdio: "ignore" });
  return dist;
}

const dist = process.env.S30_DIST ? resolve(process.env.S30_DIST) : build();
const headerText = readFileSync(join(dist, "_headers"), "utf-8");
const site = await serve(dist, parseHeaders(headerText), {}, { "/sw.js": parseHeaders(headerText, "/sw.js") });
const chrome = await launch("s30-check");
const { send, evaluate } = chrome;
const errors = [];
const redirected = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  const location = (r) => (r?.headers?.location || r?.headers?.Location || "");
  if (m.method === "Network.responseReceived" && location(m.params.response).startsWith(ACCESS_LOGIN)) redirected.push(m.params.response.url);
  if (m.method === "Network.requestWillBeSent" && location(m.params.redirectResponse).startsWith(ACCESS_LOGIN)) redirected.push(m.params.redirectResponse.url);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => {
  if (!SHOTS) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(SHOTS, name), Buffer.from(png, "base64"));
};
const json = async (expr) => JSON.parse(await evaluate(`(async () => JSON.stringify(await (${expr})))()`) ?? "null");
const scheme = (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
async function waitFor(expr, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(120)) {
    try { if (await evaluate(expr)) return true; } catch {}
  }
  return false;
}
const pageState = () => json(`({ cls: window.__cls, csp: window.__csp })`);

// A direct IndexedDB read, the same store follow-archive-store.js opens, so the proof
// never has to import that module into the page (it is loaded lazily by profile-screen.js).
const ARCHIVE_ITEMS = (key) => `(async () => { try {
  const db = await new Promise((res, rej) => { const r = indexedDB.open("almanac-follow-archive", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  if (!db.objectStoreNames.contains("follows")) return [];
  return await new Promise((res) => { const tx = db.transaction("follows"); const req = tx.objectStore("follows").get(${JSON.stringify(key)});
    req.onsuccess = () => res(req.result && req.result.items ? req.result.items : []); req.onerror = () => res([]); });
} catch { return []; } })()`;

let profile = buildDefaultProfile(new Date(NOW_MS).toISOString());
profile = withPhraseAdded(profile, PHRASE);
profile = { ...profile, standing_stories: [...profile.standing_stories, FERRY], profile_version: 2 };
const base = buildDefaultProfile(new Date(NOW_MS).toISOString());
const stored = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: base.updated_at, profile }] };
const phraseId = Object.keys(profile.topics).find((id) => profile.topics[id].phrase);

async function open(path, color) {
  await scheme(color);
  await send("Page.navigate", { url: `${site.origin}/health` });
  await sleep(300);
  await evaluate(`localStorage.clear(); localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})`);
  await send("Page.navigate", { url: `${site.origin}${path}` });
}

let input = null;
const expected = () => followMatches(input, profile);

for (const color of ["dark", "light"]) {
  // 1. Front page load records every current match into the archive.
  await open("/", color);
  await waitFor(`!document.documentElement.classList.contains("rerank") && document.querySelector("#section-today li.story")`);
  await sleep(600);
  input = (await json(`({ input: ${PAGE_INPUT} })`)).input;
  const phraseMatches = expected().find((f) => f.kind === "phrase").stories.map((s) => s.id);
  const ferryMatches = expected().find((f) => f.id === "ferry").stories.map((s) => s.id);
  const phraseArchived = await waitFor(`(${ARCHIVE_ITEMS(`phrase:${phraseId}`)}).then((items) => items.length >= ${phraseMatches.length})`);
  const ferryArchived = await waitFor(`(${ARCHIVE_ITEMS("story:ferry")}).then((items) => items.length >= ${ferryMatches.length})`);
  check(`archived-on-front-load-${color}`, phraseArchived && ferryArchived, { phraseMatches: phraseMatches.length, ferryMatches: ferryMatches.length });
  const s1 = await pageState();
  check(`front-cls-csp-${color}`, s1.cls === 0 && !s1.csp.length, s1);

  // 2. The phrase's own page: Timeline (grouped by day) and Coverage (the one-line
  // count, and a row per story that opens the S14 sheet).
  const phrasePath = `/profile#interest/${encodeURIComponent(phraseId)}`;
  await send("Page.navigate", { url: `${site.origin}${phrasePath}` });
  await waitFor(`document.querySelector('[data-timeline="phrase:${phraseId}"]')`);
  await sleep(600);
  const phrasePage = await json(`(() => {
    const timeline = document.querySelector('[data-timeline="phrase:${phraseId}"]');
    const coverage = document.querySelector('[data-coverage="phrase:${phraseId}"]');
    return {
      days: [...timeline.querySelectorAll(".timeline-day")].map((h) => h.textContent),
      rows: [...timeline.querySelectorAll("li.timeline-row")].length,
      hint: coverage.querySelector(".settings-hint").textContent,
      coverageRows: [...coverage.querySelectorAll(".coverage-story-row")].length,
    }; })()`);
  const summary = followCoverageSummary(expected().find((f) => f.kind === "phrase").stories, input, []);
  // The fixture's own clock (2026-09-24) is fixed, not the real device clock the day
  // label is drawn against (historyDayLabel, S34's own function), so the label read
  // here is whatever day that gap works out to on the day this proof happens to run,
  // not always literally "Today"; the day grouping itself (one group, the right count)
  // is what this checks.
  check(`phrase-timeline-${color}`, phrasePage.days.length === 1 && phrasePage.rows === phraseMatches.length, phrasePage);
  check(`phrase-coverage-${color}`, phrasePage.hint === summary.text && phrasePage.coverageRows === Math.min(phraseMatches.length, 5), { hint: phrasePage.hint, want: summary.text });
  const s2 = await pageState();
  check(`phrase-page-cls-csp-${color}`, s2.cls === 0 && !s2.csp.length, s2);
  if (color === "dark") {
    // The coverage row opens the S14 sheet.
    await evaluate(`document.querySelector('.coverage-story-row').click()`);
    await waitFor(`document.getElementById("sheet-label")?.textContent === "Coverage" && !document.getElementById("sheet-root").hidden`);
    await sleep(400);
    const sheetText = await evaluate(`document.getElementById("sheet-body").textContent`);
    check("coverage-sheet-opens", /outlets?, .* independent/.test(sheetText), { sheetText: sheetText.slice(0, 80) });
    await shot("coverage-sheet-dark.png");
  }
  await shot(`phrase-page-${color}.png`);

  // 3. The ferry standing story's page: same Timeline and Coverage, no silence notice.
  const ferryPath = "/profile#story/ferry";
  await send("Page.navigate", { url: `${site.origin}${ferryPath}` });
  await waitFor(`document.querySelector('[data-timeline="story:ferry"]')`);
  await sleep(600);
  const ferryPage = await json(`(() => {
    const timeline = document.querySelector('[data-timeline="story:ferry"]');
    return { rows: [...timeline.querySelectorAll("li.timeline-row")].length, notice: Boolean(document.querySelector('.notice[data-standing="ferry"]')) }; })()`);
  check(`ferry-timeline-${color}`, ferryPage.rows === ferryMatches.length && !ferryPage.notice, ferryPage);
  await shot(`ferry-page-${color}.png`);

  // 4. Sudan (a shipped default, nothing in this pool): the silence notice at the top.
  await send("Page.navigate", { url: `${site.origin}/profile#story/sudan` });
  await waitFor(`document.querySelector('[data-timeline="story:sudan"]')`);
  await sleep(500);
  const sudanNotice = await json(`(() => { const n = document.querySelector('.notice[data-standing="sudan"]');
    return n && { kind: n.dataset.kind, kicker: n.querySelector(".notice-kicker").textContent, head: n.querySelector(".notice-head").textContent }; })()`);
  check(`sudan-silence-notice-${color}`, Boolean(sudanNotice) && sudanNotice.kind === "no-coverage" && sudanNotice.kicker.includes("Sudan"), sudanNotice);
  await shot(`sudan-silence-${color}.png`);

  // 5. A plain reload of the phrase's page (no re-visit to the front page): the
  // Timeline survives, proving it lives in IndexedDB, not only page memory.
  await send("Page.navigate", { url: `${site.origin}${phrasePath}` });
  await waitFor(`document.querySelector('[data-timeline="phrase:${phraseId}"]')`);
  await sleep(600);
  const reloaded = await json(`[...document.querySelectorAll('[data-timeline="phrase:${phraseId}"] li.timeline-row')].length`);
  check(`archive-survives-reload-${color}`, reloaded === phraseMatches.length, { before: phraseMatches.length, after: reloaded });
}

check("access-gate", redirected.length === 0, { redirected });
check("console", errors.length === 0, { errors: errors.slice(0, 5) });
chrome.close();
site.close();
console.log(JSON.stringify(results, null, 1));
const passed = Object.values(results).filter((r) => r.pass).length;
console.log(`s30_check: ${passed}/${Object.keys(results).length} checks passed`);
process.exit(ok ? 0 : 1);
