// V1 browser proof (B6's proof, docs/DESIGN-bundles.md section 7), run by hand (needs
// Chrome, so not in the node --test glob):
//   node tests/browser/v1_check.mjs <built dist dir> [<screenshot dir>]
// The dist's own pool.json also seeds a second, hostile build (a version's headline set
// to markup), built here with the repo's Python (tests/browser/python.mjs).
//
// Serves each build the way Cloudflare Pages does (the build's own _headers, pretty
// URLs) behind an Access-like gate (no CF_Authorization cookie: a 302 to a login
// origin), to headless Chrome as a phone (Android Chrome user agent, 360x780 CSS px,
// DPR 3, touch). Checks:
//   - every request the page and its service worker make carries the cookie, the
//     worker controls the page, and the carousel's modules load under it;
//   - how many of today's rows open a carousel, and the largest version count;
//   - a tap on "N sources" reaches the trigger and opens the carousel for that row's
//     cluster; the headline beside it is still the story's;
//   - CLS 0 across open, a touch swipe, and close (every layout shift counted, input
//     or not), and back returns to the same feed scroll position, focus on the trigger;
//   - aria: the carousel region, slides, a tablist of chips; arrow keys, Home and End;
//   - an 11-or-more-version strip scrolls its active chip into view;
//   - reduced motion jumps a slide in one step, where motion on glides;
//   - "Read" opens the reader above and back returns to the same slide; the footer opens
//     the coverage sheet and back returns; the word-mark switch persists in the profile;
//     a muted source is neither shown nor counted; compared is recorded, not "opened";
//   - a hostile headline renders as text; zero CSP violations; zero page errors.
// Screenshots (optional): each swept word-mark treatment in dark and light, the chosen
// one, a grayscale capture, the row trigger, the 11-version strip. Exits 1 on failure.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { smartQuotes } from "../../app/static/js/reader/core.js";

const [distArg, shotsArg] = process.argv.slice(2);
const GIVEN = resolve(distArg || "dist");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const SWEEP = ["underline", "weight", "swipe", "key"];
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

