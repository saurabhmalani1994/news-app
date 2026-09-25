// S39 browser proof (S27: Today scrolls in its own panel now), run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/images_cls.mjs <built dist dir> [<screenshot dir>]
// Serves the built page and opens it in headless Chrome at 360x780 CSS px, DPR 3. Every
// photo request is held by the DevTools Fetch domain and answered late (1.2 s, then
// 0.25 s more per photo, a throttle that does not depend on the network), and in the
// "one failing" visits the first thumbnail's request fails outright. For each visit it
// records every row's and photo frame's box before any photo arrives, scrolls the whole
// page so every lazy thumbnail loads, then records them again. It fails on CLS above 0,
// any box that moved or resized, an img without width, height and its aspect-ratio (1 / 1
// for a thumbnail; D2: for the hero, the stated shape from pool.json clamped to 1:1..4:3,
// checked on the laid-out frame),
// a non-https src, a photo outside the hero and river tiers, or a failed photo whose
// frame lost its token tint. A last visit loads the real photos for the screenshots.
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ACCESS_COOKIE, parseHeaders, serve } from "./cdp.mjs";

import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
// D2: the hero frame's expected height from the photo's stated size in the served pool.
const stated = new Map(JSON.parse(readFileSync(join(dist, "pool.json"), "utf-8")).articles
  .filter((a) => a.image && a.image.url).map((a) => [a.image.url, a.image]));
function heroHeight(src) {
  const im = stated.get(src);
  const ratio = im && im.width > 0 && im.height > 0 ? Math.min(Math.max(im.width / im.height, 1), 4 / 3) : 1;
  return Math.round(360 / ratio);
}
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// H5: served as Pages serves it (pretty URLs, the build's own _headers, so the live CSP)
// behind the simulated Access gate (cdp.mjs serve); the browser gets the login cookie.
const headerText = readFileSync(join(dist, "_headers"), "utf-8");
const server = await serve(dist, parseHeaders(headerText), {}, { "/sw.js": parseHeaders(headerText, "/sw.js") });
const origin = server.origin;

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
await send("Network.setCookie", { ...ACCESS_COOKIE, url: `${origin}/` });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

const BOXES = `JSON.stringify([...document.querySelectorAll("#section-today li.story, #section-today .story-media, #section-today .story-credit, #section-today .colophon")].map((el) => {
  const r = el.getBoundingClientRect(); return [el.dataset.sid || el.className, Math.round((r.top + document.getElementById("section-today").scrollTop) * 100) / 100, Math.round(r.height * 100) / 100, Math.round(r.width * 100) / 100]; }))`;
const AUDIT = `JSON.stringify([...document.querySelectorAll("img")].map((img) => {
  const frame = img.closest(".story-media"), li = img.closest("li.story"), cs = getComputedStyle(img), fr = frame && frame.getBoundingClientRect(), ir = img.getBoundingClientRect();
  return { src: img.getAttribute("src"), w: img.getAttribute("width"), h: img.getAttribute("height"), ratio: cs.aspectRatio, fit: cs.objectFit,
    alt: img.getAttribute("alt"), loading: img.getAttribute("loading"), priority: img.getAttribute("fetchpriority"), decoding: img.getAttribute("decoding"),
    referrer: img.getAttribute("referrerpolicy"), tier: li && li.className, kind: frame && frame.className, frameRatio: frame && getComputedStyle(frame).aspectRatio,
    tint: frame && getComputedStyle(frame).backgroundColor, sameBox: !!fr && Math.abs(fr.width - ir.width) < 0.5 && Math.abs(fr.height - ir.height) < 0.5,
    box: [Math.round(ir.width), Math.round(ir.height)], frame: fr && [fr.width, fr.height], complete: img.complete, natural: img.naturalWidth }; }))`;

function auditPass(imgs, tintExpected) {
  const problems = [];
  for (const i of imgs) {
    const hero = i.kind?.includes("story-media--hero");
    const ratio = hero ? `${i.w} / ${i.h}` : "1 / 1";
    if (!i.w || !i.h || i.ratio !== ratio || i.frameRatio !== ratio) problems.push(["box", i.src, i.ratio, i.frameRatio]);
    if (hero && (i.w !== "360" || Number(i.h) !== heroHeight(i.src) || Math.abs(i.frame[0] - 360) > 0.5
      || Math.abs(i.frame[1] - heroHeight(i.src)) > 0.5)) problems.push(["hero-box", i.src, i.h, i.frame]);
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
  const height = await evaluate('document.getElementById("section-today").scrollHeight');
  for (let y = 0; y <= height; y += 600) { await evaluate(`document.getElementById("section-today").scrollTo(0, ${y})`); await sleep(imageMode === "real" ? 250 : 120); }
  await evaluate('document.getElementById("section-today").scrollTo(0, 0)');
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
      await evaluate(`document.getElementById("section-today").scrollTo(0, document.querySelector("#section-today .story--river .story-media").closest("li").getBoundingClientRect().top + document.getElementById("section-today").scrollTop - 60)`);
      await sleep(imageMode === "real" ? 1500 : 300);
    }
    const file = s === "top" ? name : name.startsWith("final-") ? name.replace("final-", "river-") : `${name}-river`;
    writeFileSync(join(shotsArg, `${file}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    await evaluate('document.getElementById("section-today").scrollTo(0, 0)');
  }
  const pass = cls === 0 && moved === 0 && problems.length === 0 && (imageMode !== "fail" || (failed.length >= 1 && failed.every((i) => i.sameBox && i.tint === tintRgb)));
  const heroImg = imgs.find((i) => i.kind?.includes("hero"));
  return { name, pass, cls, boxes: before.length, moved, imgs: imgs.length, hero: imgs.filter((i) => i.kind?.includes("hero")).length,
    heroBox: heroImg ? heroImg.frame.map((v) => Math.round(v * 100) / 100) : null, heroSrc: heroImg ? heroImg.src.slice(0, 60) : null,
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
