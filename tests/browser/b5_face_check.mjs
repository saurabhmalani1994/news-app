// B5 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/b5_face_check.mjs <built dist dir> [<screenshot dir>]
//
// Serves the build behind a simulated Cloudflare Access gate with its own _headers
// (cdp.mjs serve), to headless Chrome as a phone (360x780 CSS px, DPR 3). Any fresh
// real pool's dist will do: the rows it checks are picked from the page's own input.
//   1. The gate: without the cookie, the page and pool.json get the Access redirect.
//   2. Default profile: every scored Today row is drawn with its best version (the
//      cluster's embedded lead, versions.js faceOf), its carousel's first slide names the
//      same outlet and headline, "Read here" opens the face when it has full text, and
//      the Today order equals passes.js rankPages on the page's own input (R2).
//   3. A close pick: trusting the runner-up's outlet at 1.5 re-fronts the row before
//      first paint (headline, outlet, marker, data-face), the carousel and "Read here"
//      follow, the order still equals rankPages, CLS 0, and the why-this sheet opens
//      with "Leads because" naming trust, its terms summing to the score shown.
//   4. Fox muted: no Fox-only story renders on any tab, a bundle Fox fronted is
//      re-fronted by its best unmuted version, and Fox is absent from every carousel and
//      from "N sources"; CLS 0.
// Screenshots (dark and light): the re-fronted row, and the "Leads because" sheet.
// Exits 1 on failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { ACCESS_COOKIE, launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const DIST = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(DIST, "_headers"), "utf-8"));
const site = await serve(DIST, headers);
if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

// 1. The gate.
for (const path of ["/", "/pool.json"]) {
  const r = await fetch(site.origin + path, { redirect: "manual" });
  check(r.status === 302 && /cloudflareaccess\.com/.test(r.headers.get("location") || ""), `unauthenticated ${path} gets the Access redirect (${r.status})`);
}