/** One gated origin serving `dir` as Pages does; `log` records every request. */
async function gatedSite(dir) {
  const root = resolve(dir);
  const text = readFileSync(join(root, "_headers"), "utf-8");
  const headers = parseHeaders(text);
  const swHeaders = parseHeaders(text, "/sw.js");
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const cookie = /(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "");
    log.push({ path: pathname, cookie });
    if (!cookie) {
      res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/almanac?redirect_url=${encodeURIComponent(pathname)}` }).end();
      return;
    }
    const own = { ...headers, ...(pathname === "/sw.js" ? swHeaders : {}) };
    const file = (p) => join(root, p);
    const inRoot = (p) => p.startsWith(root) && existsSync(p) && statSync(p).isFile();
    if (pathname.endsWith(".html") && inRoot(file(pathname))) {
      res.writeHead(308, { ...own, location: (pathname.endsWith("/index.html") ? pathname.slice(0, -10) : pathname.slice(0, -5)) + url.search }).end();
      return;
    }
    let path = file(pathname.endsWith("/") ? pathname + "index.html" : pathname);
    if (!inRoot(path) && !extname(pathname) && inRoot(file(pathname + ".html"))) path = file(pathname + ".html");
    if (!inRoot(path)) { res.writeHead(404, own).end(); return; }
    res.writeHead(200, { ...own, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() };
}

// R2: an 11-or-more-version cluster is a matter of the day's news, so every pool goes
// through tests/browser/fixtures/v1_pool.py: the same pool with its largest cluster
// grown to 12 versions from the pool's own single stories, built here beside the
// given dist (its bodies/ copied over). B8: forced every time; only a pool that
// already has a 12-version cluster is tested as given.
function wideDist() {
  const out = execFileSync(PYTHON, [join(ROOT, "tests/browser/fixtures/v1_pool.py"), join(GIVEN, "pool.json")], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  const grown = JSON.parse(out.toString("utf8"));
  const had = JSON.parse(readFileSync(join(GIVEN, "pool.json"), "utf-8"));
  if (JSON.stringify(grown.clusters) === JSON.stringify(had.clusters)) return GIVEN;
  const dir = join(tmpdir(), "almanac-v1-wide");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pool.json"), JSON.stringify(grown));
  execFileSync(PYTHON, ["-m", "app.build", "--pool", join(dir, "pool.json"), "--out", join(dir, "dist")], { cwd: ROOT, stdio: "ignore" });
  if (existsSync(join(GIVEN, "bodies"))) cpSync(join(GIVEN, "bodies"), join(dir, "dist", "bodies"), { recursive: true });
  console.log(`  no 12-version cluster in ${GIVEN}: testing v1_pool.py's pool built from it (${join(dir, "dist")})`);
  return join(dir, "dist");
}
const DIST = wideDist();

// --- The hostile build: one version's headline is markup. ---
const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"Quoted" & </mark><b>bold</b>';
const pool = JSON.parse(readFileSync(join(DIST, "pool.json"), "utf-8"));
const hostileDir = join(tmpdir(), "almanac-v1-hostile");
rmSync(hostileDir, { recursive: true, force: true });
mkdirSync(hostileDir, { recursive: true });
const byId = new Map(pool.articles.map((a) => [a.id, a]));
const target = pool.clusters.filter((c) => c.independent_sources >= 3).sort((a, b) => b.article_ids.length - a.article_ids.length)[0];
const evilId = [...target.article_ids].sort().at(-1);
const hostilePool = structuredClone(pool);
hostilePool.articles.find((a) => a.id === evilId).title = EVIL;
writeFileSync(join(hostileDir, "pool.json"), JSON.stringify(hostilePool));
execFileSync(PYTHON, ["-m", "app.build", "--pool", join(hostileDir, "pool.json"), "--out", join(hostileDir, "dist")], { cwd: ROOT, stdio: "ignore" });

const site = await gatedSite(DIST);
const hostile = await gatedSite(join(hostileDir, "dist"));
const chrome = await launch("v1-check");
const { send, evaluate } = chrome;
const errors = [];
const dialogs = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }); }
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setUserAgentOverride", { userAgent: UA, platform: "Linux armv8l" });
for (const origin of [site.origin, hostile.origin]) {
  await send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: `${origin}/` });
}
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__shifts = []; window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shifts.push({ t: e.startTime, v: e.value, input: e.hadRecentInput,
    who: (e.sources || []).map((s) => s.node ? (s.node.className || s.node.nodeName) : "?").join(",") }); })
    .observe({ type: "layout-shift", buffered: true });` });

const cspAll = [];
async function media(scheme = "dark", reduced = "no-preference") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: reduced }] });
}

/** Loads `/` (or `hash`) with `stored` in localStorage (null clears it). */
async function visit({ scheme = "dark", reduced = "no-preference", stored = null, flag = null, origin = site.origin, hash = "" } = {}) {
  cspAll.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
  await media(scheme, reduced);
  await send("Page.navigate", { url: `${origin}/` });
  await sleep(500);
  await evaluate(`(() => { localStorage.clear();
    ${stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))});` : ""}
    ${flag ? `localStorage.setItem("almanac.dev.wordmarks", ${JSON.stringify(flag)});` : ""} })()`);
  await send("Page.navigate", { url: "about:blank" });
  await sleep(100);
  await send("Page.navigate", { url: `${origin}/${hash}` });
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.readyState === "complete" && document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`).catch(() => false)) break;
    await sleep(100);
  }
  await sleep(500);
}

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

/** A finger tap at (x, y): touch start and end, from which Chrome makes the click. */
async function tap(x, y) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function key(k, code = k, vk = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
/** A finger swipe from x0 to x1 at height y, in small moves a frame apart. */
async function swipe(x0, x1, y = 520) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 8; i++) {
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] });
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const KEYS = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Escape: 27 };
const press = (k) => key(k, k, KEYS[k]);
const shiftSum = () => evaluate("window.__shifts.reduce((s, e) => s + e.v, 0)");
const state = () => evaluate(`({ open: !document.getElementById("bv").hidden, count: document.getElementById("bv-count").textContent, hash: location.hash,
  chips: document.querySelectorAll(".bv-chip").length, active: [...document.querySelectorAll(".bv-chip")].findIndex((c) => c.getAttribute("aria-selected") === "true"),
  focus: document.activeElement?.id || document.activeElement?.className || "" })`);

/** Scrolls Today so the row of cluster `sid` sits 200dp under the strip; its rects. */
// The row's "N sources" trigger is scrolled to the middle of the feed, so a tap never
// lands on the tab bar: the hero's trigger sits under its photo, near the bottom of the
// first screen (B8: the 12-version story is often the hero).
async function toRow(sid) {
  await evaluate(`(() => { const p = document.getElementById("section-today"); const li = p.querySelector('li.story[data-sid="${sid}"]');
    const fold = li.closest("details"); if (fold) fold.open = true;
    const c = li.querySelector(".meta-count").getBoundingClientRect(); const box = p.getBoundingClientRect();
    p.scrollTop = Math.max(0, p.scrollTop + c.top - box.top - p.clientHeight / 2); })()`);
  await sleep(350);
  return evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${sid}"]');
    const r = (n) => { const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, top: b.top, w: b.width, h: b.height }; };
    return { count: r(li.querySelector(".meta-count")), headline: r(li.querySelector(".headline")), name: r(li.querySelector(".meta-source")),
      scroll: document.getElementById("section-today").scrollTop }; })()`);
}

