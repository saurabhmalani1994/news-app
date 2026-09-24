// H2 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/h2_you_check.mjs [--new <git ref>] [--shots <dir>]
// The owner's phone showed "Could not load the profile screen: Cannot read properties of
// null (reading 'addEventListener')" on You, and no bottom nav on Saved and Following.
// This serves builds the way Cloudflare Pages does (cdp.mjs: pretty URLs, the build's own
// _headers) to headless Chrome at 360x780, DPR 3, dark, and deploys in place over a
// live service worker, the way the phone met each deploy:
//   A. stale assets across a deploy: the last build before U2 (OLD_REF) is installed and
//      holds a profile saved by older builds; the build under test is deployed at the
//      same URL; then You is opened with the app still open, and again after a relaunch.
//      Every script and stylesheet the page runs must be the page's own build's bytes.
//      Then the reverse: a page from build 1 kept open while build 2's worker takes it
//      over must still get build 1's assets (two builds of the tree under test).
//   B. old stored profiles: S10 (before passes), S13 (before standing_stories), S28
//      (before live_overrides), S33 (before display), each with custom topics, boosts
//      and a version history, plus one with an unknown extra topic. Each opens You
//      without an error, is migrated forward once with every edit and version kept.
//   C. You opened directly, by each deep link, by Back, and offline; every bottom-nav
//      destination (Home, Following, Saved, You) shows the bottom nav and its header.
// --new <ref> builds the build under test from git instead of the working tree, which
// is how the error is first reproduced on the unfixed main. Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { PASS_DEFAULTS } from "../../app/static/js/passes.js";
import { STANDING_DEFAULTS } from "../../app/static/js/standing.js";
import { LIVE_OVERRIDES_DEFAULTS } from "../../app/static/js/live.js";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const OLD_REF = "508ee2f"; // main just before U2 (9286c11^): the build the phone had cached
const NEW_REF = arg("--new");
const SHOTS = arg("--shots");
const ONLY = arg("--only"); // "today" runs session T alone
const PY = process.env.PYTHON || "C:/Users/SaurabhMalani/dev/news-app/.venv/Scripts/python.exe";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POOL = join(ROOT, "tests", "fixtures", "golden_pool.json");
const TMP = join(ROOT, "tests", ".tmp-h2");
const KEY = "almanac.profile.store.v1";

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

// ---- builds ----------------------------------------------------------------

function buildFrom(srcRoot, dist, pool = POOL) {
  rmSync(dist, { recursive: true, force: true });
  execFileSync(PY, ["-m", "app.build", "--pool", pool, "--out", dist], { cwd: srcRoot, stdio: "ignore" });
  return dist;
}

/** A git ref's app, extracted and built; `tweak` edits the source tree first. */
function buildRef(ref, dist, tweak, pool) {
  const src = join(TMP, `src-${ref ? ref.replace(/\W/g, "") : "tree"}-${tweak ? "b" : "a"}`);
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  if (ref) {
    const tar = join(TMP, "src.tar");
    execFileSync("git", ["-C", ROOT, "archive", "-o", tar, ref, "app", "package.json", "topics.json", "sources.json"]);
    execFileSync("tar", ["-xf", "../src.tar"], { cwd: src });
  } else {
    for (const p of ["app", "package.json", "topics.json", "sources.json"]) cpSync(join(ROOT, p), join(src, p), { recursive: true });
  }
  if (tweak) tweak(src);
  return buildFrom(src, dist, pool);
}

// A second build of the same tree: one byte of the You page's script and of the
// stylesheet differ, as the next hourly deploy's would.
const secondBuild = (src) => {
  appendFileSync(join(src, "app", "static", "js", "profile-screen.js"), "\n// build 2\n");
  appendFileSync(join(src, "app", "static", "profile.css"), "\n/* build 2 */\n");
};