const chrome = await launch("b5-face");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCookie", { ...ACCESS_COOKIE, url: `${site.origin}/` });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__cls = 0; window.__csp = []; window.__first = null;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  // The first frame the headlines are shown: the watched row's headline and outlet then.
  const probe = () => {
    const sid = sessionStorage.getItem("b5.watch");
    const li = sid && document.querySelector('#section-today li.story[data-sid="' + sid + '"]');
    if (!li || document.documentElement.classList.contains("rerank")) { requestAnimationFrame(probe); return; }
    window.__first = { headline: li.querySelector(".headline").textContent, source: li.querySelector(".meta-source")?.textContent || "" };
  };
  requestAnimationFrame(probe);` });

function store(edit) {
  const base = buildDefaultProfile("2026-09-24T00:00:00Z");
  if (!edit) return null;
  const next = structuredClone(base);
  edit(next);
  return { history: [{ version: 1, timestamp: base.updated_at, profile: base },
    { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...next, profile_version: 2 } }] };
}

const csp = [];
async function visit(stored, scheme = "dark", watch = "") {
  csp.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}/` });
  await sleep(500);
  await evaluate(`localStorage.clear(); sessionStorage.setItem("b5.watch", ${JSON.stringify(watch)});
    ${stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : ""}`);
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`).catch(() => false)) break;
    await sleep(100);
  }
  await sleep(700);
}
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

// The page's own modules, loaded with the page's own version query, and what the page
// shows against what they compute for `profile`.
const STATE = (profileJson) => `(async () => {
  const src = document.querySelector('script[src*="js/versions-view.js"]').getAttribute("src");
  const q = src.includes("?") ? "?" + src.split("?")[1] : "";
  const V = await import("./js/versions.js" + q);
  const P = await import("./js/passes.js" + q);
  const T = await import("./js/tiers.js" + q);
  const R = await import("./js/reader/core.js" + q);
  const profile = ${profileJson};
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const ctx = V.versionsContext(input);
  const muted = profile.mutes.sources || [], trust = profile.trust || {};
  const pages = P.rankPages(input.pool, profile, input.now, P.pageOptions(input));
  const byId = new Map(input.pool.articles.map((a) => [a.id, a]));
  const fold = (s) => (s || "").replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201c\\u201d]/g, '"');
  const rows = [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => {
    const sid = li.dataset.sid, c = ctx.clusters.get(sid);
    const scored = !!c && V.isScored(c, ctx);
    const face = pages.faces[sid] || sid;
    const slides = c ? V.buildVersions(c, ctx, { leadId: V.faceOf(c, ctx, { muted, trust }), muted, trust }) : [];
    const link = li.querySelector(".story-link");
    const want = input.fronts?.[face];
    return { sid, scored, face, lead: c?.lead || sid, dataFace: li.dataset.face || null,
      headline: li.querySelector(".headline").textContent, source: li.querySelector(".meta-source")?.textContent || "",
      wantHeadline: want?.t ?? null, wantSource: input.names[byId.get(face)?.source_id] || "",
      slides: slides.map((s) => ({ id: s.id, source: s.sourceId, name: s.sourceName, headline: fold(s.headline), score: V.versionScore(s, { trust }).score, base: V.versionScore(s).score })),
      body: link?.dataset.body || null, wantBody: input.bodies?.[sid] && li.querySelector(".meta-read") ? R.readChoice(input.bodies[sid], face, trust)?.id : null,
      count: li.querySelector(".meta-count")?.textContent || "", wantCount: c ? T.visibleSourceCount(c, byId, muted) : 1,
      marker: li.querySelector(".meta-line .lean")?.className || null, lean: input.leans[byId.get(face)?.source_id] || null };
  });
  const everywhere = [...document.querySelectorAll("li.story[data-sid]")].map((li) => li.dataset.sid);
  return { rows, order: rows.map((r) => r.sid), want: pages.today.map((s) => s.id), everywhere, cls: window.__cls, first: window.__first,
    sourcesOf: Object.fromEntries(input.pool.clusters.map((c) => [c.id, [...new Set(c.article_ids.map((id) => byId.get(id)?.source_id))]])),
    singles: input.pool.articles.filter((a) => !input.pool.clusters.some((c) => c.article_ids.includes(a.id))).map((a) => [a.id, a.source_id]) };
})()`;

const defaultProfile = buildDefaultProfile("2026-09-24T00:00:00Z");
const rowOk = (r) => r.headline === r.wantHeadline && r.source === r.wantSource;

// 2. Default profile.
await visit(null, "dark");
const base = await evaluate(STATE(JSON.stringify(defaultProfile)));
const scored = base.rows.filter((r) => r.scored);
check(scored.length > 0, `${scored.length} scored rows on Today`);
check(scored.every((r) => r.face === r.lead && !r.dataFace), "default profile: every scored row's face is the build's (no re-front)");
check(scored.every(rowOk), `every scored row shows its best version's headline and outlet (${scored.filter(rowOk).length}/${scored.length})`);
check(scored.every((r) => r.slides[0]?.id === r.face), "every scored row's carousel leads with the row's own version");
check(base.rows.every((r) => r.wantBody === null || r.body === r.wantBody), "every Read here row opens the build's pick with the face as its lead");
check(JSON.stringify(base.order) === JSON.stringify(base.want), `Today's order equals rankPages on the page's own input (${base.order.length} rows)`);

