// W1 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/w1_check.mjs [<screenshot dir>]
// The owner: "what would it take to have free text interests?", then "i would want the
// free text interest to match things that aren't already on my phone, so maybe a mix of
// 1 and 2", and "how do i add or remove more standing stories too". This builds the app
// from a small pool made here and serves it behind an Access-like gate: every request
// without the CF_Authorization cookie gets a 302 to a login origin, the build's own
// _headers ride on every static answer, and /api/interests runs the real Pages Function
// (functions/api/interests.js) with a memory KV, the gate adding a signed Access JWT the
// way Cloudflare Access does. Headless Chrome as a Galaxy S23 (360x780, DPR 3, dark):
//   1. You > Add interest > type a phrase: the "Follow a phrase" row names it; a tap
//      adds it as one version, listed in quotes at Normal, with a toast and Undo.
//   2. Its own page: the level words, a Phrase section; More is one more version.
//   3. The sync: the phone PUTs {"v":1,"queries":[...]} through the gate (cookie and
//      JWT), the function stores it under the hashed email, and GET returns it.
//   4. Today re-ranks on the device: the headline match, the dek match (a plural) and
//      the watch-tag match lead the page; the decoy (the words out of order) does not.
//   5. Why this on the dek match names the phrase.
//   6. Follow this story from a cluster's menu: the form is prefilled from its
//      headlines, Follow saves one version, and the sync sends the new story's search.
//   7. You > Add standing story: a name and keywords, one version.
//   8. The followed story's page: Remove standing story, back on the list, Undo
//      restores it exactly; one version each.
//   9. Offline: a phrase added offline is not sent; back online, it is.
// Every request the phone made carried the cookie (none met the login redirect), CLS 0
// and zero CSP violations throughout, no console errors, apart from the web app
// manifest's own cookieless fetch, which predates W1 (queued as H4) and is counted on
// its own. Screenshots in dark and light.
// Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_INPUT, launch, parseHeaders, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { handle, userKey } from "../../functions/api/interests.js";
import { phraseQuery, watchTagSync } from "../../app/static/js/phrase.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(tmpdir(), "almanac-w1-check");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const EMAIL = "reader@example.com";
const TEAM = "team.example.cloudflareaccess.com";
const AUD = "w1-proof-audience";
// Made up for the proof; the owner's own phrases never reach the repo.
const PHRASE = "sodium battery";
const TAG = watchTagSync(phraseQuery(PHRASE));
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

// --- The pool: world fillers, three phrase matches (headline, dek plural, watch tag), a
// decoy with the words out of order, and a two-outlet Sudan cluster to follow. ---
function w1Pool() {
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
      art("p1", "npr", 6, "Sodium battery plant opens in Texas", ["economy"], "The factory will make cells for grid storage."),
      art("p2", "bbc", 6, "Grid storage makers expand", ["economy"], "New sodium batteries promise cheaper storage for utilities."),
      art("p3", "npr", 6, "Utilities sign a storage deal", ["economy"], "The deal covers three states and two ports.", { watch: [TAG] }),
      art("p4", "bbc", 6, "Battery of tests finds sodium levels too high", ["economy"], "Regulators want food labels changed."),
      art("c1a", "bbc", 9, "Army retakes El Fasher airport from RSF", ["conflict"], "Fighting moved to the city's east."),
      art("c1b", "npr", 10, "RSF withdraws from El Fasher as Sudan army advances", ["conflict"], "Aid groups ask for safe passage."),
    ],
    clusters: [{ id: "c1", method: "cosine_entity", article_ids: ["c1a", "c1b"], near_duplicates: [], independent_sources: 2, lean_buckets: ["center"] }],
    counts: { fetched: 26, published: 26, drops: {}, leniency: {} },
  };
}

function build() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const poolPath = join(TMP, "w1_pool.json");
  writeFileSync(poolPath, JSON.stringify(w1Pool()));
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
const chrome = await launch("w1-check");
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
// 0. A clean phone: open Today, then You, with nothing stored. Cleared from a blank
// page, not from inside the app: a live Today page can write its read history back
// after an in-page localStorage.clear(), and that history alone re-ranks the next load.
await send("Page.navigate", { url: "about:blank" });
await sleep(200);
await send("Storage.clearDataForOrigin", { origin: site.origin, storageTypes: "local_storage,indexeddb" });
await open("/");
const before = await json(`[...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid)`);
await open("/profile");
const v0 = await versions();

