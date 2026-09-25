// H3 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/h3_photos_check.mjs --pool <pool.json> [--new <git ref>] [--real-photos]
// The owner's phone (installed PWA, behind Cloudflare Access) showed every story photo
// as an empty placeholder, hours after H2 stopped the worker fetching photos. Chrome
// fetches a module service worker's script with credentials "omit", so behind Access
// (a cookie) the worker's every install and update met a login redirect and failed, and
// the phone kept the worker it had before Access: one that fetched every photo itself
// under connect-src 'self' and had each refused. This serves builds the way Cloudflare
// Pages does (the build's own _headers, pretty URLs) behind an Access-like gate (no
// CF_Authorization cookie, a 302 to a login origin), to headless Chrome as a Galaxy S23
// (Android Chrome user agent, 360x780, DPR 3, dark):
//   A. the phone: OLD_REF's worker installed before Access, then Access on and the
//      build under test deployed over it. On the first launch the build's own worker
//      must control the page, its script request must carry the Access cookie, and
//      every Today and Asia photo must load (naturalWidth > 0); again on the next.
//   B. a fresh install behind Access: the worker installs and controls, photos load.
//   C. no Access, upgrade from H2's module worker: the new worker takes over, photos load.
// Photo responses are stubbed with a small PNG through the DevTools Fetch domain unless
// --real-photos, so the proof does not depend on 60 outside hosts. --new <ref> builds the
// build under test from git instead of the working tree (the unfixed main fails A and B).
// A pool with photos and Asia stories is needed: python -m fetcher.fanout --out <p>.
// Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const OLD_REF = "4810f5f"; // main before U1: a module worker that fetched every photo itself
const H2_REF = "3d73adb"; // H2: a module worker that leaves photos alone
const NEW_REF = arg("--new");
const POOL = arg("--pool") && resolve(arg("--pool"));
const REAL = process.argv.includes("--real-photos");
const PY = PYTHON; // PYTHON env, else the repo .venv (tests/browser/python.mjs)
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(tmpdir(), "almanac-h3-check");
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPj/n4GBgYGJgYGBAQAh8gMBQ+Jd9gAAAABJRU5ErkJggg==";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
if (!POOL || !existsSync(POOL)) { console.error("usage: --pool <pool.json with photos>"); process.exit(2); }

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