async function carouselLead(sid) {
  await evaluate(`location.hash = "#bundle-${sid}"`);
  await sleep(900);
  const out = await evaluate(`(() => { const s = document.getElementById("bv-slide-0");
    return s ? { label: s.getAttribute("aria-label"), headline: s.querySelector(".bv-headline").textContent } : null; })()`);
  await evaluate("history.back()");
  await sleep(700);
  return out;
}
const fold = (s) => (s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const sample = scored.filter((r) => r.slides.length > 1).slice(0, 3);
for (const r of sample) {
  const lead = await carouselLead(r.sid);
  check(lead && lead.label.endsWith(`: ${r.source}`) && fold(lead.headline) === fold(r.headline),
    `the carousel of ${r.sid} opens on the row's own version (${lead?.label})`);
}

// 3. A close pick: the runner-up (another outlet) passes the face at trust 1.5.
const close = scored.map((r) => {
  const face = r.slides[0];
  const next = r.slides.slice(1).find((s) => s.source !== face?.source && s.base > 0 && s.base * 1.5 > face.score + 0.5
    && !r.slides.some((o) => o.source === s.source && o.id !== s.id && o.base * 1.5 > s.base * 1.5));
  return next ? { row: r, next } : null;
}).filter(Boolean).sort((a, b) => (b.next.source === "npr") - (a.next.source === "npr") || (a.row.slides[0].score - a.next.base) - (b.row.slides[0].score - b.next.base))[0];
check(!!close, `a close pick exists on Today (${close?.row.sid}: ${close?.row.slides[0].name} ${close?.row.slides[0].score} vs ${close?.next.name} ${close?.next.base})`);
if (close) {
  const trusted = store((p) => { p.trust = { [close.next.source]: 1.5 }; });
  await visit(trusted, "dark", close.row.sid);
  const s = await evaluate(STATE(JSON.stringify(trusted.history[1].profile)));
  const row = s.rows.find((r) => r.sid === close.row.sid);
  check(row && row.face === close.next.id && row.dataFace === close.next.id && rowOk(row),
    `trust ${close.next.name} x1.5 re-fronts ${close.row.sid}: "${row?.headline}" (${row?.source})`);
  check(s.first && s.first.headline === row.headline && s.first.source === row.source, `the first shown frame already shows it ("${s.first?.source}")`);
  check((row.lean ? row.marker === `lean lean--${row.lean}` || row.marker === "lean lean--country" : true), `its lean marker follows the outlet (${row.marker})`);
  check(row.wantBody === null || row.body === row.wantBody, `"Read here" follows the face (${row.body})`);
  check(s.rows.filter((r) => r.scored).every(rowOk), "every scored row shows its face for this profile");
  check(JSON.stringify(s.order) === JSON.stringify(s.want), "Today's order equals rankPages for this profile");
  check(s.cls === 0, `CLS 0 with a re-fronted row (${s.cls})`);
  const lead = await carouselLead(close.row.sid);
  check(lead && lead.label.endsWith(`: ${close.next.name}`), `its carousel now opens on ${close.next.name} (${lead?.label})`);

  // The re-fronted row, then its why-this sheet.
  await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${close.row.sid}"]');
    document.getElementById("section-today").scrollTop = Math.max(0, li.offsetTop - 160); })()`);
  await sleep(500);
  await shot("b5-row-refronted-dark.png");
  await evaluate("window.__cls = 0");
  await evaluate(`document.querySelector('#section-today li.story[data-sid="${close.row.sid}"] .story-overflow').click()`);
  await sleep(450);
  await evaluate(`document.querySelector('.sheet-item[data-action="why"]').click()`);
  await sleep(1000);
  const sheet = await evaluate(`(() => ({
    because: document.querySelector(".why-lead-because")?.textContent || "",
    rows: [...document.querySelectorAll(".why-lead-row")].map((r) => [r.querySelector(".why-lead-row-label").textContent, r.querySelector(".why-lead-row-value").textContent]),
    total: document.querySelector(".why-lead-total span:last-child")?.textContent || "",
    ranking: document.querySelector(".why-total span:last-child")?.textContent || "" }))()`);
  const signed = (t) => (t.startsWith("−") ? -1 : 1) * Number(t.slice(1));
  const sum = sheet.rows.reduce((a, [, v]) => a + signed(v), 0);
  console.log(`  ${sheet.because}; ${sheet.rows.map(([l, v]) => `${l} ${v}`).join(", ")}; score ${sheet.total}`);
  check(sheet.because.startsWith("Leads because: ") && sheet.because.includes(`your trust in ${close.next.name}`), "the sheet opens with Leads because, naming trust");
  check(sheet.rows.some(([l]) => l === `Trust, ×1.5 for ${close.next.name}`), "the term list names trust");
  check(sheet.rows.length > 0 && sum === signed(sheet.total), `the listed terms sum to the score (${sum} = ${sheet.total})`);
  check(sheet.ranking !== "", "the ranking terms still follow");
  check((await evaluate("window.__cls")) === 0, "CLS 0 opening the sheet");
  await shot("b5-leads-because-dark.png");
  await visit(trusted, "light", close.row.sid);
  await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${close.row.sid}"]');
    document.getElementById("section-today").scrollTop = Math.max(0, li.offsetTop - 160); })()`);
  await sleep(500);
  await shot("b5-row-refronted-light.png");
  await evaluate(`document.querySelector('#section-today li.story[data-sid="${close.row.sid}"] .story-overflow').click()`);
  await sleep(450);
  await evaluate(`document.querySelector('.sheet-item[data-action="why"]').click()`);
  await sleep(1000);
  await shot("b5-leads-because-light.png");
}