// 1. Add interest > type the phrase > the phrase row names it > tap: one version.
await tap("#add-interest-row");
const sheet0 = await json(`({ open: !document.getElementById("sheet-root").hidden, title: document.getElementById("sheet-label").textContent,
  row: document.querySelector("#follow-phrase-row .setting-label")?.textContent, sub: document.querySelector("#follow-phrase-row .setting-sublabel")?.textContent,
  placeholder: document.querySelector("#sheet-body .search-field")?.placeholder })`);
check("add_sheet_offers_follow_a_phrase", sheet0.open && sheet0.title === "Add interest" && sheet0.row === "Follow a phrase" && /phrase/.test(sheet0.placeholder), sheet0);
await type("#sheet-body .search-field", PHRASE);
const typed = await json(`({ row: document.querySelector("#follow-phrase-row .setting-label").textContent,
  sub: document.querySelector("#follow-phrase-row .setting-sublabel").textContent, state: document.getElementById("follow-phrase-row").dataset.state })`);
check("phrase_row_names_what_was_typed", typed.row === `Follow “${PHRASE}”` && typed.state === "ok", typed);
await shot("add-sheet-phrase-dark.png");
await scheme("light");
await sleep(250);
await shot("add-sheet-phrase-light.png");
await scheme("dark");
await tap("#follow-phrase-row");
await sleep(300);
const added = await json(`({ sheetOpen: !document.getElementById("sheet-root").hidden,
  row: (() => { const a = document.querySelector('#topics-list a[data-topic="p_sodium_battery"]'); return a && { label: a.querySelector(".setting-label").textContent, value: a.querySelector(".setting-value").textContent }; })() })`);
const addToast = await toast();
const v1 = await versions();
check("phrase_added_as_one_version_listed_in_quotes", !added.sheetOpen && added.row?.label === `“${PHRASE}”` && added.row?.value === "Normal"
  && v1 === v0 + 1 && addToast.text === `Following “${PHRASE}”` && addToast.undo, { added, addToast, v0, v1 });
await evaluate(`document.getElementById("toast").hidden = true`);
await shot("you-dark.png");
await scheme("light");
await sleep(250);
await shot("you-light.png");
await scheme("dark");

// 2. Its own page: level words and the Phrase section; More is one more version.
await tap('#topics-list a[data-topic="p_sodium_battery"]');
const page = await json(`({ hash: location.hash, title: document.getElementById("page-title").textContent,
  labels: [...document.querySelectorAll("#settings-root .settings-label")].map((h) => h.textContent),
  how: document.getElementById("phrase-how")?.textContent, remove: !!document.querySelector('[data-focus-key="remove-interest"]'),
  mute: !!document.querySelector('[data-focus-key="mute"]') })`);
check("phrase_page_has_level_phrase_tuning_and_remove", page.hash === "#interest/p_sodium_battery" && page.title === `“${PHRASE}”`
  && ["Level", "Phrase", "Fine tuning"].every((l) => page.labels.includes(l)) && page.remove && !page.mute && /in this order/.test(page.how || ""), page);
await tap('[data-focus-key="level-more"]');
const v2 = await versions();
const more = (await profileNow()).topics.p_sodium_battery;
check("level_more_is_one_version", v2 === v1 + 1 && more.affinity === 0.9 && more.enabled === true, { v2, more });
await evaluate(`document.getElementById("toast").hidden = true`);
await shot("phrase-page-dark.png");

// 3. The sync reached the function through the gate, and GET returns the caller's value.
const synced = await waitKv((v) => v && v.queries.some((q) => q.q === `"${PHRASE}"`));
const value = stored();
const got = await json(`fetch("/api/interests", { credentials: "same-origin" }).then((r) => r.json())`);
const puts = site.log.filter((e) => e.path === "/api/interests" && e.method === "PUT");
check("sync_puts_the_contract_shape_and_get_returns_it", synced && value.v === 1 && Object.keys(value).join() === "v,queries"
  && value.queries.length === 3 && value.queries[0].tag === TAG && value.queries.every((q) => /^w:[0-9a-f]{10}$/.test(q.tag) && q.q.length <= 100)
  && JSON.stringify(got) === JSON.stringify(value) && puts.length >= 1 && puts.every((e) => e.cookie && e.status === 200),
  { value, puts: puts.length, kvKeys: [...kvMap.keys()] });

