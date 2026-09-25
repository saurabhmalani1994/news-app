// S18 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/pwa_cls.mjs [<screenshot dir>]
// Builds the page, serves it with the build's own dist/_headers the way Cloudflare
// Pages does (cdp.mjs), and runs two independent headless-Chrome sessions at 360x780
// CSS px, DPR 3, dark scheme (independent so neither's navigation history or network
// state can affect the other):
//   A. installs the service worker, reloads so it controls the page, goes offline
//      (DevTools network emulation, the documented way to test a service worker's
//      offline behavior) and reloads again: the page still loads, entirely from cache,
//      with the offline line and CLS 0, and zero CSP violations throughout;
//   B. installs the service worker for one build, then redeploys twice in a row at the
//      same URL, relaunching after each: the shell cache count never grows past 2 (the
//      current build and the one right before it, kept for a page of that build still
//      open, sw_template.js's own documented activate policy), and a build two
//      redeploys back is the one that finally goes.
// Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";

const [shotsArg] = process.argv.slice(2);

const PY = PYTHON; // PYTHON env, else the repo .venv (tests/browser/python.mjs)
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POOL = join(ROOT, "tests", "fixtures", "golden_pool.json");

function runBuild(poolPath, dist) {
  execFileSync(PY, ["-m", "app.build", "--pool", poolPath, "--out", dist], { cwd: ROOT, stdio: "inherit" });
}

function cspAndClsScript() {
  return `
  window.__csp = [];
  window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
`;
}

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// ---- A: install, control, offline load, CLS, CSP -------------------------

async function sessionA() {
  const dist = join(ROOT, "tests", ".tmp-pwa-cls-a");
  runBuild(POOL, dist);
  const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
  const site = await serve(dist, headers);
  const chrome = await launch("s18-pwa-a");
  const { send, evaluate, on } = chrome;
  const csp = [];
  on((m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") csp.push("console: " + m.params.args.map((a) => a.value).join(" "));
    if (m.method === "Runtime.exceptionThrown") csp.push("exception: " + m.params.exceptionDetails.exception?.description);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: cspAndClsScript() });

  await send("Page.navigate", { url: `${site.origin}/index.html` });
  await sleep(500);
  await evaluate("navigator.serviceWorker.ready.then(() => 1)");
  await send("Page.reload", {});
  await sleep(700);
  const controlled = await evaluate("!!navigator.serviceWorker.controller");
  const shellCache = await evaluate('caches.keys().then((k) => k.filter((n) => n.startsWith("almanac-shell-")))');
  check("sw_installs_and_controls_the_page", controlled && shellCache.length === 1, { controlled, shellCache });

  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send("Page.reload", {});
  await sleep(800);
  const offlineState = JSON.parse(await evaluate(`JSON.stringify({
    ready: document.readyState,
    isOffline: document.documentElement.classList.contains("is-offline"),
    lineHidden: document.getElementById("offline-line")?.hidden,
    lineText: document.getElementById("offline-line")?.textContent || "",
    cls: window.__cls,
    csp: window.__csp,
  })`));
  if (shotsArg) {
    mkdirSync(shotsArg, { recursive: true });
    const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
    writeFileSync(join(shotsArg, "offline-dark.png"), Buffer.from(png, "base64"));
  }
  const linePattern = /^Offline\. Showing news from \d+(?: min|[hd]) ago$/;
  check("offline_load_shows_the_line_at_cls_zero", offlineState.ready === "complete" && offlineState.isOffline
    && offlineState.lineHidden === false && linePattern.test(offlineState.lineText) && offlineState.cls === 0,
    offlineState);
  check("zero_csp_violations", (offlineState.csp || []).length === 0 && csp.length === 0, { pageCsp: offlineState.csp, consoleErrors: csp });

  chrome.close();
  site.close();
  rmSync(dist, { recursive: true, force: true });
}

// ---- B: a redeploy at the same URL replaces the shell cache --------------