async function openRow(sid) {
  const at = await toRow(sid);
  await tap(at.count.x, at.count.y);
  await sleep(450);
  return at;
}

async function back() {
  await evaluate("history.back()");
  await sleep(450);
}

// 1. Behind the gate: the worker installs and controls; nothing goes uncredentialed.
await visit();
await sleep(1500);
await send("Page.reload", { ignoreCache: false });
await sleep(1500);
const controlled = await evaluate("!!navigator.serviceWorker.controller");
check(controlled, "behind the Access gate the service worker controls the page");
const survey = await evaluate(`(async () => {
  const src = document.querySelector('script[src*="js/versions-view.js"]').getAttribute("src");
  const v = src.split("?")[1] || "";
  const m = await import("./js/versions.js" + (v ? "?" + v : ""));
  const data = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ctx = m.versionsContext(data);
  const sids = [...new Set([...document.querySelectorAll("#section-today .story-coverage")].map((b) => b.dataset.sid))];
  const counts = sids.map((sid) => { const c = ctx.clusters.get(sid); return { sid, n: m.buildVersions(c, ctx, { leadId: c.lead, nowMs: Date.now() }).length,
    shown: Number(document.querySelector('#section-today li.story[data-sid="' + sid + '"] .meta-count').textContent.split(" ")[0]) }; });
  const slides = sids.map((sid) => { const c = ctx.clusters.get(sid); return { sid, s: m.buildVersions(c, ctx, { leadId: c.lead, nowMs: Date.now() }) }; });
  return { rows: sids.length, counts, stamped: v,
    also: slides.find((x) => x.s.some((s) => s.also.length))?.sid || null,
    more: slides.find((x) => x.s.some((s) => s.more.length))?.sid || null,
    read: slides.map((x) => ({ sid: x.sid, i: x.s.findIndex((s, i) => i > 0 && s.hasBody) })).find((x) => x.i > 0) || null,
    marks: slides.filter((x) => x.s.length >= 3 && x.s.length <= 6).map((x) => { const u = m.uniqueWords(x.s.map((s) => s.headline));
      return { sid: x.sid, n: x.s.length, lead: x.s[0].sourceId, mark2: u[1] ? u[1].size : 0 }; }).sort((a, b) => b.mark2 - a.mark2)[0] || null };
})()`);
const counts = survey.counts.map((c) => c.n).sort((a, b) => b - a);
const hist = {};
for (const n of counts) hist[n] = (hist[n] || 0) + 1;
console.log(`  rows on Today that open a carousel: ${survey.rows}; versions per carousel ${JSON.stringify(hist)}; largest ${counts[0]}`);
const agree = survey.counts.filter((c) => c.n === c.shown).length;
console.log(`  carousel count equals the row's "N sources" on ${agree} of ${survey.rows} rows`);
check(survey.rows > 0 && counts[0] >= 11, `today's rows open carousels (${survey.rows}), one with 11 or more versions (${counts[0]})`);
const pageLog = site.log.slice();
const mods = ["/js/versions-view.js", "/js/versions.js", "/js/history/compared.js"].map((p) => pageLog.some((r) => r.path === p && r.cookie));
check(mods.every(Boolean), "the carousel's modules were fetched with the Access cookie");

