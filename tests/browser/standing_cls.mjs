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
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { rankPages } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const [distArg, shotsArg, prefix = "standing"] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!path.startsWith(dist) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;

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
    input: JSON.parse(document.getElementById("rank-input").content.textContent) }))`));
}

const base = buildDefaultProfile("2026-09-24T00:00:00Z");
const off = { ...structuredClone(base), standing_stories: [], profile_version: 2 };
const store = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: off }] };
if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const shot = (name) => (shotsArg ? join(shotsArg, `${prefix}-${name}.png`) : null);

const results = {};
let ok = true;
for (const [name, stored, scheme] of [["default-dark", null, "dark"], ["default-light", null, "light"], ["off-dark", store, "dark"]]) {
  const r = await visit(stored, scheme);
  const opts = { buckets: r.input.buckets, leans: r.input.leans, names: r.input.names, health: r.input.health };
  const page = rankPages(r.input.pool, stored ? off : base, r.input.now, opts);
  const want = page.notices.map((n) => [n.id, n.kind, n.kicker, n.head, n.text]);
  const placed = page.today.map((s, i) => [s, i]).filter(([s]) => s.passes.some((e) => e.pass === "standing-story" && e.text.startsWith("Placed")));
  const pass = r.cls === 0 && !r.hiddenNow && JSON.stringify(r.notices) === JSON.stringify(want) && r.order.join() === page.today.map((s) => s.id).join();
  ok &&= pass;
  results[name] = { pass, cls: r.cls, notices: r.notices.map((n) => `${n[0]}: ${n[3]}`),
    placements: placed.map(([s, i]) => `${i + 1} ${s.passes.find((e) => e.pass === "standing-story").text}`) };
  if (name !== "off-dark") await capture(shot(name.replace("default-", "")));
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