async function sessionB() {
  const dist = join(ROOT, "tests", ".tmp-pwa-cls-b");
  runBuild(POOL, dist);
  const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
  const site = await serve(dist, headers);
  const chrome = await launch("s18-pwa-b");
  const { send, evaluate } = chrome;
  await send("Page.enable");

  async function go(path) {
    await send("Page.navigate", { url: `${site.origin}/${path}` });
    await sleep(500);
  }

  await go("index.html");
  await sleep(500);
  await evaluate("navigator.serviceWorker.ready.then(() => 1)");
  await go("index.html");
  await sleep(500);
  const shellCacheV1 = await evaluate('caches.keys().then((k) => k.filter((n) => n.startsWith("almanac-shell-")))');

  // A second, slightly different pool at the same URL: a redeploy. Production relies
  // on the standard no-skipWaiting lifecycle (sessionA's "reload takes control" step
  // is that same mechanic on a fresh install): a waiting v2 activates, and its own
  // activate handler deletes v1's cache, the moment v1 controls zero clients. Headless
  // Chrome under CDP reusing one target across many same-origin navigations did not
  // reliably reach that zero-client moment inside this run's time budget (about:blank
  // interstitials, several seconds each attempt: v2 kept installing and sitting
  // waiting; v1 stayed active). registration.unregister() forces the same real
  // activate handler to run right away instead: with no incumbent registration left
  // for the scope, the next register() installs and activates immediately (the
  // ordinary first-install path, which sessionA already proves does not need
  // skipWaiting either), and its activate handler runs its normal cleanup pass over
  // whatever "almanac-shell-*" caches already exist. Cache Storage does not belong to
  // a registration, so v1's cache is still there for it to find and delete: this
  // exercises the exact cleanup code a real redeploy runs, just not gated behind the
  // platform's own client-counting, which is not app code.
  // H4 item 5: the assertion used to read "exactly 1 cache left", but that never
  // matches sw_template.js's own documented activate handler (its H2 comment: "Activate
  // keeps the one previous build's cache next to this one, so a page from that build
  // still open when this worker takes over keeps getting its own files; every older
  // cache is deleted"). One redeploy correctly leaves 2 (v1 kept as the previous build,
  // v2 current); a stale test, not a product bug. Reworked to check the real invariant:
  // the count never grows past 2, and a build two generations back is the one that
  // finally goes, checked across two redeploys in a row so the bound holds more than
  // once.
  async function redeploy(generatedAt, n) {
    const pool = JSON.parse(readFileSync(POOL, "utf-8"));
    pool.generated_at = generatedAt;
    const poolPath = join(ROOT, "tests", `.tmp-pwa-cls-pool${n}.json`);
    writeFileSync(poolPath, JSON.stringify(pool));
    runBuild(poolPath, dist);
    rmSync(poolPath);
    await evaluate('navigator.serviceWorker.getRegistration().then((r) => r && r.unregister())');
    await go("index.html");
    await sleep(1500);
    return evaluate('caches.keys().then((k) => k.filter((n) => n.startsWith("almanac-shell-")))');
  }

  const afterFirstRedeploy = await redeploy("2026-09-24T05:30:00Z", 2);
  check("a_redeploy_keeps_the_current_build_and_the_one_before_it", afterFirstRedeploy.length === 2
    && afterFirstRedeploy.includes(shellCacheV1[0]) && !afterFirstRedeploy.some((k) => k === shellCacheV1[0] && afterFirstRedeploy.length > 2),
    { before: shellCacheV1, after: afterFirstRedeploy });

  const afterSecondRedeploy = await redeploy("2026-09-24T06:15:00Z", 3);
  check("a_second_redeploy_finally_drops_the_build_two_generations_back", afterSecondRedeploy.length === 2
    && !afterSecondRedeploy.includes(shellCacheV1[0]) && afterSecondRedeploy.some((k) => afterFirstRedeploy.includes(k)),
    { afterFirst: afterFirstRedeploy, afterSecond: afterSecondRedeploy, oldestGone: !afterSecondRedeploy.includes(shellCacheV1[0]) });

  chrome.close();
  site.close();
  rmSync(dist, { recursive: true, force: true });
}

await sessionA();
await sessionB();

console.log(JSON.stringify(results, null, 1));
process.exit(ok ? 0 : 1);
