// H1 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/sw_pretty_urls.mjs [<git ref of the broken S18 worker>]
// The live site went blank after the first visit: the S18 worker precached
// "/index.html", "/profile.html" and "/health.html", Cloudflare Pages answers those with
// a 308 to "/", "/profile" and "/health", and Chrome refuses a redirected response for a
// navigation (net::ERR_FAILED). S18's own proof missed it because its server served the
// .html files as is. This one serves the build through cdp.mjs, which now answers the
// way Pages does (308 from /x.html to /x, /x served from x.html), with the build's own
// _headers, and runs two headless-Chrome sessions at 360x780, DPR 3, dark:
//   A. the fixed build, fresh profile: first load, reload under SW control, /profile,
//      /health, then offline reloads of all three. Every one renders with content,
//      nothing in the shell cache is redirected, the offline line shows at CLS 0, and
//      there are zero CSP violations;
//   B. an upgrade: the broken S18 build (default ref 1de9f5b, the last main before H1)
//      is served first and shown to blank on the second launch; then the fixed build
//      is deployed at the same URL and Chrome is closed and relaunched on the same
//      profile, with no site data cleared. The fixed worker must take over and the page
//      render, counting the launches it takes.
// Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const BROKEN_REF = process.argv[2] || "1de9f5b";
const PY = process.env.PYTHON || "C:/Users/SaurabhMalani/dev/news-app/.venv/Scripts/python.exe";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POOL = join(ROOT, "tests", "fixtures", "golden_pool.json");
const TMP = join(ROOT, "tests", ".tmp-h1");

function build(srcRoot, dist) {
  rmSync(dist, { recursive: true, force: true });
  execFileSync(PY, ["-m", "app.build", "--pool", POOL, "--out", dist], { cwd: srcRoot, stdio: "ignore" });
}

/** The S18 app as it shipped, built from git: the broken worker and its .html links. */
function buildBroken(dist) {
  const src = join(TMP, "broken-src");
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  const tar = join(TMP, "broken.tar");
  execFileSync("git", ["-C", ROOT, "archive", "-o", tar, BROKEN_REF, "app", "package.json", "topics.json", "sources.json"]);
  execFileSync("tar", ["-xf", "../broken.tar"], { cwd: src }); // relative: GNU tar reads "C:" as a host
  build(src, dist);
}

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

const probe = `
  window.__csp = [];
  window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
`;

// What "rendered with content" means for each page: its own origin (not Chrome's error
// page), and the page's own content on screen.
const CONTENT = {
  "/": "document.querySelectorAll('.headline').length",
  "/profile": "document.querySelectorAll('.setting-row').length",
  "/health": "document.querySelectorAll('.health-source-row').length",
};

async function open(chrome, origin, path) {
  const { send } = chrome;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: probe });
  return go(chrome, origin, path);
}

async function go(chrome, origin, path) {
  const nav = await chrome.send("Page.navigate", { url: origin + path });
  await sleep(900);
  return state(chrome, origin, path, nav.result?.errorText || "");
}

