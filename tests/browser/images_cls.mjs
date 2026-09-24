// S39 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/images_cls.mjs <built dist dir> [<screenshot dir>]
// Serves the built page and opens it in headless Chrome at 360x780 CSS px, DPR 3. Every
// photo request is held by the DevTools Fetch domain and answered late (1.2 s, then
// 0.25 s more per photo, a throttle that does not depend on the network), and in the
// "one failing" visits the first thumbnail's request fails outright. For each visit it
// records every row's and photo frame's box before any photo arrives, scrolls the whole
// page so every lazy thumbnail loads, then records them again. It fails on CLS above 0,
// any box that moved or resized, an img without width, height and a 1 / 1 aspect-ratio,
// a non-https src, a photo outside the hero and river tiers, or a failed photo whose
// frame lost its token tint. A last visit loads the real photos for the screenshots.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

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
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "s39-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) listeners.forEach((f) => f(m));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

// A stand-in photo: a 16:9 gradient, the shape most pool images state.
const PHOTO = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#4a6b8a"/><stop offset="1" stop-color="#c9a36b"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/></svg>`).toString("base64");
let mode = "real"; // "real" | "slow" | "fail"
let failUrl = null;
let held = 0;
const seen = [];
listeners.push(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  seen.push(request.url);
  if (mode === "fail" && request.url === failUrl) { await send("Fetch.failRequest", { requestId, errorReason: "Failed" }); return; }
  await sleep(1200 + 250 * held++);
  await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/svg+xml" }], body: PHOTO });
});

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

const BOXES = `JSON.stringify([...document.querySelectorAll("li.story, .story-media, .story-credit, .colophon")].map((el) => {
  const r = el.getBoundingClientRect(); return [el.dataset.sid || el.className, Math.round((r.top + scrollY) * 100) / 100, Math.round(r.height * 100) / 100, Math.round(r.width * 100) / 100]; }))`;
const AUDIT = `JSON.stringify([...document.querySelectorAll("img")].map((img) => {
  const frame = img.closest(".story-media"), li = img.closest("li.story"), cs = getComputedStyle(img), fr = frame && frame.getBoundingClientRect(), ir = img.getBoundingClientRect();
  return { src: img.getAttribute("src"), w: img.getAttribute("width"), h: img.getAttribute("height"), ratio: cs.aspectRatio, fit: cs.objectFit,
    alt: img.getAttribute("alt"), loading: img.getAttribute("loading"), priority: img.getAttribute("fetchpriority"), decoding: img.getAttribute("decoding"),
    referrer: img.getAttribute("referrerpolicy"), tier: li && li.className, kind: frame && frame.className, frameRatio: frame && getComputedStyle(frame).aspectRatio,
    tint: frame && getComputedStyle(frame).backgroundColor, sameBox: !!fr && Math.abs(fr.width - ir.width) < 0.5 && Math.abs(fr.height - ir.height) < 0.5,
    box: [Math.round(ir.width), Math.round(ir.height)], complete: img.complete, natural: img.naturalWidth }; }))`;

function auditPass(imgs, tintExpected) {
  const problems = [];
  for (const i of imgs) {
    const hero = i.kind?.includes("story-media--hero");
    if (!i.w || !i.h || i.ratio !== "1 / 1" || i.frameRatio !== "1 / 1") problems.push(["box", i.src]);
    if (!/^https:\/\/[^\s]+$/i.test(i.src || "")) problems.push(["src", i.src]);
    if (!i.sameBox || i.fit !== "cover" || i.alt !== "" || i.decoding !== "async" || i.referrer !== "no-referrer") problems.push(["attrs", i.src]);
    if (hero ? i.priority !== "high" || i.loading : i.loading !== "lazy") problems.push(["loading", i.src]);
    if (!(hero ? /story--hero/ : /story--river/).test(i.tier || "")) problems.push(["tier", i.tier]);
    if (i.tint !== tintExpected) problems.push(["tint", i.tint]);
  }
  return problems;
}

