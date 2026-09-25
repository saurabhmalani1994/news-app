// U5 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/u5_check.mjs [<screenshot dir>]
// The owner, on his phone: "the you page now got way too big again. make the individual
// topics nested again - otherwise its too big ... specifically the news sources page."
// U2's picker once drew all 97 sources at once, grouped but never collapsed; main is
// the nested picker now (U5 landed), so there is no older "flat" build left to compare
// against. H4 item 5: reworked from a flat-build-vs-this-one ratio to a direct claim
// the owner's fix actually promises, that the collapsed list fits one screen. This
// builds the app from a pool carrying every configured source (golden_pool.json's own
// articles, sources.json's full source list), and serves it the way Cloudflare Pages
// does (pretty URLs, the build's own _headers) behind a simulated Cloudflare Access
// gate (BUILDER-RULES: no request answers without the CF_Authorization cookie, else a
// 302 to a login origin), to headless Chrome as a 360x780 CSS px, DPR 3 phone:
//   1. #sources draws about eight collapsed group rows, not 97 source rows, and the
//      whole page fits the one 780px screen with no scroll needed to reach the nav.
//   2. Opening a group is a forward step to its own sub-view listing every one of its
//      sources, each with its usual switch and lean marker; the masthead Back returns
//      to the group list, not all the way to You.
//   3. Toggling a source there writes exactly one profile version (mutes.sources), same
//      as before this slice, and the device re-rank on Home reads it.
//   4. The list's own search field shows matches flat across every group while it holds
//      text; clearing it restores the collapsed list.
// Zero CSP violations and CLS 0 throughout. Saves collapsed-dark.png, collapsed-light.png,
// group-expanded-dark.png, search-results-dark.png in the given screenshot dir. Exits 1
// on any failure.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { groupSources, searchSources } from "../../app/static/js/profile/you-edits.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PY = PYTHON; // PYTHON env, else the repo .venv (tests/browser/python.mjs)
const TMP = join(ROOT, "tests", ".tmp-u5");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

/** golden_pool.json's own articles (so app.build has something to rank), with every
 * one of sources.json's 97 sources in `sources` instead of its one stand-in, so the
 * built source-catalog.json (and so the picker) carries the full, real catalog. */
function fullSourcePool() {
  const pool = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "golden_pool.json"), "utf-8"));
  const catalog = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf-8"));
  pool.sources = catalog.sources.map((s) => ({ id: s.id, name: s.name, feed_url: s.feed_url || "" }));
  const path = join(TMP, "full_pool.json");
  writeFileSync(path, JSON.stringify(pool));
  return path;
}

/** The working tree's app/, built from `pool`. */
function build(pool) {
  const dist = join(TMP, "dist-tree");
  rmSync(dist, { recursive: true, force: true });
  execFileSync(PY, ["-m", "app.build", "--pool", pool, "--out", dist], { cwd: ROOT, stdio: "ignore" });
  return dist;
}

/** Serves `dist` the way Cloudflare Pages does, behind a simulated Access gate: no
 * request answers without the CF_Authorization cookie, else a 302 to a login origin
 * (BUILDER-RULES "Behind Access"). Gate starts on; there is no pre-Access phase to
 * prove here (H3 already covers the worker's own Access behavior). */
