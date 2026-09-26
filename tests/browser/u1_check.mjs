// U1 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/u1_check.mjs <built dist dir with bodies/> [<screenshot dir>]
// Serves the built page with its own dist/_headers (the live CSP) in headless Chrome at
// 360x780 CSS px, DPR 3, dark, and checks: every row shows its summary, the "top"
// class hides the rows' but not the hero's or the leads'; at the bottom of every tab
// panel, Following and Saved the last row sits fully above the bottom nav; a row whose
// full text comes from another outlet opens the reader with that outlet's headline and
// its "Full text from" credit. CLS and CSP reports are counted across the whole run.
// Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PAGE_INPUT, launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("u1-check");
const { send, evaluate } = chrome;
if (shotsArg) mkdirSync(shotsArg, { recursive: true });
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__shift = 0; window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true });` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}

await send("Page.navigate", { url: `${site.origin}/index.html` });
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`)) break;
  await sleep(100);
}
await sleep(600);

// A. Summaries on every row.
const rows = await evaluate(`(() => {
  const lis = [...document.querySelectorAll("#section-today li.story")];
  const tier = (li) => li.className.match(/story--([a-z-]+)/)[1];
  const withDek = lis.filter((li) => li.querySelector(".dek")).length;
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((d) => d.getClientRects().length).length;
  const before = { river: visible("#headlines .story--river .dek"), hero: visible(".story--hero .dek") };
  document.documentElement.classList.add("summaries-top");
  const top = { river: visible("#headlines .story--river .dek"), text: visible("#more-list .dek"), hero: visible(".story--hero .dek"), leads: visible(".story--secondary .dek") };
  document.documentElement.classList.remove("summaries-top");
  return { rows: lis.length, withDek, tiers: [...new Set(lis.map(tier))], before, top,
    readHere: document.querySelectorAll("#section-today .meta-read").length,
    clamped: lis.filter((li) => { const d = li.querySelector(".dek"); return d && d.getClientRects().length && d.scrollHeight > d.clientHeight + 1; }).map((li) => tier(li) + ": " + li.querySelector(".dek").textContent) };
})()`);
console.log(JSON.stringify(rows));
check(rows.withDek >= rows.rows * 0.9, `summaries on ${rows.withDek} of ${rows.rows} Today rows`);
check(rows.clamped.length === 0, `fitted summaries never meet the line clamp (${rows.clamped.length} clamped)`);
check(rows.before.river > 0 && rows.top.river === 0 && rows.top.text === 0, "\"top\" hides river and text-only summaries");
check(rows.top.hero === rows.before.hero && rows.top.leads > 0, "\"top\" keeps the hero's and the leads' summaries");
await evaluate(`(() => { const p = document.getElementById("section-today"); const li = document.querySelector("#headlines .story--river"); p.scrollTop = li.offsetTop - 60; })()`);
await sleep(700);
await shot("final-dark.png");