// 2. The row tap, open, swipe, close: CLS 0, the same scroll, focus back.
const big = survey.counts.filter((c) => c.n >= 3 && c.n <= 8).sort((a, b) => b.n - a.n)[0];
await visit();
let at = await toRow(big.sid);
const hits = await evaluate(`(() => { const a = ${JSON.stringify(at)}; const on = (x, y) => document.elementFromPoint(x, y);
  return { count: on(a.count.x, a.count.y)?.className, headline: on(a.headline.x, a.headline.y)?.closest("a")?.className || "",
    name: on(a.name.left + 4, a.name.y)?.className }; })()`);
check(hits.count === "story-coverage", `a tap on "N sources" reaches the carousel trigger (${hits.count})`);
check(hits.headline === "story-link", `a tap on the headline beside it still opens the story (${hits.headline})`);
console.log(`  a tap on the source name's first letters reaches: ${hits.name}`);
await shot("v1-row-dark.png");
const before = await shiftSum();
const scrollBefore = at.scroll;
await tap(at.count.x, at.count.y);
await sleep(450);
let s = await state();
check(s.open && s.hash === `#bundle-${big.sid}` && s.count === `1 of ${big.n}` && s.chips === big.n && s.active === 0 && s.focus === "bv-close",
  `the tap opens the carousel for its row: ${s.hash}, "${s.count}", ${s.chips} chips, focus on close`);
const openShift = (await shiftSum()) - before;
const lead = await evaluate(`(() => { const d = JSON.parse(document.getElementById("rank-input").content.textContent);
  const c = d.pool.clusters.find((x) => x.id === ${JSON.stringify(big.sid)}); const a = d.pool.articles.find((x) => x.id === c.lead);
  return { title: a.title, source: d.names[a.source_id] }; })()`);
const first = await evaluate(`({ headline: document.querySelector("#bv-slide-0 .bv-headline").textContent, outlet: document.querySelector("#bv-slide-0 .bv-outlet-name").textContent })`);
check(first.outlet === lead.source && first.headline === smartQuotes(lead.title), `the lead version comes first: ${first.outlet}`);
const aria = await evaluate(`(() => { const t = document.getElementById("bv-track"); const slides = [...t.children];
  return { region: t.getAttribute("role") === "region" && t.getAttribute("aria-roledescription") === "carousel",
    slides: slides.every((x) => x.getAttribute("aria-roledescription") === "slide" && x.getAttribute("role") === "tabpanel" && /^\\d+ of \\d+: /.test(x.getAttribute("aria-label"))),
    tabs: document.getElementById("bv-strip").getAttribute("role") === "tablist" && [...document.querySelectorAll(".bv-chip")].every((c, i) => c.getAttribute("role") === "tab" && c.getAttribute("aria-controls") === "bv-slide-" + i),
    dialog: document.getElementById("bv").getAttribute("role") === "dialog" && document.getElementById("bv").getAttribute("aria-modal") === "true",
    inert: slides.slice(1).every((x) => x.inert) && !slides[0].inert }; })()`);
