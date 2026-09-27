// S29 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   python -m app.build --pool tests/fixtures/golden_pool.json --out /tmp/dist_s29
//   node tests/browser/s29_check.mjs /tmp/dist_s29 [<screenshot dir>]
//
// Serves the built site behind the simulated Cloudflare Access gate with the build's
// own _headers (cdp.mjs serve/launch, as every proof here). Seeds the device's own
// history (opened and shown, almanac-history) and thumbs (almanac-actions) straight
// into IndexedDB with a week of reading that has clear patterns, computes the expected
// review in Node with the very same module (weekly/review.js) over the same records,
// and checks the You page against it: the quiet row's count, the #weekly view's
// sentences in order, that nothing changes before Accept, Accept saves one new profile
// version through the gate, Skip hides a suggestion and survives a reload, Undo puts
// the old value back as a new version, "Also noticed" starts collapsed. Zero CSP
// violations and zero layout shift. Screenshots (dark and light) in the given directory.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { weeklyReview } from "../../app/static/js/weekly/review.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s29-weekly");
const { send, evaluate } = chrome;
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
` });

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
async function waitFor(expr, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await evaluate(expr)) return true;
  }
  throw new Error(`waitFor timed out after ${ms}ms: ${expr}`);
}
async function open(path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}${path}` });
  await waitFor(`document.readyState === "complete"`);
}
const json = async (expr) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
const profileNow = () => json(`(() => { const h = JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history; return h[h.length - 1].profile; })()`);
const sentences = () => json(`[...document.querySelectorAll(".weekly-item .weekly-sentence")].map((p) => p.textContent)`);

// A week of seeded reading, all within the last six days. The catalog in this build
// knows one source (npr, center-left, US), so the source, lean and country patterns
// land on it and are noticed, never proposed (no boost, no weight).
const DAY_MS = 86_400_000;
const now = Date.now();
const records = [];
const opened = [];
function block(prefix, topics, shown, openedCount, source = "npr") {
  for (let i = 0; i < shown; i++) {
    const r = { id: `${prefix}-${i}`, cluster_id: `${prefix}-${i}`, title: `story ${prefix} ${i}`, source: "NPR", source_id: source,
      url: `https://example.org/${prefix}/${i}`, image: null, topics, article_id: `${prefix}-${i}`, time: new Date(now - (1 + (i % 5)) * DAY_MS).toISOString() };
    records.push(r);
    if (i < openedCount) opened.push({ ...r, time: new Date(now - (1 + (i % 5)) * DAY_MS + 60_000).toISOString() });
  }
}
block("ai", ["ai"], 11, 9);
block("sg", ["singapore"], 10, 9);
block("pol", ["politics"], 14, 1);
block("econ", ["economy"], 10, 8);
block("mix", ["world"], 12, 3, "other");
const thumbs = [0, 1, 2].map((k) => ({ id: `bt-${k}`, direction: "up", topics: ["biotech"], source: "other", lean: null, cluster_size: 1, tab: "today", rank: k + 1, time: new Date(now - DAY_MS).toISOString() }));

const catalog = JSON.parse(readFileSync(join(dist, "source-catalog.json"), "utf-8"));
const sourceInfo = Object.fromEntries(catalog.sources.map((r) => [r.id, { name: r.name, lean: r.lean, country: r.country, bucket: r.bucket }]));
const schemas = {
  profileSchema: JSON.parse(readFileSync(join(dist, "profile.schema.json"), "utf-8")),
  proposalSchema: JSON.parse(readFileSync(join(dist, "proposal.schema.json"), "utf-8")),
};
const expected = weeklyReview({ opened, shown: records, thumbs, profile: buildDefaultProfile("2026-09-20T00:00:00Z"), catalog: sourceInfo, nowMs: now, schemas });

await open("/profile");
await evaluate(`localStorage.clear(); sessionStorage.clear()`);
await evaluate(`(async () => {
  const put = (name, stores, rows) => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" }); };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(Object.keys(rows), "readwrite");
      for (const [store, list] of Object.entries(rows)) { tx.objectStore(store).clear(); for (const r of list) tx.objectStore(store).put(r); }
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(name + " blocked"));
  });
  await put("almanac-history", ["opened", "shown"], { opened: ${JSON.stringify(opened)}, shown: ${JSON.stringify(records)} });
  await put("almanac-actions", ["saves", "thumbs"], { thumbs: ${JSON.stringify(thumbs)} });
  return true;
})()`);