async function state(chrome, origin, path, errorText = "") {
  const key = path.replace(/[?#].*$/, "").replace(/\.html$/, "").replace(/^\/index$/, "/");
  const s = JSON.parse(await chrome.evaluate(`JSON.stringify({
    href: location.href,
    sameOrigin: location.origin === ${JSON.stringify(origin)},
    content: location.origin === ${JSON.stringify(origin)} ? (${CONTENT[key] || "0"}) : 0,
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    textLength: document.body ? document.body.innerText.length : 0,
    offline: document.documentElement.classList.contains("is-offline"),
    line: (document.getElementById("offline-line") || {}).textContent || "",
    lineHidden: (document.getElementById("offline-line") || {}).hidden,
    cls: window.__cls,
    csp: window.__csp || [],
  })`));
  return { path, errorText, ...s, rendered: !errorText && s.sameOrigin && s.content > 0 };
}

const shellEntries = (chrome) => chrome.evaluate(`(async () => {
  const out = [];
  if (typeof caches === "undefined") return out; // Chrome's own error page, not the app
  for (const name of (await caches.keys()).filter((n) => n.startsWith("almanac-shell-"))) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      out.push({ cache: name, url: new URL(req.url).pathname, redirected: res.redirected });
    }
  }
  return out;
})()`);

async function waitForWorker(chrome) {
  await chrome.evaluate("navigator.serviceWorker.ready.then(() => 1)");
  await sleep(300);
}

// ---- A: the fixed build, fresh profile -------------------------------------

async function sessionA() {
  const dist = join(TMP, "fixed-a");
  build(ROOT, dist);
  const text = readFileSync(join(dist, "_headers"), "utf-8");
  const site = await serve(dist, parseHeaders(text), {}, { "/sw.js": parseHeaders(text, "/sw.js") });
  const chrome = await launch("h1-a");
  const consoleErrors = [];
  chrome.on((m) => {
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.exception?.description);
  });

  const first = await open(chrome, site.origin, "/");
  await waitForWorker(chrome);
  const reload = await go(chrome, site.origin, "/");
  const profile = await go(chrome, site.origin, "/profile");
  const health = await go(chrome, site.origin, "/health");
  const oldLink = await go(chrome, site.origin, "/profile.html");
  check("A1_first_load_renders", first.rendered, first);
  check("A2_reload_under_sw_control_renders", reload.rendered && reload.controlled, reload);
  check("A3_profile_renders_under_sw_control", profile.rendered && profile.controlled, profile);
  check("A4_health_renders_under_sw_control", health.rendered && health.controlled, health);
  check("A5_an_old_profile_html_link_lands_on_profile", oldLink.rendered && new URL(oldLink.href).pathname === "/profile", oldLink);

  const entries = await shellEntries(chrome);
  const pages = entries.filter((e) => ["/", "/profile", "/health"].includes(e.url)).map((e) => e.url).sort();
  check("A6_shell_cache_holds_pretty_pages_and_nothing_redirected",
    entries.length > 0 && !entries.some((e) => e.redirected) && !entries.some((e) => e.url.endsWith(".html"))
      && pages.join(",") === "/,/health,/profile",
    { entries: entries.length, redirected: entries.filter((e) => e.redirected).length, pages });

  const sw = await fetch(site.origin + "/sw.js");
  check("A7_sw_js_is_served_no_cache", sw.headers.get("cache-control") === "no-cache", { cacheControl: sw.headers.get("cache-control") });

  await chrome.send("Network.enable");
  await chrome.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offHome = await go(chrome, site.origin, "/");
  await chrome.send("Page.reload", {});
  await sleep(900);
  const offReload = await state(chrome, site.origin, "/");
  const offProfile = await go(chrome, site.origin, "/profile");
  const offHealth = await go(chrome, site.origin, "/health");
  const linePattern = /^Offline\. Showing news from \d+(?: min|[hd]) ago$/;
  check("A8_offline_home_renders_with_the_offline_line_at_cls_zero",
    offHome.rendered && offReload.rendered && offReload.offline && offReload.lineHidden === false
      && linePattern.test(offReload.line) && offReload.cls === 0, offReload);
  check("A9_offline_profile_and_health_render", offProfile.rendered && offHealth.rendered, { offProfile, offHealth });
  const csp = [first, reload, profile, health, offReload, offProfile, offHealth].flatMap((s) => s.csp);
  check("A10_zero_csp_violations_and_exceptions", csp.length === 0 && consoleErrors.length === 0, { csp, consoleErrors });

  chrome.close();
  site.close();
}

// ---- B: a phone stuck on the broken S18 worker upgrades to the fixed one -------

async function sessionB() {
  const site_dir = join(TMP, "site-b");
  buildBroken(site_dir);
  const brokenHeaders = readFileSync(join(site_dir, "_headers"), "utf-8");
  // One server for the whole session (one origin: Cache Storage and the registration
  // belong to it). Its header objects are held by reference, so a redeploy below swaps
  // them in place. The broken deploy's _headers has no /sw.js rule.
  const allHeaders = parseHeaders(brokenHeaders);
  const pathHeaders = {};
  const site = await serve(site_dir, allHeaders, {}, pathHeaders);

  let chrome = await launch("h1-b");
  const profileDir = chrome.userDataDir;
  const first = await open(chrome, site.origin, "/");
  await waitForWorker(chrome);
  const brokenEntries = await shellEntries(chrome);
  const second = await go(chrome, site.origin, "/");
  check("B1_broken_worker_reproduced_first_visit_ok_second_blank",
    first.rendered && !second.rendered && brokenEntries.some((e) => e.redirected),
    { first: first.rendered, second: { errorText: second.errorText, href: second.href }, redirectedEntries: brokenEntries.filter((e) => e.redirected).map((e) => e.url) });
  chrome.close();
  await sleep(800);

  // Deploy the fix at the same URL, in place, as Pages does. The server reads files per
  // request, and the headers now include the fixed build's /sw.js rule.
  const fixed = join(TMP, "fixed-b");
  build(ROOT, fixed);
  rmSync(site_dir, { recursive: true, force: true });
  cpSync(fixed, site_dir, { recursive: true });
  const fixedHeaders = readFileSync(join(site_dir, "_headers"), "utf-8");
  for (const k of Object.keys(allHeaders)) delete allHeaders[k];
  Object.assign(allHeaders, parseHeaders(fixedHeaders));
  pathHeaders["/sw.js"] = parseHeaders(fixedHeaders, "/sw.js");
  const same = site;

  const launches = [];
  let healed = false;
  for (let i = 1; i <= 3 && !healed; i++) {
    chrome = await launch("h1-b", { userDataDir: profileDir });
    const s = await open(chrome, same.origin, "/");
    let after = s;
    if (!s.rendered) {
      await sleep(2500); // let an update check that the failed launch kicked off finish
    } else {
      await sleep(600);
      after = await state(chrome, same.origin, "/");
    }
    const entries = await shellEntries(chrome);
    launches.push({ launch: i, rendered: s.rendered, errorText: s.errorText, controlled: after.controlled,
      caches: [...new Set(entries.map((e) => e.cache))], redirected: entries.filter((e) => e.redirected).length });
    if (s.rendered) {
      const profile = await go(chrome, same.origin, "/profile");
      const health = await go(chrome, same.origin, "/health");
      await chrome.send("Network.enable");
      await chrome.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      const off = await go(chrome, same.origin, "/");
      healed = profile.rendered && health.rendered && off.rendered;
      launches[launches.length - 1].after = { profile: profile.rendered, health: health.rendered, offline: off.rendered, controlled: off.controlled };
    }
    chrome.close();
    await sleep(800);
  }
  const last = launches[launches.length - 1];
  check("B2_fixed_deploy_heals_the_stuck_profile_without_clearing_data",
    healed && last.caches.length === 1 && last.redirected === 0, { launchesNeeded: launches.findIndex((l) => l.rendered) + 1, launches });
  same.close();
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
try {
  await sessionA();
  await sessionB();
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 1));
process.exit(ok ? 0 : 1);