check(Object.values(aria).every(Boolean), `aria: dialog, region "carousel", tabpanels "slide", tablist of chips, off-screen slides inert (${JSON.stringify(aria)})`);
const swipeFrom = (await shiftSum());
await swipe(300, 60);
await sleep(900);
s = await state();
check(s.count === `2 of ${big.n}` && s.active === 1, `a touch swipe moves to the next version: "${s.count}"`);
const swipeShift = (await shiftSum()) - swipeFrom;
await sleep(300);
const compared = await evaluate(`({ compared: JSON.parse(localStorage.getItem("almanac.history.compared.v1") || "{}"),
  seen: JSON.parse(localStorage.getItem("almanac.history.summary.v1") || "{}") })`);
check(compared.compared[big.sid]?.ids?.length === 1 && Object.keys(compared.seen.opened || {}).includes(big.sid)
  && !compared.compared[big.sid].ids.some((id) => Object.keys(compared.seen.opened || {}).includes(id)),
  "opening records opened for the lead's story; the second version records compared only");
await shot("v1-swiped-dark.png");
const closeFrom = await shiftSum();
await back();
s = await state();
const scrollAfter = await evaluate(`document.getElementById("section-today").scrollTop`);
const focusAfter = await evaluate(`document.activeElement?.className || ""`);
const closeShift = (await shiftSum()) - closeFrom;
check(!s.open && s.hash === "" && scrollAfter === scrollBefore && focusAfter === "story-coverage",
  `back closes it: the feed at the same scroll (${scrollBefore} -> ${scrollAfter}), focus on the trigger`);
check(openShift === 0 && swipeShift === 0 && closeShift === 0, `CLS open ${openShift}, swipe ${swipeShift}, close ${closeShift} (every shift counted)`);

// 3. Keys: arrows, Home and End on the chips; Escape closes.
await openRow(big.sid);
await evaluate(`document.getElementById("bv-tab-0").focus()`);
await press("ArrowRight");
await sleep(600);
s = await state();
const k1 = s.active === 1 && s.focus === "bv-tab-1";
await press("End");
await sleep(700);
s = await state();
const k2 = s.active === big.n - 1 && s.focus === `bv-tab-${big.n - 1}`;
await press("Home");
await sleep(700);
s = await state();
const k3 = s.active === 0;
const slideAt = await evaluate(`Math.round(document.getElementById("bv-track").scrollLeft / document.getElementById("bv-track").clientWidth)`);
await press("Escape");
await sleep(450);
s = await state();
check(k1 && k2 && k3 && slideAt === 0 && !s.open, "ArrowRight, End and Home move the slide and the chip focus; Escape closes");

// 4. The 11-or-more-version strip keeps its active chip in view.
const wide = survey.counts.filter((c) => c.n >= 11).sort((a, b) => a.n - b.n)[0];
// R2: a pool with no such cluster already failed above; stop with that failure, not a
// TypeError here. tests/browser/fixtures/v1_pool.py makes one from any real pool.
if (!wide) {
  console.log("  no 11-version cluster: build tests/browser/fixtures/v1_pool.py's pool (see tests/browser/README.md)");
  console.log(`
${failures.length} failed`);
  chrome.close(); site.close(); hostile.close();
  process.exit(1);
}
await openRow(wide.sid);
await evaluate(`document.getElementById("bv-tab-0").focus()`);
const seen = [];
for (let i = 1; i < wide.n; i++) {
  await press("ArrowRight");
  await sleep(i === wide.n - 1 ? 800 : 250);
}
await sleep(300);
for (const i of [wide.n - 1]) {
  seen.push(await evaluate(`(() => { const s = document.getElementById("bv-strip").getBoundingClientRect(); const c = document.getElementById("bv-tab-${i}").getBoundingClientRect();
    return { i: ${i}, inside: c.left >= s.left - 0.5 && c.right <= s.right + 0.5, scrolled: document.getElementById("bv-strip").scrollLeft }; })()`));
}
await shot("v1-strip-wide-dark.png");
await press("Home");
await sleep(800);
seen.push(await evaluate(`(() => { const s = document.getElementById("bv-strip").getBoundingClientRect(); const c = document.getElementById("bv-tab-0").getBoundingClientRect();
  return { i: 0, inside: c.left >= s.left - 0.5 && c.right <= s.right + 0.5, scrolled: document.getElementById("bv-strip").scrollLeft }; })()`));