/** A git ref's app (or the working tree's, ref null) built from POOL. */
function build(ref) {
  const name = ref ? ref.replace(/\W/g, "") : "tree";
  const src = join(TMP, `src-${name}`);
  const dist = join(TMP, `dist-${name}`);
  rmSync(src, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  const parts = ["app", "package.json", "topics.json", "sources.json"];
  if (ref) {
    execFileSync("git", ["-C", ROOT, "archive", "-o", join(TMP, "src.tar"), ref, ...parts]);
    execFileSync("tar", ["-xf", "../src.tar"], { cwd: src });
  } else {
    for (const p of parts) cpSync(join(ROOT, p), join(src, p), { recursive: true });
  }
  execFileSync(PY, ["-m", "app.build", "--pool", POOL, "--out", dist], { cwd: src, stdio: "ignore" });
  return dist;
}

/** One origin; deploy() swaps the served build in place; gate() turns "Access" on. */
async function site(dist) {
  let root, headers, swHeaders, gated = false;
  const log = [];
  const deploy = (dir) => {
    root = resolve(dir);
    const text = readFileSync(join(root, "_headers"), "utf-8");
    headers = parseHeaders(text);
    swHeaders = parseHeaders(text, "/sw.js");
  };
  deploy(dist);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const cookie = /(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "");
    log.push({ path: pathname, cookie });
    if (gated && !cookie) {
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
  return { origin: `http://127.0.0.1:${server.address().port}`, deploy, log, gate: () => { gated = true; }, close: () => server.close() };
}

async function phone(name) {
  const chrome = await launch(name);
  const { send } = chrome;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setUserAgentOverride", { userAgent: UA, platform: "Linux armv8l" });
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  if (!REAL) {
    await send("Fetch.enable", { patterns: [{ urlPattern: "https://*", resourceType: "Image", requestStage: "Request" }] });
    chrome.on((m) => {
      if (m.method !== "Fetch.requestPaused") return;
      send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/png" }], body: PNG });
    });
  }
  return chrome;
}

async function waitFor(chrome, expr, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    try { if (await chrome.evaluate(expr)) return true; } catch {}
  }
  return false;
}

/** One launch: open the app, then every photo on Today and Asia brought into view. */
async function launchApp(chrome, origin) {
  await chrome.send("Page.navigate", { url: `${origin}/` });
  await waitFor(chrome, `document.readyState === "complete" && document.documentElement.dataset.sections === "ready"`, 15000);
  await waitFor(chrome, `navigator.serviceWorker.controller !== null`, 10000);
  const out = { build: await chrome.evaluate(`document.querySelector('meta[name="almanac-build"]')?.content || ""`) };
  for (const section of ["today", "asia"]) {
    if (section !== "today") await chrome.evaluate(`document.getElementById("tab-${section}").click()`);
    const sel = `#section-${section} img.story-img`;
    const n = await chrome.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    for (let i = 0; i < n; i++) {
      await chrome.evaluate(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].scrollIntoView({ block: "center" })`);
      await sleep(REAL ? 300 : 80);
    }
    await waitFor(chrome, `[...document.querySelectorAll(${JSON.stringify(sel)})].every((i) => i.complete)`, REAL ? 20000 : 8000);
    out[section] = await chrome.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((i) => ({ host: new URL(i.src).host, w: i.naturalWidth }))`);
  }
  // This build's worker is in control: it finished its install (H2's stamp, the last
  // thing its precache writes, is in this build's cache), nothing newer is waiting, and
  // the page is controlled (install skips waiting and claims open pages).
  out.controller = await chrome.evaluate(`(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active || reg.waiting || reg.installing || !navigator.serviceWorker.controller) return false;
    const cache = await caches.open("almanac-shell-" + ${JSON.stringify(out.build)});
    return Boolean(await cache.match("/__sw-installed__"));
  })()`);
  const photos = [...out.today, ...out.asia];
  out.loaded = photos.filter((p) => p.w > 0).length;
  out.total = photos.length;
  // A reader's pause before the next launch: Chrome runs the navigation's own update
  // check for a worker only once its fetch events have been quiet for a moment.
  await sleep(2500);
  return out;
}

const brief = (l) => ({ build: l.build, ownWorker: l.controller, loaded: `${l.loaded}/${l.total}` });
const allLoaded = (l) => l.total >= 10 && l.loaded === l.total;

mkdirSync(TMP, { recursive: true });
const fresh = build(NEW_REF);
const old = build(OLD_REF);
const h2 = build(H2_REF);

// A. the phone: a pre-Access worker, then Access, then this deploy.
{
  const s = await site(old);
  const chrome = await phone("h3-a");
  await launchApp(chrome, s.origin);
  const before = await launchApp(chrome, s.origin); // the old worker in control: photos refused
  s.gate();
  await chrome.send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: `${s.origin}/`, httpOnly: true, sameSite: "Lax" });
  s.deploy(fresh);
  s.log.length = 0;
  const first = await launchApp(chrome, s.origin);
  const swRequests = s.log.filter((r) => r.path === "/sw.js");
  const second = await launchApp(chrome, s.origin);
  check("A1_the_old_worker_refuses_photos_before_the_deploy", before.loaded === 0 && before.total > 0, brief(before));
  check("A2_behind_access_the_worker_script_request_carries_the_cookie", swRequests.length > 0 && swRequests.every((r) => r.cookie), { swRequests });
  check("A3_first_launch_after_the_deploy_its_own_worker_and_every_photo", first.controller && allLoaded(first), brief(first));
  check("A4_next_launch_every_photo", second.controller && allLoaded(second), brief(second));
  chrome.close();
  s.close();
}

// B. a fresh install behind Access.
{
  const s = await site(fresh);
  s.gate();
  const chrome = await phone("h3-b");
  await chrome.send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: `${s.origin}/`, httpOnly: true, sameSite: "Lax" });
  const first = await launchApp(chrome, s.origin);
  const second = await launchApp(chrome, s.origin);
  check("B1_fresh_install_behind_access_the_worker_installs_and_controls", second.controller, brief(second));
  check("B2_fresh_install_behind_access_every_photo", allLoaded(first) && allLoaded(second), { first: brief(first), second: brief(second) });
  chrome.close();
  s.close();
}

// C. no Access: H2's module worker replaced by this build's.
{
  const s = await site(h2);
  const chrome = await phone("h3-c");
  await launchApp(chrome, s.origin);
  await launchApp(chrome, s.origin);
  s.deploy(fresh);
  const first = await launchApp(chrome, s.origin);
  const second = await launchApp(chrome, s.origin);
  check("C1_upgrade_from_the_h2_module_worker_takes_over", second.controller, brief(second));
  check("C2_upgrade_from_the_h2_module_worker_every_photo", allLoaded(first) && allLoaded(second), { first: brief(first), second: brief(second) });
  chrome.close();
  s.close();
}

console.log(JSON.stringify(results, null, 1));
const failed = Object.entries(results).filter(([, r]) => !r.pass).map(([k]) => k);
console.log(`${Object.keys(results).length - failed.length} passed, ${failed.length} failed${failed.length ? ": " + failed.join(", ") : ""}`);
process.exit(ok ? 0 : 1);