// 1. You: the quiet row carries the count.
await open("/profile");
await waitFor(`document.getElementById("weekly-row")?.querySelector(".setting-value")?.textContent.includes("suggestion")`);
const rowValue = await evaluate(`document.getElementById("weekly-row").querySelector(".setting-value").textContent`);
const n = expected.proposals.length;
check("expected review has proposals and noticed patterns", n >= 3 && expected.noticed.length >= 1, { n, noticed: expected.noticed.length });
check("You row shows the count", rowValue === `${n} suggestions`, { rowValue });
const versionsBefore = await evaluate(`JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history.length`);
await shot("you-dark.png");

// 2. The #weekly view lists the same sentences, in order, and nothing has changed.
await evaluate(`document.getElementById("weekly-row").click()`);
await waitFor(`location.hash === "#weekly" && document.querySelectorAll(".weekly-item").length > 0`);
const listed = await sentences();
check("view lists the expected sentences in order", JSON.stringify(listed) === JSON.stringify(expected.proposals.map((p) => p.sentence)), { listed });
check("title is Weekly review", (await evaluate(`document.getElementById("page-title").textContent`)) === "Weekly review");
check("Also noticed starts collapsed", (await evaluate(`document.getElementById("weekly-noticed")?.open`)) === false);
const versionsOpen = await evaluate(`JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history.length`);
check("nothing changes without Accept", versionsOpen === versionsBefore, { versionsBefore, versionsOpen });
await shot("weekly-dark.png");
await open("/profile#weekly", "light");
await waitFor(`document.querySelectorAll(".weekly-item").length > 0`);
await shot("weekly-light.png");
await open("/profile#weekly");
await waitFor(`document.querySelectorAll(".weekly-item").length > 0`);

// 3. Accept the first: one new version, the value moved by the proposed step.
const first = expected.proposals[0];
const [, topicId] = first.path.match(/^\$\.topics\.([^.]+)\.affinity$/) || [];
await evaluate(`document.querySelector('.weekly-item [data-action="accept"]').click()`);
await waitFor(`document.getElementById("weekly-accepted") !== null`);
const afterAccept = await profileNow();
const versionsAccept = await evaluate(`JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history.length`);
check("accept saves one version with the new value", versionsAccept === versionsBefore + 1 && afterAccept.topics[topicId]?.affinity === first.new_value,
  { path: first.path, value: afterAccept.topics[topicId]?.affinity, want: first.new_value });
const afterAcceptList = await sentences();
check("the accepted suggestion leaves the list", !afterAcceptList.includes(first.sentence) && afterAcceptList.length === n - 1, { afterAcceptList });
await shot("weekly-accepted-dark.png");

// 4. Skip the next one; it stays gone after a reload.
const skipped = afterAcceptList[0];
await evaluate(`document.querySelector('.weekly-item [data-action="skip"]').click()`);
await sleep(200);
await open("/profile#weekly");
await waitFor(`document.getElementById("weekly-accepted") !== null`);
const afterSkip = await sentences();
check("skip hides a suggestion across a reload", !afterSkip.includes(skipped) && !afterSkip.includes(first.sentence), { afterSkip });
const versionsSkip = await evaluate(`JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history.length`);
check("skip saves nothing", versionsSkip === versionsAccept, { versionsSkip });

// 5. Undo: the old value back as one more version; the accepted suggestion does not return.
await evaluate(`document.getElementById("weekly-undo").click()`);
await waitFor(`document.getElementById("weekly-accepted") === null`);
const afterUndo = await profileNow();
const versionsUndo = await evaluate(`JSON.parse(localStorage.getItem("almanac.profile.store.v1")).history.length`);
check("undo restores the old value as a new version", afterUndo.topics[topicId]?.affinity === first.old_value && versionsUndo === versionsAccept + 1,
  { value: afterUndo.topics[topicId]?.affinity, versionsUndo });
const afterUndoList = await sentences();
check("an undone suggestion does not come back this week", !afterUndoList.includes(first.sentence), { afterUndoList });

// 6. Light You page for the record, then the page-wide checks.
await open("/profile", "light");
await waitFor(`document.getElementById("weekly-row")?.querySelector(".setting-value")?.textContent.includes("suggestion")`);
await shot("you-light.png");
check("zero CSP violations", (await evaluate("window.__csp.length")) === 0, { csp: await evaluate("window.__csp") });
check("zero cumulative layout shift", (await evaluate("window.__cls")) === 0, { cls: await evaluate("window.__cls") });

console.log(JSON.stringify(results, null, 2));
chrome.close();
site.close();
if (!ok) { console.error("S29 weekly review proof FAILED"); process.exit(1); }
console.log(`S29 weekly review proof passed: ${Object.keys(results).length} checks, ${n} suggestions`);