/** One origin for a whole session; deploy() swaps the files and headers in place. */
async function site(dist) {
  const dir = join(TMP, `site-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(dist, dir, { recursive: true });
  const all = parseHeaders(readFileSync(join(dir, "_headers"), "utf-8"));
  const paths = { "/sw.js": parseHeaders(readFileSync(join(dir, "_headers"), "utf-8"), "/sw.js") };
  const server = await serve(dir, all, {}, paths);
  return {
    origin: server.origin,
    close: server.close,
    deploy(next, { keepWorker = false } = {}) {
      const oldWorker = keepWorker ? readFileSync(join(dir, "sw.js")) : null;
      rmSync(dir, { recursive: true, force: true });
      cpSync(next, dir, { recursive: true });
      if (oldWorker) writeFileSync(join(dir, "sw.js"), oldWorker);
      const text = readFileSync(join(dir, "_headers"), "utf-8");
      for (const k of Object.keys(all)) delete all[k];
      Object.assign(all, parseHeaders(text));
      paths["/sw.js"] = parseHeaders(text, "/sw.js");
    },
  };
}

// ---- profiles saved by older builds ---------------------------------------------

const clone = (x) => JSON.parse(JSON.stringify(x));
const TOPICS = {
  us_politics: { label: "US Politics", affinity: 0.8, half_life_hours: 8, enabled: true },
  singapore: { label: "Singapore", affinity: 1, half_life_hours: 12, enabled: true },
  ai: { label: "AI", affinity: 0.6, half_life_hours: 48, enabled: true },
  industrial_biotech: { label: "Industrial Biotech", affinity: 0.6, half_life_hours: 48, enabled: true },
  world: { label: "World", affinity: 0.7, half_life_hours: 6, enabled: true },
  must_know: { label: "Must-know", affinity: 0, half_life_hours: 8, enabled: true, floor_slots: 3 },
  climate: { label: "Climate", affinity: 0.75, half_life_hours: 36, enabled: true }, // the owner's own
};
const BOOSTS = [{ id: "topic-ai", label: "AI", match_type: "topic", match_value: "ai", amount: 0.3 }];
const EXTRAS = {
  s10: {},
  s13: { passes: { ...clone(PASS_DEFAULTS), other_side: { per_page: 2 } } },
  s28: { passes: clone(PASS_DEFAULTS), standing_stories: clone(STANDING_DEFAULTS).map((s) => (s.id === "sudan" ? { ...s, silence_hours: 48 } : s)) },
  s33: { passes: clone(PASS_DEFAULTS), standing_stories: clone(STANDING_DEFAULTS), live_overrides: { ...clone(LIVE_OVERRIDES_DEFAULTS), blocked_labels: ["Olympics"] } },
};

/** A stored history of three versions in the shape a build of that era saved. */
function oldStore(era, extraTopic = false) {
  const history = [];
  for (let v = 1; v <= 3; v++) {
    const topics = clone(TOPICS);
    if (v === 1) delete topics.climate;
    if (v >= 3) topics.world.half_life_hours = 5;
    if (extraTopic) topics.space_weather = { label: "Space weather", affinity: 0.4, half_life_hours: 72, enabled: false };
    const profile = {
      schema_version: 1, profile_version: v, updated_at: `2026-09-0${v}T08:00:00Z`,
      topics, trust: { reuters: 0.9 }, boosts: v >= 2 ? clone(BOOSTS) : [],
      mutes: { sources: ["dailymail"], topics: extraTopic ? ["space_weather"] : [] },
      seen_penalty: { opened: 1, shown: 0.25 },
      ...clone(EXTRAS[era]),
    };
    history.push({ version: v, timestamp: profile.updated_at, profile });
  }
  return { history };
}
const PROFILES = { s10: oldStore("s10"), s13: oldStore("s13"), s28: oldStore("s28"), s33: oldStore("s33"), unknown_topic: oldStore("s33", true) };

// ---- page probes -------------------------------------------------------------

const PROBE = `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
`;

async function setup(chrome) {
  const errors = [];
  chrome.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]);
  });
  chrome.ran = { scripts: new Map(), sheets: new Map() };
  chrome.on((m) => {
    if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) { chrome.ran.scripts.clear(); chrome.ran.sheets.clear(); }
    if (m.method === "Debugger.scriptParsed" && /^http/.test(m.params.url)) chrome.ran.scripts.set(m.params.url, m.params.scriptId);
    if (m.method === "CSS.styleSheetAdded" && /^http/.test(m.params.header.sourceURL)) chrome.ran.sheets.set(m.params.header.sourceURL, m.params.header.styleSheetId);
  });
  await chrome.send("Page.enable");
  await chrome.send("Runtime.enable");
  await chrome.send("Network.enable");
  await chrome.send("Debugger.enable");
  await chrome.send("DOM.enable");
  await chrome.send("CSS.enable");
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  chrome.errors = errors;
  return chrome;
}

const offline = (chrome, off) => chrome.send("Network.emulateNetworkConditions", { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

async function go(chrome, url, wait = 900) {
  const nav = await chrome.send("Page.navigate", { url });
  await sleep(wait);
  return nav.result?.errorText || "";
}

/** What the You page shows: its own error line, its rows, its title and nav. */
const YOU = `JSON.stringify((() => {
  const root = document.getElementById("settings-root");
  const err = root ? [...root.querySelectorAll(".form-errors, .section-notice")].map((n) => n.textContent.trim()).filter(Boolean) : ["no settings-root"];
  return {
    view: root && root.dataset.view || "", title: (document.getElementById("page-title") || {}).textContent || "",
    rows: document.querySelectorAll("#settings-root .setting-row").length, errors: err,
    body: document.body ? document.body.innerText.slice(0, 160) : "",
    build: (document.querySelector('meta[name="almanac-build"]') || {}).content || "",
  };
})())`;
const you = async (chrome) => JSON.parse(await chrome.evaluate(YOU));

/** The bottom nav on screen, uncovered, at the bottom edge; and the screen's header. */
const NAV = (header) => `JSON.stringify((() => {
  const nav = [...document.querySelectorAll(".bottom-nav")].find((n) => n.offsetParent !== null || getComputedStyle(n).position === "fixed");
  const r = nav ? nav.getBoundingClientRect() : null;
  const hit = document.elementFromPoint(innerWidth / 2, innerHeight - 20);
  const h = document.querySelector(${JSON.stringify(header)});
  const hr = h ? h.getBoundingClientRect() : null;
  const hit2 = hr ? document.elementFromPoint(Math.min(hr.left + hr.width / 2, innerWidth - 1), hr.top + hr.height / 2) : null;
  return {
    nav: !!nav && r.height >= 48 && r.bottom <= innerHeight + 1 && r.top < innerHeight && getComputedStyle(nav).visibility === "visible",
    navOnTop: !!(hit && hit.closest(".bottom-nav")), items: nav ? nav.querySelectorAll(".nav-item").length : 0,
    header: !!hr && hr.height > 0 && hr.bottom > 0 && hr.top < innerHeight / 2 && !!(hit2 && (h.contains(hit2) || hit2.contains(h))),
    current: (document.querySelector('.nav-item[aria-current="page"]') || {}).dataset?.screen || "",
  };
})())`;
const DESTS = [
  ["/", ".tabs", "home"], ["/#following", "#following-title", "following"],
  ["/#saved", "#saved-title", "saved"], ["/profile", "#page-title", "you"],
];

async function navAll(chrome, origin, tag) {
  const out = {};
  for (const [path, header, screen] of DESTS) {
    await go(chrome, origin + path, 700);
    const s = JSON.parse(await chrome.evaluate(NAV(header)));
    out[screen] = { ...s, pass: s.nav && s.navOnTop && s.items === 4 && s.header && s.current === screen };
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const png = (await chrome.send("Page.captureScreenshot", { format: "png" })).result.data;
      writeFileSync(join(SHOTS, `${tag}-${screen}.png`), Buffer.from(png, "base64"));
    }
  }
  return out;
}

/** Every script and stylesheet the current page actually ran (its source as Chrome parsed
 * it), compared with the bytes the page's own build wrote. */
async function ranOwnBuild(chrome, dist) {
  const wrong = [];
  const items = [
    ...[...chrome.ran.scripts].map(([url, id]) => [url, () => chrome.send("Debugger.getScriptSource", { scriptId: id }).then((r) => r.result?.scriptSource)]),
    ...[...chrome.ran.sheets].map(([url, id]) => [url, () => chrome.send("CSS.getStyleSheetText", { styleSheetId: id }).then((r) => r.result?.text)]),
  ];
  for (const [url, get] of items) {
    const rel = new URL(url).pathname.slice(1);
    const file = join(dist, rel);
    const want = existsSync(file) ? readFileSync(file, "utf-8") : null;
    if (want !== (await get())) wrong.push(rel);
  }
  return { ran: items.length, wrong };
}

/** Every script and stylesheet the open page names, fetched as the page would (through
 * the worker), compared with the bytes its own build wrote. Module imports are followed. */
async function assetsMatch(chrome, dist) {
  const listed = JSON.parse(await chrome.evaluate(`(async () => {
    const urls = [...document.querySelectorAll("script[src], link[rel=stylesheet]")].map((n) => n.src || n.href);
    const seen = new Map();
    const queue = urls.filter((u) => new URL(u).origin === location.origin);
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      const text = await fetch(url).then((r) => r.text()).catch(() => "");
      seen.set(url, text);
      if (url.split("?")[0].endsWith(".js")) {
        for (const m of text.matchAll(/(?:\\bfrom|\\bimport)\\s*\\(?\\s*["'](\\.{1,2}\\/[^"']+)["']/g)) queue.push(new URL(m[1], url).href);
      }
    }
    return JSON.stringify([...seen]);
  })()`));
  const wrong = [];
  for (const [url, text] of listed) {
    const rel = new URL(url).pathname.slice(1);
    const want = existsSync(join(dist, rel)) ? readFileSync(join(dist, rel), "utf-8") : null;
    if (want !== text) wrong.push(rel);
  }
  return { checked: listed.length, wrong };
}

const setProfile = (chrome, store) => chrome.evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(store))}); 1`);
const readStore = async (chrome) => JSON.parse(await chrome.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`));
const ready = (chrome) => chrome.evaluate("navigator.serviceWorker.ready.then(() => 1)").then(() => sleep(400));

// ---- A: stale assets across a deploy ----------------------------------------------

async function sessionA(oldDist, newDist) {
  const s = await site(oldDist);
  let chrome = await setup(await launch("h2-a"));
  const dir = chrome.userDataDir;
  await go(chrome, s.origin + "/");
  await ready(chrome);
  await go(chrome, s.origin + "/profile");
  await setProfile(chrome, PROFILES.s33);
  await go(chrome, s.origin + "/profile");
  const before = await you(chrome);

  // The app still open, the deploy live but the new worker not yet installed (its
  // update check or install still pending, as on a phone for a while): every page is
  // the new build's, fetched network-first by the old worker.
  s.deploy(newDist, { keepWorker: true });
  await go(chrome, s.origin + "/profile", 1500);
  const pending = await you(chrome);
  const pendingRan = await ranOwnBuild(chrome, newDist);
  const pendingNav = await navAll(chrome, s.origin, "a-pending");
  check("A1_you_after_a_deploy_under_the_old_worker_renders_without_error",
    !pending.errors.length && pending.rows > 0 && !chrome.errors.length, { old: { rows: before.rows }, pending, exceptions: chrome.errors.slice(0, 3) });
  check("A2_that_page_ran_only_its_own_builds_scripts_and_styles", pendingRan.wrong.length === 0, pendingRan);
  check("A3_every_nav_destination_shows_the_nav_and_its_header_under_the_old_worker", Object.values(pendingNav).every((n) => n.pass), pendingNav);

  // The new worker deployed too: the next tap on You, app still open.
  s.deploy(newDist);
  await go(chrome, s.origin + "/profile", 1500);
  const openState = await you(chrome);
  const openRan = await ranOwnBuild(chrome, newDist);
  const openNav = await navAll(chrome, s.origin, "a-open");
  check("A1b_you_after_the_worker_update_with_the_app_open_renders_without_error",
    !openState.errors.length && openState.rows > 0 && !chrome.errors.length, { openState, exceptions: chrome.errors.slice(0, 3) });
  check("A2b_that_page_ran_only_its_own_builds_scripts_and_styles", openRan.wrong.length === 0, openRan);
  check("A3b_every_nav_destination_shows_the_nav_and_its_header_after_the_update", Object.values(openNav).every((n) => n.pass), openNav);
  chrome.close();
  await sleep(800);

  // Reopened: Chrome closed and launched again on the same profile directory.
  chrome = await setup(await launch("h2-a", { userDataDir: dir }));
  await go(chrome, s.origin + "/profile", 1500);
  const reopened = await you(chrome);
  const reopenedAssets = await ranOwnBuild(chrome, newDist);
  check("A4_reopened_after_the_deploy_renders_without_error", !reopened.errors.length && reopened.rows > 0 && !chrome.errors.length,
    { reopened, exceptions: chrome.errors.slice(0, 3) });
  check("A5_reopened_page_runs_only_its_own_builds_assets", reopenedAssets.wrong.length === 0, reopenedAssets);

  // C: deep links, Back, offline, on the migrated owner profile under the new worker.
  await sessionC(chrome, s.origin, "a");
  chrome.close();
  s.close();
}

/** The reverse: build 1's page stays open while build 2's worker takes it over; what it
 * loads from then on must still be build 1's. */
async function sessionReverse(dist1, dist2) {
  const s = await site(dist1);
  const chrome = await setup(await launch("h2-r"));
  await go(chrome, s.origin + "/");
  await ready(chrome);
  await go(chrome, s.origin + "/profile");
  const first = await you(chrome);
  s.deploy(dist2);
  await chrome.evaluate(`new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(1));
    navigator.serviceWorker.getRegistration().then((r) => r.update());
    setTimeout(() => resolve(0), 6000);
  })`);
  await sleep(500);
  const assets = await assetsMatch(chrome, dist1);
  check("R1_an_open_page_from_the_previous_build_keeps_getting_its_own_assets_after_the_new_worker_takes_over",
    first.rows > 0 && assets.wrong.length === 0, assets);
  // And its next navigation is the new build, whole.
  await go(chrome, s.origin + "/profile", 1500);
  const next = await you(chrome);
  const nextAssets = await assetsMatch(chrome, dist2);
  check("R2_the_next_navigation_is_the_new_build_with_its_own_assets", !next.errors.length && next.rows > 0 && nextAssets.wrong.length === 0,
    { next, nextAssets });
  chrome.close();
  s.close();
}

// ---- B: old stored profiles ----------------------------------------------------

const DEEP = (store) => {
  const last = store.history[store.history.length - 1].profile;
  return [
    "", ...Object.keys(last.topics).map((id) => `#interest/${id}`),
    ...(last.standing_stories || STANDING_DEFAULTS).map((st) => `#story/${st.id}`),
    "#sources", "#advanced", "#topic-ai", "#raw-json",
  ];
};