check(seen.every((x) => x.inside) && seen[0].scrolled > 0, `a ${wide.n}-version strip scrolls its active chip into view (${JSON.stringify(seen)})`);
await back();

// 5. Reduced motion jumps; motion on glides.
async function stepMeasure(reduced) {
  await media("dark", reduced);
  await openRow(big.sid);
  await evaluate(`document.getElementById("bv-tab-0").focus()`);
  await press("ArrowRight");
  const x = await evaluate(`({ left: document.getElementById("bv-track").scrollLeft, width: document.getElementById("bv-track").clientWidth })`);
  await sleep(700);
  await back();
  return x;
}
const glide = await stepMeasure("no-preference");
const jump = await stepMeasure("reduce");
await media("dark");
check(jump.left === jump.width && glide.left < glide.width,
  `reduced motion jumps a whole slide at once (${jump.left} of ${jump.width} straight after the key), motion on glides (${Math.round(glide.left)} of ${glide.width})`);

// 6. Read opens the reader over it; back returns to the same slide.
if (survey.read) {
  await openRow(survey.read.sid);
  await evaluate(`document.getElementById("bv-tab-${survey.read.i}").click()`);
  await sleep(700);
  const r = await evaluate(`(() => { const a = document.querySelector("#bv-slide-${survey.read.i} a.bv-action[data-body]"); a.scrollIntoView({ block: "center" });
    const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, id: a.dataset.body }; })()`);
  await sleep(200);
  await tap(r.x, r.y);
  await sleep(900);
  const inReader = await evaluate(`({ reader: !document.getElementById("reader").hidden, hash: location.hash })`);
  await back();
  s = await state();
  check(inReader.reader && inReader.hash === `#read-${r.id}` && s.open && s.active === survey.read.i && s.hash === `#bundle-${survey.read.sid}`,
    `"Read" opens the reader (${inReader.hash}); back returns to the same slide (${s.count})`);
  await back();
} else {
  console.log("  (no version with full text past the lead in this pool: the Read check skipped)");
}

// 7. The footer opens the coverage sheet; back returns to the carousel.
await openRow(big.sid);
await evaluate(`document.getElementById("bv-all").click()`);
await sleep(600);
const sheet = await evaluate(`({ open: !document.getElementById("sheet-root").hidden, title: document.getElementById("sheet-label").textContent, groups: document.querySelectorAll(".coverage-group").length })`);
await shot("v1-coverage-from-footer-dark.png");
await back();
s = await state();
check(sheet.open && sheet.title === "Coverage" && sheet.groups > 0 && s.open && !(await evaluate(`!document.getElementById("sheet-root").hidden`)),
  `"All versions by lean" opens the coverage sheet (${sheet.groups} lean groups); back returns to the carousel`);
await back();

// 8. The word-mark switch: off hides every mark and moves nothing; it persists.
await openRow(survey.marks.sid);
await evaluate(`document.getElementById("bv-tab-1").click()`);
await sleep(700);
const markFrom = await shiftSum();
const on = await evaluate(`({ n: document.querySelectorAll("#bv-slide-1 .bv-mark").length, line: getComputedStyle(document.querySelector("#bv-slide-1 .bv-mark")).textDecorationLine,
  h: document.querySelector("#bv-slide-1 .bv-headline").getBoundingClientRect().height })`);
await evaluate(`document.getElementById("bv-marks").click()`);
await sleep(700);
const off = await evaluate(`({ pressed: document.getElementById("bv-marks").getAttribute("aria-pressed"), line: getComputedStyle(document.querySelector("#bv-slide-1 .bv-mark")).textDecorationLine,
  key: getComputedStyle(document.getElementById("bv-key")).visibility, h: document.querySelector("#bv-slide-1 .bv-headline").getBoundingClientRect().height,
  saved: (() => { const h = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || "null")?.history; return h ? h[h.length - 1].profile.display?.word_marks : "none"; })() })`);
