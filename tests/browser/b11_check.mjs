// B11 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/b11_check.mjs [<screenshot dir>]
// The owner's work watch with invented placeholder rules only. The app is built from a
// small pool made here and served behind the same Access-like gate as the W1 proof (a
// 302 without the cookie, the build's own _headers, the real /api/interests function
// with a memory KV and a signed Access JWT). Headless Chrome as a Galaxy S23 (360x780,
// DPR 3, dark):
//   1. You > Work watch (collapsed, opened with a tap) > name and terms > Add rule: one
//      version, listed under Tier 2.
//   2. The rule's page: Tier 1 and an "Only with" term are one version each.
//   3. The sync PUTs version 2 with the rule and its tag, and GET returns it.
//   4. Today > Biotech: the B10 biotech story and the rule's match are on the tab, the
//      decoy (the term without a pair term) is not, and Why this names the rule's label.
//   5. Reload: the rule, its tier and the Biotech tab are all still there.
// Every request carried the cookie (the manifest's cookieless fetch is H4, counted
// apart), CLS 0, no CSP violations from B11, no console errors. Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_INPUT, launch, parseHeaders, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { handle, userKey } from "../../functions/api/interests.js";
import { workTag } from "../../app/static/js/work-watch.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(tmpdir(), "almanac-b11-check");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const EMAIL = "reader@example.com";
const TEAM = "team.example.cloudflareaccess.com";
const AUD = "b11-proof-audience";
// Invented placeholders; the owner's own rules never reach the repo.
const RULE_NAME = "Zed watch";
const TERM = "zorbium";
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

// --- The pool: world fillers, one B10 biotech-tagged story, a story the placeholder
// rule matches (its term plus a pair term in the dek), and a decoy with the term alone.
function b11Pool() {
  const iso = (hours) => new Date(NOW_MS - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const art = (id, source, hours, title, topics, dek, extra = {}) => ({
    id, source_id: source, url: `https://example.org/${id}`, title, published_at: iso(hours), topics, dek, ...extra,
  });
  const fillers = Array.from({ length: 20 }, (_, i) => art(`f${String(i).padStart(2, "0")}`, i % 2 ? "bbc" : "npr", 8 + i,
    `World filler story number ${i} from a quiet day`, ["world"], `A calm day in world news, part ${i}, with nothing to add.`));
  return {
    schema_version: 1,
    generated_at: new Date(NOW_MS).toISOString().replace(/\.\d+Z$/, "Z"),
    sources: [{ id: "npr", name: "NPR", feed_url: "https://example.org/npr" }, { id: "bbc", name: "BBC", feed_url: "https://example.org/bbc" }],
    articles: [
      ...fillers,
      art("b1", "npr", 5, "Yeast strain makers share a new biomass process", ["biotech", "science"], "A trade group reports on scale."),
      art("z1", "bbc", 7, "Zorbium maker opens its first site", ["economy"], "The new plant doubles regional output."),
      art("z2", "npr", 7, "Zorbium turns up in a cooking contest", ["economy"], "Judges were not impressed by the dish."),
    ],
    clusters: [],
    counts: { fetched: 23, published: 23, drops: {}, leniency: {} },
  };
}

function build() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const poolPath = join(TMP, "b11_pool.json");
  writeFileSync(poolPath, JSON.stringify(b11Pool()));
  const dist = join(TMP, "dist");
  execFileSync(PYTHON, ["-m", "app.build", "--pool", poolPath, "--out", dist], { cwd: ROOT, stdio: "ignore" });
  return dist;
}