function gatedSite(dist) {
  const root = resolve(dist);
  const headers = parseHeaders(readFileSync(join(root, "_headers"), "utf-8"));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const cookie = /(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "");
    if (!cookie) {
      res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/almanac?redirect_url=${encodeURIComponent(pathname)}` }).end();
      return;
    }
    const file = (p) => join(root, p);
    const inRoot = (p) => p.startsWith(root) && existsSync(p) && statSync(p).isFile();
    if (pathname.endsWith(".html") && inRoot(file(pathname))) {
      const pretty = pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : pathname.slice(0, -".html".length);
      res.writeHead(308, { ...headers, location: pretty + url.search }).end();
      return;
    }
    let path = file(pathname.endsWith("/") ? pathname + "index.html" : pathname);
    if (!inRoot(path) && !extname(pathname) && inRoot(file(pathname + ".html"))) path = file(pathname + ".html");
    if (!inRoot(path)) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  return new Promise((r) => server.on("listening", () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const pool = fullSourcePool();
const distNew = build(pool); // "New" kept (not renamed) to hold the diff to item 5's own scope
const siteNew = await gatedSite(distNew);

const chrome = await launch("u5-check");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });
// A host-based cookie (no port), same as Cloudflare Access's own, reaches both origins.
await send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: "http://127.0.0.1/", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" });

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => {
  if (!SHOTS) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(SHOTS, name), Buffer.from(png, "base64"));
};
const ready = () => evaluate("document.getElementById('settings-root').getAttribute('aria-busy') !== 'true' && document.getElementById('settings-root').childElementCount > 0");
const store = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`);
const versions = async () => (await store()).history.length;
const pageHeight = () => evaluate("document.documentElement.scrollHeight");
async function open(origin, path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}${path}` });
  for (let i = 0; i < 40 && !(await ready().catch(() => false)); i++) await sleep(100);
  await sleep(300);
}

// 0. Page height: the collapsed list itself, the claim behind U5 ("otherwise its too
// big"), fits the one 780px screen with no scroll needed to reach the bottom nav. H4
// item 5: main now ships this same collapsed picker (U5 landed), so there is no older
// flat build left to compare against; a ratio against one would only ever read ~1.0 and
// never fail, so it is a direct one-screen claim instead.
await open(siteNew.origin, "/profile");
await evaluate("localStorage.clear(); sessionStorage.clear()");
await open(siteNew.origin, "/profile#sources");
const heightNew = await pageHeight();
const VIEWPORT_HEIGHT = 780;
check("collapsed_list_fits_one_screen", heightNew <= VIEWPORT_HEIGHT, { heightNew, viewport: VIEWPORT_HEIGHT });
console.log(`page height, #sources: ${heightNew}px collapsed, one screen is ${VIEWPORT_HEIGHT}px`);

// 1. The collapsed list: about eight rows, each "N of M on" and a chevron, no source
// rows drawn at all.
const catalog = JSON.parse(readFileSync(join(distNew, "source-catalog.json"), "utf-8"));
const expectedGroups = groupSources(catalog.sources);
const list0 = JSON.parse(await evaluate(`JSON.stringify({
  rows: [...document.querySelectorAll("#source-group-list a[data-group]")].map((a) => ({
    id: a.dataset.group, label: a.querySelector(".setting-label").textContent, value: a.querySelector(".setting-value").textContent,
  })),
  sourceRowsDrawn: document.querySelectorAll("[data-source]").length,
})`));
check("collapsed_list_is_about_eight_groups_no_source_rows", list0.rows.length === expectedGroups.length
  && list0.rows.length >= 6 && list0.rows.length <= 10 && list0.sourceRowsDrawn === 0
  && list0.rows.every((r, i) => r.id === expectedGroups[i].id && r.label === expectedGroups[i].label
    && r.value === `${expectedGroups[i].sources.length} of ${expectedGroups[i].sources.length} on`),
  { list0, expected: expectedGroups.map((g) => ({ id: g.id, label: g.label, count: g.sources.length })) });
await shot("collapsed-dark.png");
await open(siteNew.origin, "/profile#sources", "light");
await shot("collapsed-light.png");
await open(siteNew.origin, "/profile#sources");

// 2. Opening a group: a forward step to its own sub-view, every one of its sources
// listed, each still carrying its switch and lean marker.
const target = expectedGroups.find((g) => g.sources.length >= 3) || expectedGroups[0];
await evaluate(`document.querySelector('a[data-group="${target.id}"]').click()`);
await sleep(400);
const groupPage = JSON.parse(await evaluate(`JSON.stringify({
  hash: location.hash, title: document.getElementById("page-title").textContent, y: scrollY,
  listed: [...document.querySelectorAll("[data-source]")].map((r) => r.dataset.source),
  hasTurnAll: !!document.querySelector('[data-focus-key="group-all"]'),
})`));
check("group_expands_to_its_own_sources_at_the_top", groupPage.hash === `#sources/${target.id}` && groupPage.title === target.label && groupPage.y === 0
  && groupPage.listed.length === target.sources.length && new Set(groupPage.listed).size === groupPage.listed.length
  && target.sources.every((s) => groupPage.listed.includes(s.id)) && groupPage.hasTurnAll,
  { groupPage, expected: target.sources.map((s) => s.id) });
await shot("group-expanded-dark.png");

// 3. Toggling a source in the group: one version, mutes.sources carries it, and the
// device re-rank on Home reads it right after.
const toggleId = groupPage.listed[0];
const v0 = await versions();
await evaluate(`document.querySelector('[data-source="${toggleId}"] input.switch').click()`);
await sleep(300);
const afterToggle = JSON.parse(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.mutes.sources)`));
const v1 = await versions();
check("toggle_in_group_is_one_version_mutes_sources", v1 === v0 + 1 && afterToggle.includes(toggleId), { toggleId, afterToggle, v0, v1 });
await evaluate(`document.getElementById("toast").hidden = true`);
const storedAfterToggle = await store();
await open(siteNew.origin, "/");
const home = JSON.parse(await evaluate(`JSON.stringify({
  almanacProfileMutesIt: !!(window.almanacProfile && window.almanacProfile.mutes && window.almanacProfile.mutes.sources && window.almanacProfile.mutes.sources.includes(${JSON.stringify(toggleId)})),
})`));
check("home_rerank_reads_the_toggled_source", home.almanacProfileMutesIt, { home, storedHistoryLen: storedAfterToggle.history.length });
await open(siteNew.origin, "/profile#sources");
await evaluate(`document.querySelector('a[data-group="${target.id}"]').click()`);
await sleep(400);

// 4. Back returns to the group list it was opened from, not all the way to You.
await evaluate(`document.getElementById("masthead-back").click()`);
await sleep(400);
const backToList = JSON.parse(await evaluate(`JSON.stringify({ hash: location.hash, view: document.getElementById("settings-root").dataset.view })`));
check("group_back_returns_to_the_sources_list", backToList.hash === "#sources" && backToList.view === "sources", backToList);

// 5. Search shows matches flat, from any group, while it holds text; clearing restores
// the collapsed list.
const query = "times";
const expectedSearch = searchSources(catalog.sources, query);
await evaluate(`(() => { const s = document.querySelector(".search-field"); s.focus(); s.value = ${JSON.stringify(query)}; s.dispatchEvent(new Event("input")); })()`);
await sleep(200);
const searched = JSON.parse(await evaluate(`JSON.stringify({
  groupListHidden: document.getElementById("source-group-list").hidden,
  resultIds: [...document.querySelectorAll("#source-search-results [data-source]")].map((r) => r.dataset.source),
})`));
check("search_shows_flat_matches_across_groups", searched.groupListHidden && expectedSearch.length > 0
  && searched.resultIds.length === expectedSearch.length && new Set(searched.resultIds).size === searched.resultIds.length
  && expectedSearch.every((s) => searched.resultIds.includes(s.id)),
  { searched, expected: expectedSearch.map((s) => s.id) });
await shot("search-results-dark.png");

await evaluate(`(() => { const s = document.querySelector(".search-field"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);
await sleep(200);
const cleared = JSON.parse(await evaluate(`JSON.stringify({
  groupListHidden: document.getElementById("source-group-list").hidden,
  resultsHidden: document.getElementById("source-search-results").hidden,
})`));
check("clearing_search_restores_the_collapsed_list", !cleared.groupListHidden && cleared.resultsHidden, cleared);
await evaluate("document.activeElement.blur(); document.getElementById('toast').hidden = true");

// 6. Back from the list itself lands on You.
await evaluate(`document.getElementById("masthead-back").click()`);
await sleep(400);
const backToYou = JSON.parse(await evaluate(`JSON.stringify({ hash: location.hash, view: document.getElementById("settings-root").dataset.view })`));
check("list_back_returns_to_you", backToYou.view === "you", backToYou);

const totalCls = await evaluate("window.__cls");
const totalCsp = await evaluate("window.__csp.length");
check("cls_zero", totalCls === 0, { totalCls });
check("csp_zero", totalCsp === 0, { totalCsp });
check("no_console_errors", errors.length === 0, { errors });

chrome.close();
siteNew.close();
rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 1));
console.log(`page height: ${heightNew}px collapsed, fits within ${VIEWPORT_HEIGHT}px`);
console.log(ok ? "U5 CHECK: PASS" : "U5 CHECK: FAIL");
process.exit(ok ? 0 : 1);