await shot("v1-marks-off-dark.png");
const markShift = (await shiftSum()) - markFrom;
await back();
await openRow(survey.marks.sid);
const reopened = await evaluate(`document.getElementById("bv-marks").getAttribute("aria-pressed")`);
await evaluate(`document.getElementById("bv-marks").click()`);
await sleep(700);
const savedOn = await evaluate(`(() => { const h = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || "null").history; return h[h.length - 1].profile.display?.word_marks; })()`);
console.log(`  marks: ${JSON.stringify({ on, off, reopened, savedOn, markShift })}`);
check(on.n > 0 && on.line === "underline" && off.pressed === "false" && off.line === "none" && off.key === "hidden" && off.h === on.h
  && off.saved === false && reopened === "false" && savedOn === true && markShift === 0,
  `the switch turns ${on.n} marks off and on with no shift (CLS ${markShift}), saved to the profile (display.word_marks ${off.saved}, then ${savedOn})`);
await back();

// 9. A muted source is neither shown nor counted.
const bigSlides = await evaluate(`(async () => { const src = document.querySelector('script[src*="js/versions-view.js"]').getAttribute("src");
  const m = await import("./js/versions.js?" + (src.split("?")[1] || "")); const d = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ctx = m.versionsContext(d); const c = ctx.clusters.get(${JSON.stringify(big.sid)});
  return m.buildVersions(c, ctx, { leadId: c.lead, nowMs: Date.now() }).map((x) => x.sourceId); })()`);
const mutedSource = bigSlides[1];
const mutedProfile = structuredClone(buildDefaultProfile("2026-09-24T00:00:00Z"));
mutedProfile.mutes.sources = [mutedSource];
await visit({ stored: { history: [{ version: 1, timestamp: "2026-09-24T00:00:00Z", profile: mutedProfile }] } });
await openRow(big.sid);
const muted = await evaluate(`({ chips: [...document.querySelectorAll(".bv-chip")].map((c) => c.textContent), count: document.getElementById("bv-count").textContent,
  names: JSON.parse(document.getElementById("rank-input").content.textContent).names })`);
const mutedName = muted.names[mutedSource];
check(!muted.chips.includes(mutedName) && muted.count === `1 of ${big.n - 1}` && !(await evaluate(`document.getElementById("bv").textContent.includes(${JSON.stringify(mutedName)})`)),
  `with ${mutedName} muted it is not shown anywhere in the carousel and not counted ("${muted.count}")`);
await back();

// 10. A #bundle- address opens straight into the carousel.
await visit({ hash: `#bundle-${big.sid}` });
s = await state();
check(s.open && s.count === `1 of ${big.n}`, `a #bundle- address opens the carousel (${s.count})`);

// 11. The hostile build: the headline is text, nothing runs.
await visit({ origin: hostile.origin });
const hostileSlide = await evaluate(`(async () => { const src = document.querySelector('script[src*="js/versions-view.js"]').getAttribute("src");
  const m = await import("./js/versions.js?" + (src.split("?")[1] || "")); const d = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ctx = m.versionsContext(d); const c = ctx.clusters.get(${JSON.stringify(target.id)});
  const slides = m.buildVersions(c, ctx, { leadId: c.lead, nowMs: Date.now() });
  return { i: slides.findIndex((x) => x.id === ${JSON.stringify(evilId)} || x.more.some((y) => y.id === ${JSON.stringify(evilId)})), row: !!document.querySelector('#section-today li.story[data-sid="${target.id}"]') }; })()`);