async function sessionB(dist) {
  const s = await site(dist);
  const chrome = await setup(await launch("h2-b"));
  await go(chrome, s.origin + "/");
  await ready(chrome);
  for (const [name, store] of Object.entries(PROFILES)) {
    chrome.errors.length = 0;
    await go(chrome, s.origin + "/health", 400);
    await chrome.evaluate("localStorage.clear(); sessionStorage.clear(); 1");
    await setProfile(chrome, store);
    const views = {};
    for (const hash of DEEP(store)) {
      await go(chrome, s.origin + "/profile" + hash, 700);
      const st = await you(chrome);
      views[hash || "you"] = { pass: !st.errors.length && st.rows + (st.view === "sources" ? 1 : 0) > 0, view: st.view, errors: st.errors };
    }
    const after = await readStore(chrome);
    const n = store.history.length;
    const kept = store.history.every((h, i) => JSON.stringify(after.history[i]) === JSON.stringify(h));
    const last = after.history[after.history.length - 1].profile;
    const prev = store.history[n - 1].profile;
    const editsKept = JSON.stringify(last.topics) === JSON.stringify(prev.topics) && JSON.stringify(last.boosts) === JSON.stringify(prev.boosts)
      && JSON.stringify(last.mutes) === JSON.stringify(prev.mutes) && JSON.stringify(last.trust) === JSON.stringify(prev.trust)
      && ["passes", "standing_stories", "live_overrides"].every((k) => !(k in prev) || JSON.stringify(last[k]) === JSON.stringify(prev[k]));
    const complete = ["passes", "standing_stories", "live_overrides", "display"].every((k) => k in last);
    check(`B_${name}_opens_every_view_without_error`, Object.values(views).every((v) => v.pass) && !chrome.errors.length,
      { failed: Object.fromEntries(Object.entries(views).filter(([, v]) => !v.pass)), exceptions: chrome.errors.slice(0, 3) });
    check(`B_${name}_migrated_once_history_and_edits_kept`, after.history.length === n + 1 && kept && editsKept && complete,
      { versions: after.history.map((h) => h.version), kept, editsKept, complete });
  }
  // A damaged profile no migration can repair (an interest stored as null, which fails
  // validation, so nothing is written): the Interests section alone shows its calm
  // notice, every other section and the nav still work, nothing is thrown.
  const damaged = oldStore("s33");
  damaged.history[2].profile.topics.climate = null;
  chrome.errors.length = 0;
  await go(chrome, s.origin + "/health", 400);
  await chrome.evaluate("localStorage.clear(); sessionStorage.clear(); 1");
  await setProfile(chrome, damaged);
  await go(chrome, s.origin + "/profile", 900);
  const hurt = JSON.parse(await chrome.evaluate(`JSON.stringify({
    notices: [...document.querySelectorAll("#settings-root .section-notice")].map((n) => n.closest("section")?.querySelector(".settings-label")?.textContent || ""),
    sections: document.querySelectorAll("#settings-root .settings-section").length,
    rows: document.querySelectorAll("#settings-root .setting-row").length,
  })`));
  const hurtNav = JSON.parse(await chrome.evaluate(NAV("#page-title")));
  const untouched = JSON.stringify(await readStore(chrome)) === JSON.stringify(damaged);
  check("B_damaged_profile_shows_a_notice_in_that_section_only", hurt.notices.length === 1 && hurt.notices[0] === "Your interests"
    && hurt.sections >= 6 && hurt.rows >= 4 && hurtNav.nav && untouched && !chrome.errors.length, { hurt, nav: hurtNav.nav, untouched, exceptions: chrome.errors.slice(0, 3) });
  chrome.close();
  s.close();
}