// --- The Access team: a key made here signs the JWT the gate adds, like Access. ---
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256" };
async function accessJwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, iat: now, nbf: now, exp: now + 3600 })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// --- The gate: Pages-shaped static answers with the build's _headers, a 302 to a login
// origin without the cookie, and /api/interests through the real function. ---
const kvMap = new Map();
const kv = { get: async (k) => (kvMap.has(k) ? kvMap.get(k) : null), put: async (k, v) => { kvMap.set(k, v); } };
async function gate(dist) {
  const root = resolve(dist);
  const text = readFileSync(join(root, "_headers"), "utf-8");
  const headers = parseHeaders(text);
  const swHeaders = parseHeaders(text, "/sw.js");
  const log = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const cookie = /(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "");
    const entry = { method: req.method, path: pathname, cookie, status: 0 };
    log.push(entry);
    if (!cookie) {
      entry.status = 302;
      res.writeHead(302, { location: `https://${TEAM}/cdn-cgi/access/login/almanac?redirect_url=${encodeURIComponent(pathname)}` }).end();
      return;
    }
    if (pathname === "/api/interests") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const h = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") h.set(k, v);
      h.set("cf-access-jwt-assertion", await accessJwt());
      h.set("cf-access-authenticated-user-email", EMAIL);
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
      const answer = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: h, body }),
        { INTERESTS: kv, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { getKeys: async () => [jwk] });
      entry.status = answer.status;
      res.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
      return;
    }
    const own = { ...headers, ...(pathname === "/sw.js" ? swHeaders : {}) };
    const file = (p) => join(root, p);
    const inRoot = (p) => p.startsWith(root) && existsSync(p) && statSync(p).isFile();
    if (pathname.endsWith(".html") && inRoot(file(pathname))) {
      entry.status = 308;
      res.writeHead(308, { ...own, location: (pathname.endsWith("/index.html") ? pathname.slice(0, -10) : pathname.slice(0, -5)) + url.search }).end();
      return;
    }
    let path = file(pathname.endsWith("/") ? pathname + "index.html" : pathname);
    if (!inRoot(path) && !extname(pathname) && inRoot(file(pathname + ".html"))) path = file(pathname + ".html");
    if (!inRoot(path)) { entry.status = 404; res.writeHead(404, own).end(); return; }
    entry.status = 200;
    res.writeHead(200, { ...own, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() };
}