if (hostileSlide.row) await openRow(target.id);
else await evaluate(`location.hash = "#bundle-${target.id}"`);
await sleep(500);
await evaluate(`document.getElementById("bv-tab-${Math.max(0, hostileSlide.i)}").click()`);
await sleep(700);
const evil = await evaluate(`(() => { const layer = document.getElementById("bv"); const slide = document.getElementById("bv-slide-${Math.max(0, hostileSlide.i)}");
  const texts = [...slide.querySelectorAll(".bv-headline, .bv-more-row")].map((n) => n.textContent);
  return { texts, tags: [...layer.querySelectorAll("img, script, b, iframe")].length, marks: [...layer.querySelectorAll("mark")].every((m) => m.className === "bv-mark" && m.children.length === 0),
    pwned: window.__pwned ?? null }; })()`);
await shot("v1-hostile-dark.png");
check(evil.texts.includes(smartQuotes(EVIL)) && evil.tags === 0 && evil.marks && evil.pwned === null && dialogs.length === 0,
  `a hostile headline renders as text only (no img, script or b element; nothing ran)`);
await back();

// 12. The sweep: each treatment dark and light, the chosen one, grayscale.
const sweepSid = survey.marks.sid;
async function sweepShot(name, { flag = null, scheme = "dark", slide = 1 } = {}) {
  await visit({ scheme, flag });
  await openRow(sweepSid);
  if (slide) {
    await evaluate(`document.getElementById("bv-tab-${slide}").click()`);
    await sleep(800);
  }
  await shot(name);
  await back();
}
for (const scheme of ["dark", "light"]) {
  for (const t of SWEEP) {
    await sweepShot(`v1-sweep-${t}-${scheme}.png`, { flag: t, scheme });
    if (t === "swipe") await sweepShot(`v1-sweep-swipe-before-${scheme}.png`, { flag: t, scheme, slide: 0 });
  }
  await sweepShot(`v1-chosen-${scheme}.png`, { scheme });
  await sweepShot(`v1-chosen-lead-${scheme}.png`, { scheme, slide: 0 });
}
await send("Emulation.setEmulatedVisionDeficiency", { type: "achromatopsia" });
await sweepShot("v1-chosen-grayscale.png", { scheme: "dark" });
await send("Emulation.setEmulatedVisionDeficiency", { type: "none" });
for (const scheme of ["dark", "light"]) {
  await visit({ scheme });
  at = await toRow(big.sid);
  await shot(`v1-row-${scheme}.png`);
  if (survey.also || survey.more) {
    const sid = survey.also || survey.more;
    await openRow(sid);
    const i = await evaluate(`[...document.querySelectorAll(".bv-slide")].findIndex((x) => x.querySelector(".bv-also, .bv-more"))`);
    if (i > 0) { await evaluate(`document.getElementById("bv-tab-${i}").click()`); await sleep(800); }
    await shot(`v1-also-more-${scheme}.png`);
    await back();
  }
}

cspAll.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
// The web app manifest is the one request Chrome makes without the cookie (a
// <link rel="manifest"> without crossorigin="use-credentials"), so behind Access it
// meets the login redirect, which CSP's manifest-src then blocks. That predates V1 and
// is outside the carousel; it is reported, not counted here.
const MANIFEST = "/manifest.webmanifest";
const all = [...site.log, ...hostile.log];
const bare = all.filter((r) => !r.cookie && r.path !== MANIFEST);
const manifestMisses = all.filter((r) => !r.cookie && r.path === MANIFEST).length;
check(bare.length === 0, `every other request carried the Access cookie (${all.length} requests, ${bare.length} without: ${bare.slice(0, 3).map((r) => r.path).join(" ")})`);
const cspOwn = cspAll.filter((v) => !v.startsWith("manifest-src"));
console.log(`  outside V1: ${manifestMisses} manifest fetches went without the cookie and met the gate; ${cspAll.length - cspOwn.length} manifest-src CSP reports followed`);
check(cspOwn.length === 0, `CSP violations across every load, the manifest aside: ${cspOwn.length} ${cspOwn.slice(0, 3).join(" | ")}`);
check(errors.length === 0, `page errors ${errors.length} ${errors.slice(0, 2).join(" | ")}`);
chrome.close();
site.close();
hostile.close();
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