// 4. Today re-ranks on the device: the three matches lead, the decoy does not.
await open("/");
const today = await json(`(async () => {
  const { rankPages, pageOptions } = await import("/js/passes.js");
  const { summaryToHistory } = await import("/js/history/summary.js");
  const { seenPenaltyTerm } = await import("/js/history/penalty.js");
  const input = ${PAGE_INPUT};
  const order = [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid);
  // The page's own re-rank (rerank.js): this profile, and the read history's seen term.
  const terms = [seenPenaltyTerm(summaryToHistory(window.almanacHistorySummary || {}))];
  const pages = rankPages(input.pool, window.almanacProfile, input.now, pageOptions(input, { terms }));
  const matched = Object.fromEntries(pages.today.filter((s) => ["p1", "p2", "p3", "p4"].includes(s.id)).map((s) => [s.id, s.topics_matched]));
  return { order, ranked: pages.today.map((s) => s.id), matched, hasPhrase: !!window.almanacProfile?.topics?.p_sodium_battery };
})()`);
const pos = (id, list) => list.indexOf(id);
check("today_ranks_the_phrase_matches_first", today.hasPhrase && JSON.stringify(today.order) === JSON.stringify(today.ranked)
  && ["p1", "p2", "p3"].every((id) => pos(id, today.order) >= 0 && pos(id, today.order) < 3 && today.matched[id]?.includes("p_sodium_battery"))
  && !today.matched.p4?.includes("p_sodium_battery") && pos("p4", today.order) > 10
  && ["p1", "p2", "p3"].every((id) => pos(id, before) > 10), { before: before.slice(0, 6), order: today.order.slice(0, 6), matched: today.matched });
await shot("today-dark.png");

// 5. Why this on the dek match names the phrase.
await tap('#section-today li.story[data-sid="p2"] .story-overflow');
const menu = await json(`[...document.querySelectorAll("#sheet-body .sheet-item")].filter((b) => !b.hidden).map((b) => b.textContent)`);
await tap('#sheet-body .sheet-item[data-action="why"]');
await waitFor(`document.getElementById("sheet-label").textContent === "Why this" && !document.getElementById("sheet-root").hidden`);
await sleep(300);
const why = await json(`[...document.querySelectorAll("#sheet-body .why-row-label")].map((s) => s.textContent)`);
check("why_this_names_the_phrase", why.includes(`Your phrase “${PHRASE}”`) && menu.includes("Follow this story"), { why, menu });
await shot("why-this-dark.png");
await evaluate("history.back()");
await sleep(500);

// 6. Follow this story from the Sudan cluster's menu: prefilled, one version, synced.
const vf0 = await versions();
await tap('#section-today li.story[data-sid="c1"] .story-overflow');
await tap('#sheet-body .sheet-item[data-action="follow"]');
await waitFor(`document.getElementById("sheet-label").textContent === "Follow this story" && !!document.getElementById("standing-name")`);
await sleep(300);
const prefill = await json(`({ name: document.getElementById("standing-name").value, keywords: document.getElementById("standing-keywords").value })`);
check("follow_form_is_prefilled_from_the_headlines", prefill.name === "El Fasher" && /^el fasher, rsf, sudan/.test(prefill.keywords), prefill);
await shot("follow-sheet-dark.png");
await scheme("light");
await sleep(250);
await shot("follow-sheet-light.png");
await scheme("dark");
await tap("#sheet-body .sheet-submit");
await sleep(300);
const followed = await profileNow();
const followToast = await toast();
const story = followed.standing_stories.find((s) => s.id === "el_fasher");
check("follow_saves_one_version", (await versions()) === vf0 + 1 && story && story.enabled && story.floor_slots === 1 && story.silence_hours === 24
  && followToast.text === "Following El Fasher" && followToast.undo, { story, followToast });
const followSynced = await waitKv((v) => v && v.queries.some((q) => q.q.startsWith("\"el fasher\" OR \"rsf\"")));
check("follow_is_synced", followSynced, { queries: stored()?.queries.map((q) => q.q.slice(0, 30)) });