// 4. Fox muted.
const FOX = Object.keys(JSON.parse(await evaluate(`JSON.stringify(JSON.parse(document.getElementById("rank-input").content.textContent).names)`))).filter((id) => id.startsWith("fox"));
const foxMuted = store((p) => { p.mutes.sources = FOX; });
const foxFaced = scored.filter((r) => FOX.includes(r.slides[0]?.source) && r.slides.some((x) => !FOX.includes(x.source)));
await visit(foxMuted, "dark", foxFaced[0]?.sid || "");
const m = await evaluate(STATE(JSON.stringify(foxMuted.history[1].profile)));
const foxOnly = [...Object.entries(m.sourcesOf).filter(([, s]) => s.every((x) => FOX.includes(x))).map(([id]) => id),
  ...m.singles.filter(([, s]) => FOX.includes(s)).map(([id]) => id)];
check(foxOnly.length > 0 && foxOnly.every((id) => !m.everywhere.includes(id)), `with Fox muted (${FOX.join(", ")}), none of ${foxOnly.length} Fox-only stories renders on any tab`);
const withFox = m.rows.filter((r) => r.scored && (m.sourcesOf[r.sid] || []).some((x) => FOX.includes(x)));
check(withFox.length > 0 && withFox.every((r) => !FOX.includes(r.slides[0]?.source) && r.slides.every((x) => !FOX.includes(x.source))),
  `Fox is absent from all ${withFox.length} carousels that had it`);
check(withFox.every((r) => (r.wantCount > 1 ? r.count === `${r.wantCount} sources` : r.count === "")), "and from every row's \"N sources\"");
for (const r of foxFaced) {
  const now = m.rows.find((x) => x.sid === r.sid);
  check(now && rowOk(now) && !FOX.includes(now.slides[0]?.source), `${r.sid}, fronted by ${r.slides[0].name} by default, now leads with ${now?.source}`);
}
check(m.rows.every((r) => !r.scored || rowOk(r)), "every scored row shows its face for this profile");
check(JSON.stringify(m.order) === JSON.stringify(m.want), "Today's order equals rankPages with Fox muted");
check(m.cls === 0, `CLS 0 with Fox muted (${m.cls})`);

csp.push(...((await evaluate("window.__csp || []").catch(() => [])) || []));
check(csp.length === 0, `no CSP violations (${csp.slice(0, 2).join(" | ")})`);
check(errors.length === 0, `no page errors (${errors.length}) ${errors.slice(0, 2).join(" | ")}`);
chrome.close();
site.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);
