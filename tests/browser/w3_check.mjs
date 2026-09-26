// W3 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/w3_check.mjs [<screenshot dir>]
// The owner added two phrase interests and said their stories "never appeared". This
// builds the app from a pool made here (40 busy stories that outrank everything, the
// hourly search's watch-only items with no dek and no photo, a headline match, a dek
// match, a decoy with the words out of order, and a search hit for a standing story of
// his own) and serves it behind the simulated Access gate (cdp.mjs serve: a 302 to the
// login origin for any request without the cookie, the build's own _headers on every
// answer). Headless Chrome as a Galaxy S23 (360x780, DPR 3), dark and light, with a
// stored profile holding two phrase interests at Normal and that standing story:
//   1. Today re-ranks on the device to exactly the order passes.js gives on the page's
//      own input for that profile (R2 parity), CLS 0; where each match ranks is printed.
//   2. Following (#following, loaded directly): one section per phrase and standing
//      story, each listing following.js's matches newest first (five, then "See all");
//      CLS 0.
//   3. Why this, from a Following row's own menu, names the phrase.
//   4. Each phrase's page (/profile#interest/<id>) and the standing story's page list
//      every match, newest first, tappable (a link out); CLS 0.
// Every request carried the cookie (none met the login redirect), zero CSP violations,
// no console errors. Exits 1 on any failure. The phrases are invented.
//
// W3_DIST and W3_PHRASES (a JSON array) run the same checks against another built dist,
// for a local look at a real pool; nothing from such a run is written anywhere but the
// screenshot directory given.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCESS_LOGIN, PAGE_INPUT, launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { phraseQuery, storyQuery, watchTagSync } from "../../app/static/js/phrase.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { withPhraseAdded } from "../../app/static/js/profile/you-edits.js";
import { rankPages, pageOptions } from "../../app/static/js/passes.js";
import { FOLLOW_PREVIEW, followMatches } from "../../app/static/js/following.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(tmpdir(), "almanac-w3-check");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const PHRASES = process.env.W3_PHRASES ? JSON.parse(process.env.W3_PHRASES) : ["Harbor Tunnel", "Copper Valley"];
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");
const FERRY = { id: "ferry_strike", label: "Ferry strike", enabled: true, keywords: ["ferry strike", "ferry workers"], tags: [], buckets: [], floor_slots: 0, floor_within: 15, silence_hours: 0 };

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

function w3Pool() {
  const iso = (hours) => new Date(NOW_MS - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const art = (id, source, hours, title, extra = {}) => ({ id, source_id: source, url: `https://example.org/${id}`, title, published_at: iso(hours), topics: ["world"], ...extra });
  const [one, two] = PHRASES;
  const tag = (p) => watchTagSync(phraseQuery(p));
  const fillers = Array.from({ length: 40 }, (_, i) => art(`f${String(i).padStart(2, "0")}`, i % 2 ? "bbc" : "npr", 0.5 + i * 0.1,
    `Busy world filler story number ${i} from a crowded news day`, { topics: ["world", "us_politics"], dek: `A crowded day in the news, part ${i}, with little to add.` }));
  return {
    schema_version: 1,
    generated_at: iso(0),
    sources: [{ id: "npr", name: "NPR", feed_url: "https://example.org/npr" }, { id: "bbc", name: "BBC", feed_url: "https://example.org/bbc" },
      { id: "google_news_search", name: "Google News", feed_url: "https://news.google.com/rss/search" }],
    articles: [
      ...fillers,
      art("g1", "google_news_search", 2, "Commuters face a long detour this week", { watch: [tag(one)] }),
      art("g2", "google_news_search", 5, "Mine reopens after a two-year pause", { watch: [tag(two)] }),
      art("g3", "google_news_search", 1, "Both projects win state money", { watch: [tag(one), tag(two)] }),
      art("g4", "google_news_search", 6, "Night closures planned for the crossing", { watch: [tag(one)] }),
      art("g5", "google_news_search", 7, "Inspectors sign off on the new lining", { watch: [tag(one)] }),
      art("g6", "google_news_search", 8, "Contractor named for the next phase", { watch: [tag(one)] }),
      art("h1", "npr", 3, `${one} repairs begin on Monday`, { dek: "Crews will work overnight for a month." }),
      art("d1", "bbc", 4, "City council votes on transit", { dek: `The ${one.toLowerCase()}s will close at night.` }),
      art("x1", "npr", 1, `${one.split(" ").reverse().join(" of the ")} floods again`, { dek: "Pumps ran all night." }),
      art("s1", "google_news_search", 2, "Crossings cancelled as talks stall", { watch: [watchTagSync(storyQuery(FERRY.keywords))] }),
    ],
    clusters: [],
    counts: { fetched: 50, published: 50, drops: {}, leniency: {} },
  };
}

function build() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const poolPath = join(TMP, "w3_pool.json");
  writeFileSync(poolPath, JSON.stringify(w3Pool()));
  const dist = join(TMP, "dist");
  execFileSync(PYTHON, ["-m", "app.build", "--pool", poolPath, "--out", dist], { cwd: ROOT, stdio: "ignore" });
  return dist;
}