// 7. You > Add standing story: a name and keywords, one version.
await open("/profile");
const va = await versions();
await tap("#add-standing-row");
await waitFor(`document.getElementById("sheet-label").textContent === "Add standing story" && !!document.getElementById("standing-name")`);
await type("#standing-name", "Rail strike");
await type("#standing-keywords", "rail strike, train drivers");
await shot("standing-sheet-dark.png");
await tap("#sheet-body .sheet-submit");
await sleep(300);
const listed = await json(`[...document.querySelectorAll("#standing-list a.setting-row")].map((a) => a.dataset.story)`);
check("add_standing_story_is_one_version", (await versions()) === va + 1 && listed.join() === "israel_gaza,sudan,el_fasher,rail_strike"
  && (await toast()).text === "Following Rail strike", { listed });
await evaluate(`document.getElementById("toast").hidden = true`);

// 8. Remove the followed story from its page; Undo restores it exactly.
await tap('#standing-list a[data-story="el_fasher"]');
const storyPage = await json(`({ hash: location.hash, title: document.getElementById("page-title").textContent, remove: !!document.querySelector('[data-focus-key="remove-story"]') })`);
await shot("story-page-dark.png");
const snapshot = JSON.stringify((await profileNow()).standing_stories);
const vr = await versions();
await tap('[data-focus-key="remove-story"]');
const removed = await json(`({ view: document.getElementById("settings-root").dataset.view, hash: location.hash,
  listed: [...document.querySelectorAll("#standing-list a.setting-row")].map((a) => a.dataset.story) })`);
const removeToast = await toast();
await shot("undo-toast-dark.png");
check("remove_standing_story_returns_to_the_list", storyPage.remove && storyPage.hash === "#story/el_fasher" && removed.view === "you"
  && !removed.listed.includes("el_fasher") && (await versions()) === vr + 1 && removeToast.text === "Removed El Fasher." && removeToast.undo, { storyPage, removed, removeToast });
await tap("#toast-action");
const restored = JSON.stringify((await profileNow()).standing_stories);
check("undo_restores_the_standing_story_exactly", restored === snapshot && (await versions()) === vr + 2, { vr });

// 9. Offline: a phrase added offline is not sent; back online, it is.
await sleep(2500);
const putsBefore = site.log.filter((e) => e.path === "/api/interests" && e.method === "PUT").length;
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(300);
await tap("#add-interest-row");
await type("#sheet-body .search-field", "grid storage");
await tap("#follow-phrase-row");
await sleep(2500);
const offlinePuts = site.log.filter((e) => e.path === "/api/interests" && e.method === "PUT").length - putsBefore;
const offlineValue = stored();
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const later = await waitKv((v) => v && v.queries.some((q) => q.q === "\"grid storage\""));
check("offline_edit_syncs_once_back_online", offlinePuts === 0 && !offlineValue.queries.some((q) => q.q === "\"grid storage\"") && later,
  { offlinePuts, later, queries: stored()?.queries.length });

await tally();
// The web app manifest is fetched without the cookie (its <link> carries no
// crossorigin="use-credentials"), so behind Access it meets the login redirect and the
// CSP's manifest-src reports it. That predates W1 and is queued as H4; it is counted
// apart here, and everything W1 added (the sync's PUT and GET, the new modules) passes.
const H4 = (path) => path === "/manifest.webmanifest";
const loggedOut = site.log.filter((e) => !e.cookie);
check("every_request_carried_the_access_cookie", loggedOut.every((e) => H4(e.path)) && site.log.some((e) => e.path === "/sw.js" && e.cookie),
  { loggedOut: loggedOut.filter((e) => !H4(e.path)).slice(0, 5), manifestRedirectsH4: loggedOut.length, requests: site.log.length });
const final = await profileNow();
const valid = await json(`(async () => {
  const { validateProfile } = await import("/js/profile/validate.js");
  const schema = await fetch("/profile.schema.json").then((r) => r.json());
  return validateProfile(JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile, schema);
})()`);
check("final_profile_validates_clean", Array.isArray(valid) && valid.length === 0 && final.topics.p_grid_storage, { valid });
check("cls_zero", totalCls === 0, { totalCls });
const cspW1 = cspSeen.filter((v) => !/manifest-src \S+\/manifest\.webmanifest$/.test(v));
check("csp_zero", cspW1.length === 0, { cspW1, manifestSrcReportsH4: cspSeen.length - cspW1.length });
check("cls_detail", clsSeen.length === 0, { clsSeen });
check("no_console_errors", errors.length === 0, { errors });

chrome.close();
site.close();
console.log(JSON.stringify(results, null, 1));
console.log(ok ? "W1 CHECK: PASS" : "W1 CHECK: FAIL");
process.exit(ok ? 0 : 1);
