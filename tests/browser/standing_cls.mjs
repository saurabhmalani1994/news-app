// S28 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/standing_cls.mjs <built dist dir> [<screenshot dir>] [<prefix>]
// Serves the built page in headless Chrome at 360x780 CSS px, DPR 3, and checks: the
// silence notices on the page equal standing.js run here on the page's own embedded
// input (build and device agree); a stored profile that switches every standing story
// off clears them and drops the floor placements before the page is shown, with zero
// layout shift; and each standing-story placement sits where the ranker put it. Saves
// <prefix>-dark.png and <prefix>-light.png at the top of Today, and, when the page has
// a floor placement, <prefix>-floor-dark.png with the first placed card in view.
// Exits 1 on CLS above 0 or any mismatch.
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ACCESS_COOKIE, PAGE_INPUT, decodeInput, parseHeaders, serve } from "./cdp.mjs";
import { rankPages, pageOptions } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const [distArg, shotsArg, prefix = "standing"] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// H5: served as Pages serves it (pretty URLs, the build's own _headers, so the live CSP)
// behind the simulated Access gate (cdp.mjs serve); the browser gets the login cookie.
const headerText = readFileSync(join(dist, "_headers"), "utf-8");
const server = await serve(dist, parseHeaders(headerText), {}, { "/sw.js": parseHeaders(headerText, "/sw.js") });
const origin = server.origin;

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "s28-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const capture = async (file) => { if (file) writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); };

await send("Page.enable");
await send("Network.setCookie", { ...ACCESS_COOKIE, url: `${origin}/` });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

async function visit(stored, scheme) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}/index.html` });
  await sleep(800);
  // H4 item 6: always clear first, even when about to set a stored profile. The two
  // plain default-page visits (dark, then light) that run before this file's own
  // "off-dark" case render for seconds each, long enough for R17's seen tracking to
  // write a history summary under its own key; a clear gated on "no stored profile
  // given" left that behind for this step's device re-rank, which reads it via
  // rerank.js's seenPenaltyTerm, while this file's own `want`/order comparison never
  // did, so the two disagreed on a page a reader had merely looked at, not this step's
  // own scenario. Same bug, same fix, as csp_check.mjs's load().
  await evaluate("localStorage.clear()");
  if (stored) await evaluate(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
  return JSON.parse(await evaluate(`document.fonts.ready.then(() => JSON.stringify({ cls: window.__cls,
    hiddenNow: document.documentElement.classList.contains("rerank"),
    order: [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid),
    notices: [...document.querySelectorAll("#standing-notices .notice")].map((n) => [n.dataset.standing, n.dataset.kind, ...[...n.querySelectorAll("p")].map((p) => p.textContent)]),
    input: ${PAGE_INPUT} }))`));
}

const base = buildDefaultProfile("2026-09-24T00:00:00Z");
const off = { ...structuredClone(base), standing_stories: [], profile_version: 2 };
const storeOf = (profile) => ({ history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile }] });
const store = storeOf(off);

// R2: whether the default standing stories place a card or raise a notice depends on
// the day's news (a fresh pool often does neither), so a fourth visit makes both
// happen on any pool: a stored profile whose one standing story is a word from a card
// below the floor that no card in the first 15 carries (the device must place it), and
// one whose keyword nothing carries (the device must raise its silence notice).
const html = readFileSync(join(dist, "index.html"), "utf-8");
const built = decodeInput(JSON.parse(html.match(/<template id="rank-input">([\s\S]*?)<\/template>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")));
const standing = (id, label, keywords, buckets = []) => ({ id, label, enabled: true, keywords, tags: [], buckets, floor_slots: 1, floor_within: 15, silence_hours: 24 });
const quiet = standing("r2_quiet", "Quiet probe", ["zzqprobe"], ["sudan"]);
function probeProfile() {
  const today = rankPages(built.pool, base, built.now, pageOptions(built)).today;
  const has = (s, w) => s.titles.some((t) => new RegExp(`(?<![\p{L}\p{N}])${w}(?![\p{L}\p{N}])`, "iu").test(t));
  for (const story of today.slice(20)) {
    for (const word of new Set((story.titles[0] || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])) {
      if (today.slice(0, 15).some((s) => has(s, word))) continue;
      const profile = { ...structuredClone(base), standing_stories: [standing("r2_floor", "Floor probe", [word]), quiet], profile_version: 2 };
      const page = rankPages(built.pool, profile, built.now, pageOptions(built));
      if (page.today.some((s) => s.passes.some((e) => e.pass === "standing-story" && e.text.startsWith("Placed")))) return profile;
    }
  }
  return null;
}
const probe = probeProfile();
if (!probe) { console.error("no headline word below the floor that places a card; is the pool empty?"); process.exit(1); }
if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const shot = (name) => (shotsArg ? join(shotsArg, `${prefix}-${name}.png`) : null);

const results = {};
let ok = true;
const profiles = new Map([[store, off], [storeOf(probe), probe]]);
for (const [name, stored, scheme] of [["default-dark", null, "dark"], ["default-light", null, "light"], ["off-dark", store, "dark"], ["probe-dark", [...profiles.keys()][1], "dark"]]) {
  const r = await visit(stored, scheme);
  const opts = pageOptions(r.input);
  const page = rankPages(r.input.pool, stored ? profiles.get(stored) : base, r.input.now, opts);
  const want = page.notices.map((n) => [n.id, n.kind, n.kicker, n.head, n.text]);
  const placed = page.today.map((s, i) => [s, i]).filter(([s]) => s.passes.some((e) => e.pass === "standing-story" && e.text.startsWith("Placed")));
  // The probe must really place a card and raise its notice, or it proved nothing.
  const probed = name !== "probe-dark" || (placed.length > 0 && r.notices.some((n) => n[0] === "r2_quiet"));
  const pass = probed && r.cls === 0 && !r.hiddenNow && JSON.stringify(r.notices) === JSON.stringify(want) && r.order.join() === page.today.map((s) => s.id).join();
  ok &&= pass;
  results[name] = { pass, cls: r.cls, notices: r.notices.map((n) => `${n[0]}: ${n[3]}`),
    placements: placed.map(([s, i]) => `${i + 1} ${s.passes.find((e) => e.pass === "standing-story").text}`) };
  if (name.startsWith("default-")) await capture(shot(name.replace("default-", "")));
  if (name === "default-dark" && placed.length) {
    await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${placed[0][0].id}"]');
      const panel = document.getElementById("section-today");
      panel.scrollTop += li.getBoundingClientRect().top - panel.getBoundingClientRect().top - 150; })()`);
    await sleep(600);
    await capture(shot("floor-dark"));
  }
}
console.log(JSON.stringify(results, null, 2));
ws.close();
chrome.kill();
server.close();
process.exit(ok ? 0 : 1);