// ---- C: direct, deep links, Back, offline, the nav --------------------------------------

async function sessionC(chrome, origin, tag) {
  chrome.errors.length = 0;
  await go(chrome, origin + "/profile");
  await go(chrome, origin + "/profile#interest/climate", 700);
  const deep = await you(chrome);
  await chrome.evaluate("history.back(); 1");
  await sleep(600);
  const back = await you(chrome);
  await go(chrome, origin + "/profile#sources", 700);
  const sources = await you(chrome);
  await chrome.evaluate(`document.getElementById("masthead-back").click(); 1`);
  await sleep(600);
  const arrow = await you(chrome);
  check(`C_${tag}_deep_link_back_and_arrow`, deep.view === "interest" && deep.title === "Climate" && back.view === "you"
    && sources.view === "sources" && arrow.view === "you" && !chrome.errors.length,
    { deep: deep.view, back: back.view, sources: sources.view, arrow: arrow.view, exceptions: chrome.errors.slice(0, 3) });
  const nav = await navAll(chrome, origin, `${tag}-online`);
  check(`C_${tag}_every_nav_destination_shows_the_nav_and_its_header`, Object.values(nav).every((n) => n.pass), nav);

  await offline(chrome, true);
  const off = {};
  for (const hash of ["", "#interest/ai", "#story/sudan", "#sources", "#advanced"]) {
    await go(chrome, origin + "/profile" + hash, 700);
    const st = await you(chrome);
    off[hash || "you"] = { pass: !st.errors.length && st.rows > 0, view: st.view, errors: st.errors };
  }
  const offNav = await navAll(chrome, origin, `${tag}-offline`);
  const cls = await chrome.evaluate("window.__cls");
  const csp = await chrome.evaluate("window.__csp.length");
  check(`C_${tag}_offline_every_view_and_the_nav`, Object.values(off).every((v) => v.pass) && Object.values(offNav).every((n) => n.pass),
    { off, offNav });
  check(`C_${tag}_cls_zero_and_no_csp_violations`, cls === 0 && csp === 0, { cls, csp });
  await offline(chrome, false);
}