async function visit({ name, scheme = "dark", stored = null, imageMode, shots = [] }) {
  mode = imageMode;
  held = 0;
  seen.length = 0;
  await send("Fetch.disable");
  if (imageMode !== "real") await send("Fetch.enable", { patterns: [{ urlPattern: "https://*", resourceType: "Image", requestStage: "Request" }] });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${origin}/index.html` });
  await sleep(600);
  await evaluate(stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : "localStorage.clear()");
  // Load once with the stored profile in place, so the failing photo is the first
  // thumbnail of the order this visit will actually show.
  await send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  failUrl = await evaluate(`(document.querySelector(".story--river .story-img") || {}).src || null`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(700);
  await evaluate("document.fonts.ready.then(() => 1)");
  // Snapshot before any photo arrives (held photos are 1.2 s out at the earliest).
  const before = JSON.parse(await evaluate(BOXES));
  const tint = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--color-image-placeholder").trim()`);
  const tintRgb = await evaluate(`(() => { const s = document.createElement("span"); s.style.color = getComputedStyle(document.documentElement).getPropertyValue("--color-image-placeholder").trim(); document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`);
  if (shots.includes("placeholder")) {
    writeFileSync(join(shotsArg, `${name}-placeholder.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  }
  // Scroll the whole page in viewport steps so every lazy thumbnail is requested.
  const height = await evaluate("document.documentElement.scrollHeight");
  for (let y = 0; y <= height; y += 600) { await evaluate(`scrollTo(0, ${y})`); await sleep(imageMode === "real" ? 250 : 120); }
  await evaluate("scrollTo(0, 0)");
  await sleep(imageMode === "real" ? 4000 : 1500 + 250 * 20);
  await evaluate(`Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 8000); })))`);
  const after = JSON.parse(await evaluate(BOXES));
  const imgs = JSON.parse(await evaluate(AUDIT));
  const cls = await evaluate("window.__cls");
  const moved = before.filter((b, k) => JSON.stringify(b) !== JSON.stringify(after[k])).length + Math.abs(before.length - after.length);
  const problems = auditPass(imgs, tintRgb);
  const failed = imgs.filter((i) => i.complete && i.natural === 0);
  for (const s of shots) {
    if (s === "placeholder") continue;
    if (s === "river") {
      await evaluate(`scrollTo(0, document.querySelector(".story--river .story-media").closest("li").getBoundingClientRect().top + scrollY - 60)`);
      await sleep(imageMode === "real" ? 1500 : 300);
    }
    const file = s === "top" ? name : name.startsWith("final-") ? name.replace("final-", "river-") : `${name}-river`;
    writeFileSync(join(shotsArg, `${file}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    await evaluate("scrollTo(0, 0)");
  }
  const pass = cls === 0 && moved === 0 && problems.length === 0 && (imageMode !== "fail" || (failed.length >= 1 && failed.every((i) => i.sameBox && i.tint === tintRgb)));
  return { name, pass, cls, boxes: before.length, moved, imgs: imgs.length, hero: imgs.filter((i) => i.kind?.includes("hero")).length,
    thumbs: imgs.filter((i) => i.kind?.includes("thumb")).length, requested: seen.length, failed: failed.length, problems: problems.slice(0, 5), tint };
}

const base = buildDefaultProfile("2026-09-24T00:00:00Z");
const custom = structuredClone(base);
custom.topics.ai.affinity = 1;
custom.topics.industrial_biotech.affinity = 1;
custom.topics.us_politics.affinity = 0.1;
custom.topics.world.affinity = 0.2;
const stored = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...custom, profile_version: 2 } }] };

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const want = (list) => (shotsArg ? list : []);
const runs = [
  { name: "slow-dark", imageMode: "slow", shots: want(["placeholder"]) },
  { name: "fail-dark", imageMode: "fail", shots: want(["top", "river"]) },
  { name: "rerank-slow-dark", imageMode: "slow", stored },
  { name: "rerank-fail-light", imageMode: "fail", stored, scheme: "light" },
  { name: "final-light", imageMode: "real", scheme: "light", shots: want(["top"]) },
  { name: "final-dark", imageMode: "real", shots: want(["top", "river"]) },
];
const results = [];
for (const run of runs) results.push(await visit(run));
console.log(JSON.stringify(results, null, 1));
ws.close();
chrome.kill();
server.close();
// The real-photo visits depend on outside hosts, so they report but do not gate.
process.exit(results.filter((r) => !r.name.startsWith("final")).every((r) => r.pass) ? 0 : 1);
