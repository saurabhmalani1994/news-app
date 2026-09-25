// B4 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/b4_locality_check.mjs <built dist dir> [<screenshot dir>]
//
// Serves the build the way Cloudflare Pages does (its own _headers, pretty URLs) behind
// an Access-like gate (no CF_Authorization cookie: a 302 to a login origin), to headless
// Chrome as a phone (360x780 CSS px, DPR 3). Checks:
//   - without the cookie, pool.json, a bodies/ file and the page all get the 302;
//   - the page embeds `locality` (app/build.py version_locality) for carousel members;
//   - on a Today row whose versions span two tiers, every slide's meta line names the
//     tier versions.js localityLabel gives its article (Local, Regional, Overseas), and a
//     slide the pool left unlabeled names none;
//   - zero page errors. Screenshots of two slides in dark and one in light.
// Exits 1 on failure.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

import { launch, parseHeaders, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const DIST = resolve(distArg || "dist");
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const WORDS = { local: "Local", intermediate: "Regional", overseas: "Overseas" };
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

async function gatedSite(dir) {
  const root = resolve(dir);
  const text = readFileSync(join(root, "_headers"), "utf-8");
  const headers = parseHeaders(text);
  const swHeaders = parseHeaders(text, "/sw.js");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    if (!/(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "")) {
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
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const site = await gatedSite(DIST);

// 1. The gate: no cookie, no pool, no body, no page.
const body = readdirSync(join(DIST, "bodies")).find((f) => f.endsWith(".json"));
for (const path of ["/pool.json", `/bodies/${body}`, "/"]) {
  const r = await fetch(site.origin + path, { redirect: "manual" });
  check(r.status === 302 && /cloudflareaccess\.com/.test(r.headers.get("location") || ""), `unauthenticated ${path} gets the Access redirect (${r.status})`);
}

const chrome = await launch("b4-locality");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setUserAgentOverride", { userAgent: UA, platform: "Linux armv8l" });
await send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: `${site.origin}/` });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });

async function visit(scheme, hash = "") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: "about:blank" });
  await sleep(100);
  await send("Page.navigate", { url: `${site.origin}/${hash}` });
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.readyState === "complete" && document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`).catch(() => false)) break;
    await sleep(100);
  }
  await sleep(700);
}
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

// 2. Pick a Today row whose carousel spans two tiers.
await visit("dark");
const pick = await evaluate(`(async () => {
  const src = document.querySelector('script[src*="js/versions-view.js"]').getAttribute("src");
  const v = src.split("?")[1] || "";
  const m = await import("./js/versions.js" + (v ? "?" + v : ""));
  const data = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ctx = m.versionsContext(data);
  const sids = [...new Set([...document.querySelectorAll("#section-today .story-coverage")].map((b) => b.dataset.sid))];
  const rows = sids.map((sid) => { const c = ctx.clusters.get(sid);
    const s = m.buildVersions(c, ctx, { leadId: c.lead, nowMs: Date.now() });
    return { sid, ids: s.map((x) => x.id), labels: s.map((x) => x.locality) }; });
  const mixed = rows.filter((r) => new Set(r.labels.filter(Boolean)).size >= 2).sort((a, b) => a.ids.length - b.ids.length);
  return { tiers: Object.keys(data.locality || {}).length, rows: rows.length,
    labeled: rows.filter((r) => r.labels.some(Boolean)).length, row: mixed[0] || null, locality: data.locality || {} };
})()`);
check(pick.tiers > 0, `the page embeds a tier for ${pick.tiers} carousel members`);
console.log(`  Today rows with a carousel: ${pick.rows}; with at least one tier label: ${pick.labeled}`);
check(!!pick.row, `a Today carousel spans two tiers (${pick.row?.sid} ${JSON.stringify(pick.row?.labels)})`);

// 3. Open it and read every slide's meta line.
if (pick.row) {
  await visit("dark", `#bundle-${pick.row.sid}`);
  const metas = await evaluate(`[...document.querySelectorAll("#bv-track > *")].map((s) => s.querySelector(".bv-meta")?.textContent || "")`);
  const open = await evaluate(`!document.getElementById("bv").hidden`);
  check(open && metas.length === pick.row.ids.length, `#bundle-${pick.row.sid} opens ${metas.length} slides`);
  const right = pick.row.ids.map((id, i) => {
    const want = WORDS[pick.locality[id]] || "";
    const words = metas[i].split(" · ");
    return want ? words.includes(want) : !Object.values(WORDS).some((w) => words.includes(w));
  });
  metas.forEach((t, i) => console.log(`  slide ${i + 1}: ${pick.locality[pick.row.ids[i]] || "(none)"} -> "${t}"`));
  check(right.every(Boolean), "every slide names its own tier, and an unlabeled one names none");
  await shot("b4-slide1-dark.png");
  const second = pick.row.labels.findIndex((l, i) => l && l !== pick.row.labels.find(Boolean));
  await evaluate(`document.getElementById("bv-tab-${second}").click()`);
  await sleep(900);
  await shot("b4-slide-other-tier-dark.png");
  await visit("light", `#bundle-${pick.row.sid}`);
  await shot("b4-slide1-light.png");
}

check(errors.length === 0, `no page errors (${errors.length}) ${errors.slice(0, 2).join(" | ")}`);
chrome.close();
site.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);