const dist = process.env.W3_DIST ? resolve(process.env.W3_DIST) : build();
const headerText = readFileSync(join(dist, "_headers"), "utf-8");
const site = await serve(dist, parseHeaders(headerText), {}, { "/sw.js": parseHeaders(headerText, "/sw.js") });
const chrome = await launch("w3-check");
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

// The stored profile, as the owner's phone holds it: the default, then one version with
// two phrase interests at Normal and a standing story of his own.
let profile = buildDefaultProfile(new Date(NOW_MS).toISOString());
for (const p of PHRASES) profile = withPhraseAdded(profile, p);
profile = { ...profile, standing_stories: [...profile.standing_stories, FERRY], profile_version: 2 };
const base = buildDefaultProfile(new Date(NOW_MS).toISOString());
const stored = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: base.updated_at, profile }] };
const phraseIds = Object.keys(profile.topics).filter((id) => profile.topics[id].phrase);

async function open(path, color) {
  await scheme(color);
  await send("Page.navigate", { url: `${site.origin}/health` });
  await sleep(300);
  await evaluate(`localStorage.clear(); localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})`);
  await send("Page.navigate", { url: `${site.origin}${path}` });
}

let input = null;
let expected = null;
for (const color of ["dark", "light"]) {
  // 1. Today, re-ranked on the device for the stored profile.
  await open("/", color);
  await waitFor(`!document.documentElement.classList.contains("rerank") && document.querySelector("#section-today li.story")`);
  await sleep(600);
  const today = await json(`({ order: [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid), input: ${PAGE_INPUT} })`);
  input = today.input;
  const pages = rankPages(input.pool, profile, input.now, pageOptions(input));
  const want = pages.today.map((s) => s.id);
  expected = followMatches(input, profile);
  const watchIds = new Set(input.pool.articles.filter((a) => (a.watch || []).length).map((a) => a.id));
  const where = pages.today.map((s, i) => [s.id, i + 1]).filter(([id]) => watchIds.has(id) || expected.some((f) => f.kind === "phrase" && f.stories.some((x) => x.id === id)));
  check(`today-parity-${color}`, JSON.stringify(today.order) === JSON.stringify(want), { rows: today.order.length, ranked: want.length, fold: 35, matchRanks: where.map(([, r]) => r) });
  const s1 = await pageState();
  check(`today-cls-csp-${color}`, s1.cls === 0 && !s1.csp.length, s1);
  await shot(`today-${color}.png`);

  // 2. Following, loaded directly.
  await open("/#following", color);
  await waitFor(`document.getElementById("following-list")?.dataset.ready === "true"`);
  await sleep(500);
  const following = await json(`[...document.querySelectorAll("#following-list .follow")].map((s) => ({
    follow: s.dataset.follow, name: s.querySelector(".follow-name").textContent, count: s.querySelector(".follow-count").textContent,
    rows: [...s.querySelectorAll("li.story")].map((li) => li.dataset.sid), more: s.querySelector(".follow-more")?.textContent || null,
    linked: [...s.querySelectorAll("li.story .story-link")].every((a) => a.href.startsWith("https://")),
    visible: getComputedStyle(document.getElementById("screen-following")).visibility }))`);
  const wantFollowing = expected.map((f) => ({ follow: `${f.kind}:${f.id}`, rows: f.stories.slice(0, FOLLOW_PREVIEW).map((s) => s.id), total: f.stories.length }));
  const same = wantFollowing.length === following.length && wantFollowing.every((w, i) => following[i].follow === w.follow
    && JSON.stringify(following[i].rows) === JSON.stringify(w.rows) && (w.total > FOLLOW_PREVIEW ? following[i].more === `See all ${w.total}` : following[i].more === null));
  const phraseRows = following.filter((f) => f.follow.startsWith("phrase:")).map((f) => f.rows.length);
  check(`following-${color}`, same && phraseRows.every((n) => n > 0) && following.every((f) => f.linked && f.visible === "visible"),
    { sections: following.map((f) => [f.follow.split(":")[0], f.count, f.rows.length, f.more]) });
  const s2 = await pageState();
  check(`following-cls-csp-${color}`, s2.cls === 0 && !s2.csp.length, s2);
  await shot(`following-${color}.png`);

  // 3. Why this, from the first phrase's first Following row.
  if (color === "dark") {
    const first = following.find((f) => f.follow.startsWith("phrase:") && f.rows.length);
    const phrase = profile.topics[first.follow.slice("phrase:".length)].phrase;
    await evaluate(`document.querySelector('#following-list .follow[data-follow="${first.follow}"] li.story .story-overflow').click()`);
    await waitFor(`document.querySelector('.sheet-item[data-action="why"]') && !document.getElementById("sheet-root").hidden`);
    await sleep(400);
    await evaluate(`document.querySelector('.sheet-item[data-action="why"]').click()`);
    await waitFor(`document.getElementById("sheet-label")?.textContent === "Why this"`);
    await sleep(500);
    const why = await evaluate(`document.getElementById("sheet-body").textContent`);
    check("why-this-names-the-phrase", why.includes(`“${phrase}”`), { row: first.rows[0], names: why.includes(phrase) });
    await shot("why-this-dark.png");
  }

  // 4. Each phrase's page, and the standing story's page.
  for (const [kind, id] of [...phraseIds.map((id) => ["phrase", id]), ["story", FERRY.id]]) {
    const path = kind === "phrase" ? `/profile#interest/${encodeURIComponent(id)}` : `/profile#story/${encodeURIComponent(id)}`;
    await open(path, color);
    await waitFor(`document.querySelector('[data-stories="${kind}:${id}"]')`);
    await sleep(500);
    const page = await json(`(() => { const s = document.querySelector('[data-stories="${kind}:${id}"]');
      return { hint: s.querySelector(".settings-hint").textContent, rows: [...s.querySelectorAll("li.story")].map((li) => li.dataset.sid),
        linked: [...s.querySelectorAll("li.story .story-link")].every((a) => a.href.startsWith("https://") && a.target === "_blank"),
        tall: [...s.querySelectorAll("li.story .story-link")].every((a) => a.getBoundingClientRect().height >= 48) }; })()`);
    const want = expected.find((f) => f.kind === kind && f.id === id).stories.map((s) => s.id);
    check(`page-${kind}-${phraseIds.indexOf(id) + 1 || "ferry"}-${color}`, JSON.stringify(page.rows) === JSON.stringify(want) && want.length > 0 && page.linked && page.tall,
      { rows: page.rows.length, hint: page.hint });
    const s3 = await pageState();
    check(`page-${kind}-${phraseIds.indexOf(id) + 1 || "ferry"}-cls-csp-${color}`, s3.cls === 0 && !s3.csp.length, s3);
    await shot(`page-${kind}-${phraseIds.indexOf(id) + 1 || "ferry"}-${color}.png`);
  }
}

check("access-gate", redirected.length === 0, { redirected });
check("console", errors.length === 0, { errors: errors.slice(0, 5) });
chrome.close();
site.close();
console.log(JSON.stringify(results, null, 1));
const passed = Object.values(results).filter((r) => r.pass).length;
console.log(`w3_check: ${passed}/${Object.keys(results).length} checks passed`);
process.exit(ok ? 0 : 1);