const dist = build();
const site = await gate(dist);
const chrome = await launch("b11-check");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setUserAgentOverride", { userAgent: UA, platform: "Linux armv8l" });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Network.setCookie", { name: "CF_Authorization", value: "ok", url: site.origin });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0; window.__shifts = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(e.value); } }).observe({ type: "layout-shift", buffered: true });` });

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let totalCls = 0;
const shot = async (name) => {
  if (!SHOTS) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(SHOTS, name), Buffer.from(png, "base64"));
};
const json = async (expr) => JSON.parse(await evaluate(`(async () => JSON.stringify(await (${expr})))()`) ?? "null");
const scheme = (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
async function waitFor(expr, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(120)) {
    try { if (await evaluate(expr)) return true; } catch {}
  }
  return false;
}
/** Adds the page's CLS and CSP counts to the totals before it is left. */
const cspSeen = [];
const clsSeen = [];
async function tally() {
  try {
    const page = await json(`({ url: location.pathname + location.hash, cls: window.__cls ?? 0, shifts: window.__shifts ?? [], csp: window.__csp ?? [] })`);
    totalCls += page.cls;
    if (page.cls) clsSeen.push(page);
    cspSeen.push(...page.csp.map((v) => `${page.url}: ${v}`));
  } catch {}
}
async function open(path) {
  await tally();
  await send("Page.navigate", { url: `${site.origin}${path}` });
  await sleep(300);
  if (path.startsWith("/profile")) await waitFor(`document.getElementById("settings-root")?.getAttribute("aria-busy") !== "true" && document.getElementById("settings-root").childElementCount > 0`);
  else await waitFor(`document.readyState === "complete" && !document.documentElement.classList.contains("rerank")`);
  await sleep(400);
}
/** A real tap (mouse events at the element's center), so layout shift right after it
 * counts as input-driven, as on the phone. */
async function tap(selector) {
  const box = await json(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing to tap: ${selector}`);
  await sleep(150);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(450);
}
async function type(selector, text) {
  await tap(selector);
  await send("Input.insertText", { text });
  await sleep(250);
}
const store = () => json(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`);
const versions = async () => (await store()).history.length;
const profileNow = async () => (await store()).history.at(-1).profile;
const toast = () => json(`({ text: document.getElementById("toast-text").textContent, undo: !document.getElementById("toast-action").hidden, open: !document.getElementById("toast").hidden })`);
const key = await userKey(EMAIL);
const stored = () => (kvMap.has(key) ? JSON.parse(kvMap.get(key)) : null);
async function waitKv(pred, ms = 9000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (pred(stored())) return true;
  return false;
}

await scheme("dark");
await send("Page.navigate", { url: "about:blank" });
await sleep(200);
await send("Storage.clearDataForOrigin", { origin: site.origin, storageTypes: "local_storage,indexeddb" });
await open("/");
await open("/profile");
const v0 = await versions();

// 1. The Work watch group: collapsed, opened by a tap, a rule added.
const closed = await json(`({ exists: !!document.getElementById("work"), open: document.getElementById("work")?.open })`);
await tap("#work > summary");
const opened = await json(`document.getElementById("work").open`);
await shot("work-group-empty-dark.png");
await type("#work-new-name", RULE_NAME);
await type("#work-new-terms", `${TERM}, blue quill`);
await tap("#work-add");
await sleep(300);
const listed = await json(`({ open: document.getElementById("work").open,
  tiers: [...document.querySelectorAll("#work .work-tier")].map((h) => h.textContent),
  rows: [...document.querySelectorAll("#work a[data-work]")].map((a) => ({ id: a.dataset.work, label: a.querySelector(".setting-label").textContent, sub: a.querySelector(".setting-sublabel").textContent })) })`);
const addToast = await toast();
check("work_group_is_collapsed_then_adds_one_rule", closed.exists && !closed.open && opened && listed.open
  && JSON.stringify(listed.tiers) === JSON.stringify(["Tier 2"]) && listed.rows.length === 1 && listed.rows[0].label === RULE_NAME
  && listed.rows[0].sub === "2 terms" && (await versions()) === v0 + 1 && addToast.text === `Added ${RULE_NAME}` && addToast.undo, { closed, opened, listed, addToast });
await evaluate(`document.getElementById("toast").hidden = true`);
await shot("work-group-dark.png");
await scheme("light");
await sleep(250);
await shot("work-group-light.png");
await scheme("dark");

// 2. The rule's page: tier and an "Only with" term, one version each.
const ruleId = listed.rows[0]?.id;
await tap(`#work a[data-work="${ruleId}"]`);
const rulePage = await json(`({ hash: location.hash, title: document.getElementById("page-title").textContent,
  labels: [...document.querySelectorAll("#settings-root .settings-label")].map((h) => h.textContent),
  tiers: [...document.querySelectorAll(".level-option")].map((b) => b.textContent + (b.getAttribute("aria-checked") === "true" ? "*" : "")) })`);
const vt = await versions();
await tap('[data-focus-key="tier-1"]');
await evaluate(`(() => { const t = document.querySelector('[data-focus-key="work-pair"]'); t.value = "plant, output"; t.dispatchEvent(new Event("change")); })()`);
await sleep(400);
const edited = (await profileNow()).work_watch[0];
check("rule_page_edits_tier_and_pair", rulePage.hash === `#work/${ruleId}` && rulePage.title === RULE_NAME
  && ["Name", "Tier", "Terms", "Only with", "Never with"].every((l) => rulePage.labels.includes(l)) && rulePage.tiers.join() === "Tier 1,Tier 2*,Tier 3,Tier 4"
  && (await versions()) === vt + 2 && edited.tier === 1 && edited.pair_any.join() === "plant,output", { rulePage, edited });
await evaluate(`document.getElementById("toast").hidden = true`);
await shot("work-rule-dark.png");
await scheme("light");
await sleep(250);
await shot("work-rule-light.png");
await scheme("dark");

// 3. The sync: version 2 with the rule and its tag, through the gate.
const synced = await waitKv((v) => v && v.v === 2 && v.work?.[0]?.tier === 1 && v.work[0].pair_any.length === 2);
const value = stored();
const got = await json(`fetch("/api/interests", { credentials: "same-origin" }).then((r) => r.json())`);
check("sync_puts_version_2_with_the_rule", synced && value.work.length === 1 && value.work[0].tag === workTag(ruleId)
  && JSON.stringify(got) === JSON.stringify(value), { v: value?.v, rules: value?.work?.length });

// 4. Today > Biotech: the tag story and the rule's match, not the decoy; Why this names the label.
async function biotech() {
  await open("/");
  await tap("#tab-biotech");
  await waitFor(`document.documentElement.dataset.sections === "ready"`);
  await sleep(400);
  return json(`({ ids: [...document.querySelectorAll("#section-biotech li.story[data-sid]")].map((li) => li.dataset.sid),
    selected: document.getElementById("tab-biotech").getAttribute("aria-selected") })`);
}
const tab = await biotech();
check("biotech_tab_shows_the_rule_match", tab.selected === "true" && tab.ids.includes("b1") && tab.ids.includes("z1") && !tab.ids.includes("z2")
  && tab.ids.indexOf("z1") < tab.ids.indexOf("b1"), tab);
await shot("biotech-tab-dark.png");
await scheme("light");
await sleep(250);
await shot("biotech-tab-light.png");
await scheme("dark");
await tap('#section-biotech li.story[data-sid="z1"] .story-overflow');
await tap('#sheet-body .sheet-item[data-action="about"]');
await waitFor(`document.getElementById("sheet-label").textContent === "About this story" && !document.getElementById("sheet-root").hidden`);
await sleep(300);
const why = await json(`[...document.querySelectorAll("#sheet-body .about-why .why-row-label")].map((s) => s.textContent)`);
check("why_this_names_the_rule_label_not_its_terms", why.includes(`Work watch: ${RULE_NAME}`) && !why.join(" ").toLowerCase().includes(TERM), { why });
await shot("why-work-dark.png");
await evaluate("history.back()");
await sleep(500);

// 5. Reload: all of it persists.
await open("/profile");
await tap("#work > summary");
const again = await json(`[...document.querySelectorAll("#work a[data-work]")].map((a) => a.querySelector(".setting-label").textContent)`);
const tiersAgain = await json(`[...document.querySelectorAll("#work .work-tier")].map((h) => h.textContent)`);
const tab2 = await biotech();
check("reload_keeps_the_rule_and_the_tab", again.join() === RULE_NAME && tiersAgain.join() === "Tier 1" && tab2.ids.includes("z1") && !tab2.ids.includes("z2"), { again, tiersAgain, tab2 });

await tally();
const H4 = (path) => path === "/manifest.webmanifest";
const loggedOut = site.log.filter((e) => !e.cookie);
check("every_request_carried_the_access_cookie", loggedOut.every((e) => H4(e.path)), { loggedOut: loggedOut.filter((e) => !H4(e.path)).slice(0, 5) });
const valid = await json(`(async () => {
  const { validateProfile } = await import("/js/profile/validate.js");
  const schema = await fetch("/profile.schema.json").then((r) => r.json());
  return validateProfile(JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile, schema);
})()`);
check("final_profile_validates_clean", Array.isArray(valid) && valid.length === 0, { valid });
check("cls_zero", totalCls === 0, { totalCls, clsSeen });
const cspB11 = cspSeen.filter((v) => !/manifest-src \S+\/manifest\.webmanifest$/.test(v));
check("csp_zero", cspB11.length === 0, { cspB11 });
check("no_console_errors", errors.length === 0, { errors });

chrome.close();
site.close();
console.log(JSON.stringify(results, null, 1));
console.log(ok ? "B11 CHECK: PASS" : "B11 CHECK: FAIL");
process.exit(ok ? 0 : 1);
