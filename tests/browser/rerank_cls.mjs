// S11 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/rerank_cls.mjs <built dist dir> [<screenshot dir>]
// Serves the built page, opens it in headless Chrome at 360x780 CSS px, DPR 3, and
// checks visits: no stored profile (paints as built), a stored non-default profile
// (re-ranked before paint), and (S13) a stored profile muting the hero's outlet and a
// topic, whose rows must be gone before the first frame. For each: cumulative layout shift, the order the
// first frame showed, and the final order against ranker.js run here on the page's own
// embedded input. Exits 1 on CLS above 0, a visible reorder or a wrong final order.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { rankPages } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!path.startsWith(dist) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "s11-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  requestAnimationFrame(() => {
    const root = document.documentElement;
    window.__first = { hidden: root.classList.contains("rerank"), order: [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid) };
  });` });

async function visit(stored, scheme, shot) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}/index.html` });
  await sleep(800);
  await evaluate(stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : "localStorage.clear()");
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
  const out = JSON.parse(await evaluate(`document.fonts.ready.then(() => JSON.stringify({ cls: window.__cls, first: window.__first,
    hiddenNow: document.documentElement.classList.contains("rerank"),
    order: [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid),
    others: [...document.querySelectorAll("#section-today .other-side")].map((a) => [a.closest("li").dataset.sid, a.dataset.aid]),
    input: JSON.parse(document.getElementById("rank-input").content.textContent),
    top: [...document.querySelectorAll("#headlines .headline")].slice(0, 5).map((h) => h.textContent), w: innerWidth, dpr: devicePixelRatio }))`));
  if (shot) {
    const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
    writeFileSync(shot, Buffer.from(png, "base64"));
  }
  return out;
}

const base = buildDefaultProfile("2026-09-24T00:00:00Z");
const custom = structuredClone(base);
custom.topics.ai.affinity = 1;
custom.topics.industrial_biotech.affinity = 1;
custom.topics.us_politics.affinity = 0.1;
custom.topics.world.affinity = 0.2;
const stored = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...custom, profile_version: 2 } }] };
// S13: mute the outlet of the built page's hero, and the Singapore topic.
const html = readFileSync(join(dist, "index.html"), "utf-8");
const probe = JSON.parse(html.match(/<template id="rank-input">([\s\S]*?)<\/template>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const heroId = html.split('id="headlines"')[1].match(/data-sid="([^"]+)"/)[1];
const heroCluster = probe.pool.clusters.find((c) => c.id === heroId);
const heroSource = probe.pool.articles.find((a) => a.id === (heroCluster ? heroCluster.lead : heroId)).source_id;
const muted = structuredClone(base);
muted.mutes = { sources: [heroSource], topics: ["singapore"] };
const mutedStore = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...muted, profile_version: 2 } }] };
const expectFor = (store) => (store === mutedStore ? muted : store ? custom : base);

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const shot = (name) => (shotsArg ? join(shotsArg, name) : null);
const results = {};
let ok = true;
for (const [name, store, scheme] of [["default-dark", null, "dark"], ["custom-dark", stored, "dark"], ["custom-light", stored, "light"], ["muted-dark", mutedStore, "dark"]]) {
  const r = await visit(store, scheme, shot(`rerank-${name}.png`));
  const opts = { buckets: r.input.buckets, leans: r.input.leans, names: r.input.names, health: r.input.health };
  const page = rankPages(r.input.pool, expectFor(store), r.input.now, opts);
  const expected = page.today.map((s) => s.id);
  const expectedOthers = page.today.filter((s) => s.other_side).map((s) => [s.id, s.other_side.article_id]);
  const built = rankPages(r.input.pool, base, r.input.now, opts).today.map((s) => s.id);
  // The first frame may come before the parser has every row; what it showed must be
  // a prefix of the final order, or the reader saw rows move.
  const visibleReorder = !r.first.hidden && r.first.order.join() !== r.order.slice(0, r.first.order.length).join();
  const othersMatch = JSON.stringify(r.others) === JSON.stringify(expectedOthers);
  const gone = new Set(page.removed.map((s) => s.id));
  const mutedGone = store !== mutedStore || (gone.size > 0 && !r.order.some((id) => gone.has(id)) && (r.first.hidden || !r.first.order.some((id) => gone.has(id))));
  const pass = r.cls === 0 && !visibleReorder && !r.hiddenNow && r.order.join() === expected.join() && othersMatch && mutedGone;
  ok &&= pass;
  results[name] = { pass, cls: r.cls, firstFrameHidden: r.first.hidden, visibleReorder, finalMatchesRanker: r.order.join() === expected.join(), othersMatch, mutedGone,
    removed: page.removed.length, others: r.others,
    reordered: built.join() !== r.order.join(), width: r.w, dpr: r.dpr, top: r.top };
}
console.log(JSON.stringify(results, null, 2));
ws.close();
chrome.kill();
server.close();
process.exit(ok ? 0 : 1);