// ---- T: Today after the U1 deploy: photos and the bottom nav ---------------------

const PRE_U1_REF = "4810f5f"; // main just before U1 (the phone's cached build on 2026-09-24)
const PHOTOS = [1280, 960]; // standard thumbnail widths of one Wikimedia Commons photo

/** The golden pool with a photo on every article, so Today has a hero and thumbnails. */
function photoPool() {
  const pool = JSON.parse(readFileSync(POOL, "utf-8"));
  pool.articles.forEach((a, i) => { a.image = { url: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/${PHOTOS[i % PHOTOS.length]}px-Camponotus_flavomarginatus_ant.jpg`, width: PHOTOS[i % PHOTOS.length], height: Math.round(PHOTOS[i % PHOTOS.length] * 2 / 3) }; });
  const path = join(TMP, "photo_pool.json");
  writeFileSync(path, JSON.stringify(pool));
  return path;
}

const TODAY = `JSON.stringify((() => {
  const imgs = [...document.querySelectorAll("#section-today img")].filter((img) => img.getBoundingClientRect().top < innerHeight && img.loading !== "lazy");
  const shown = imgs.filter((img) => { const r = img.getBoundingClientRect(); return img.complete && img.naturalWidth > 0 && r.width > 0 && r.height > 0 && getComputedStyle(img).visibility === "visible"; });
  return { photos: imgs.length, shown: shown.length, hidden: getComputedStyle(document.getElementById("pager") || document.body).visibility,
    rerank: document.documentElement.classList.contains("rerank"), build: (document.querySelector('meta[name="almanac-build"]') || {}).content || "" };
})())`;

async function today(chrome, origin, tag) {
  await sleep(2500); // photos come over the network
  const t = JSON.parse(await chrome.evaluate(TODAY));
  const nav = JSON.parse(await chrome.evaluate(NAV(".tabs")));
  const ran = await ranOwnBuild(chrome, chrome.expectDist);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const png = (await chrome.send("Page.captureScreenshot", { format: "png" })).result.data;
    writeFileSync(join(SHOTS, `today-${tag}.png`), Buffer.from(png, "base64"));
  }
  return { ...t, nav: nav.nav && nav.navOnTop && nav.items === 4, header: nav.header, ranWrong: ran.wrong,
    pass: t.photos > 0 && t.shown === t.photos && nav.nav && nav.navOnTop && nav.header && ran.wrong.length === 0 };
}

/** The owner's device state: a stored profile and read history, so the page re-ranks. */
async function ownerState(chrome) {
  await setProfile(chrome, PROFILES.s33);
  await chrome.evaluate(`localStorage.setItem("almanac.history.summary.v1", JSON.stringify({ opened: { x: Date.now() }, shown: {} })); 1`);
}

async function sessionToday(preDist, newDist) {
  // (a) a fresh profile on the new build.
  let s = await site(newDist);
  let chrome = await setup(await launch("h2-ta"));
  chrome.expectDist = newDist;
  await go(chrome, s.origin + "/", 400);
  await ownerState(chrome);
  await go(chrome, s.origin + "/", 400);
  const fresh = await today(chrome, s.origin, "fresh");
  await ready(chrome);
  await go(chrome, s.origin + "/", 400);
  const freshSw = await today(chrome, s.origin, "fresh-sw");
  check("T1_fresh_profile_on_the_new_build_shows_photos_and_the_nav", fresh.pass && freshSw.pass && !chrome.errors.length,
    { fresh, freshSw, exceptions: chrome.errors.slice(0, 3) });
  chrome.close();
  s.close();

  // (b) the upgrade: the pre-U1 worker installed and Today loaded, then the new build
  // deployed at the same origin and Today reloaded twice, as the phone did.
  s = await site(preDist);
  chrome = await setup(await launch("h2-tb"));
  chrome.expectDist = preDist;
  await go(chrome, s.origin + "/", 400);
  await ownerState(chrome);
  await ready(chrome);
  await go(chrome, s.origin + "/", 400);
  const before = await today(chrome, s.origin, "pre");
  s.deploy(newDist);
  chrome.expectDist = newDist;
  const reloads = [];
  for (let i = 1; i <= 2; i++) {
    await chrome.send("Page.reload", {});
    reloads.push(await today(chrome, s.origin, `upgrade-${i}`));
  }
  // The pre-U1 worker still answers the first reload after the deploy (its own image
  // route is what fails the photos), and that reload installs the new worker: the photos
  // must be back by the second reload with no action on the phone. Every reload must
  // show the nav and run only its own build's scripts and styles.
  const healedAt = reloads.findIndex((r) => r.pass) + 1;
  check("T2_upgrade_from_the_pre_u1_worker_heals_by_the_second_reload_nav_and_own_assets_on_every_reload",
    reloads[reloads.length - 1].pass && reloads.every((r) => r.nav && r.header && r.ranWrong.length === 0) && !chrome.errors.length,
    { healedAt, before, reloads, exceptions: chrome.errors.slice(0, 3) });
  chrome.close();
  s.close();
}

// ---- run ---------------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
try {
  const pool = photoPool();
  await sessionToday(buildRef(PRE_U1_REF, join(TMP, "pre-u1"), null, pool), buildRef(NEW_REF, join(TMP, "new-photos"), null, pool));
  if (ONLY !== "today") {
    const oldDist = buildRef(OLD_REF, join(TMP, "old"));
    const newDist = buildRef(NEW_REF, join(TMP, "new"));
    const newDist2 = buildRef(NEW_REF, join(TMP, "new2"), secondBuild);
    await sessionA(oldDist, newDist);
    await sessionReverse(newDist, newDist2);
    await sessionB(newDist);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 1));
console.log(`${Object.values(results).filter((r) => r.pass).length} passed, ${Object.values(results).filter((r) => !r.pass).length} failed`);
process.exit(ok ? 0 : 1);