// C. The bottom of every scroller clears the nav.
// H4: scoped to the section tab strip (.tabs-scroll); the Saved screen's segmented
// control (#saved-segment) shares the plain ".tab" class for its own look and was
// matching here too, its two buttons read as a section id of null and crashing the
// next step. A stale test selector, not a product bug: Saved's segment tabs are meant
// to share the styling, just not this list of front-page section panels.
const panels = await evaluate(`[...document.querySelectorAll(".tabs-scroll .tab:not([hidden])")].map((t) => t.dataset.section)`);
for (const id of panels) {
  await evaluate(`document.getElementById("tab-${id}").click()`);
  await sleep(500);
  const r = await evaluate(`(() => {
    const p = document.getElementById("section-${id}");
    p.scrollTop = p.scrollHeight;
    const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
    const items = [...p.querySelectorAll("li.story, .colophon-text, .empty, .more-toggle")].filter((n) => n.getClientRects().length && !n.closest("details:not([open]) > ol"));
    const last = items[items.length - 1];
    const r = last ? last.getBoundingClientRect() : null;
    return { last: last?.className || "", bottom: r ? Math.round(r.bottom) : null, navTop: Math.round(nav.top) };
  })()`);
  await sleep(200);
  check(r.bottom !== null && r.bottom <= r.navTop, `${id}: last (${r.last}) bottom ${r.bottom} <= nav top ${r.navTop}`);
  if (id === "today") await shot("bottom-dark.png");
}
await evaluate(`document.getElementById("tab-today").click()`);
for (const screen of ["following", "saved"]) {
  await evaluate(`document.querySelector('.nav-item[data-screen="${screen}"]').click()`);
  await sleep(400);
  const r = await evaluate(`(() => {
    const v = document.querySelector("#screen-${screen} .view");
    v.scrollTop = v.scrollHeight;
    const kids = [...v.querySelectorAll(".empty-text, li.story")].filter((n) => n.getClientRects().length);
    const last = kids[kids.length - 1];
    return { bottom: last ? Math.round(last.getBoundingClientRect().bottom) : null, navTop: Math.round(document.querySelector(".bottom-nav").getBoundingClientRect().top),
      pad: getComputedStyle(v).paddingBottom };
  })()`);
  check(r.bottom !== null && r.bottom <= r.navTop && parseFloat(r.pad) >= 80, `${screen}: last bottom ${r.bottom} <= nav top ${r.navTop}, padding ${r.pad}`);
}
await evaluate(`document.querySelector('.nav-item[data-screen="home"]').click()`);
await sleep(400);

// B. A row whose full text comes from another outlet.
const pick = await evaluate(`(() => {
  const data = ${PAGE_INPUT};
  const leads = new Map((data.pool.clusters || []).map((c) => [c.id, c.lead]));
  const counts = { before: 0, after: 0, topBefore: 0, topAfter: 0 };
  let target = null;
  for (const li of document.querySelectorAll("#section-today li.story")) {
    const link = li.querySelector("a.story-link[data-body]");
    const lead = leads.get(li.dataset.sid) || li.dataset.sid;
    const top = !!li.closest("#headlines, #more-list");
    const leadHasBody = (data.bodies[li.dataset.sid] || []).some((c) => c[0] === lead);
    if (leadHasBody) { counts.before++; if (top) counts.topBefore++; }
    if (link) { counts.after++; if (top) counts.topAfter++; }
    if (link && link.dataset.body !== lead && !target) target = li.dataset.sid;
  }
  return { target, counts };
})()`);
console.log(JSON.stringify(pick));
check(!!pick.target, "a row opens another outlet's full text");
if (pick.target) {
  await evaluate(`(() => { const li = document.querySelector('#section-today li.story[data-sid="${pick.target}"]');
    document.getElementById("section-today").scrollTop = li.offsetTop - 100; li.querySelector("a.story-link").click(); })()`);
  await sleep(1500);
  const reader = await evaluate(`(() => ({ open: !document.getElementById("reader").hidden,
    via: document.querySelector(".reader-via")?.textContent || "", title: document.getElementById("reader-title")?.textContent || "",
    card: document.querySelector('#section-today li.story[data-sid="${pick.target}"] .headline').textContent,
    body: document.querySelectorAll(".reader-body p").length }))()`);
  console.log(JSON.stringify(reader));
  check(reader.open && /^Full text from \S/.test(reader.via), `reader credit: "${reader.via}"`);
  check(reader.title && reader.title !== reader.card, "reader shows the member's own headline");
  check(reader.body > 0, `reader body paragraphs ${reader.body}`);
  await shot("reader-credit-dark.png");
}

const cls = await evaluate("window.__shift");
const csp = await evaluate("window.__csp");
check(cls === 0, `CLS ${cls}`);
check(csp.length === 0, `CSP violations ${csp.length} ${csp.slice(0, 3).join(" | ")}`);
chrome.close();
site.close();
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
