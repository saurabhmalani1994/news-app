// S26 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/saved_check.mjs <built dist dir> <has_body article id> [<screenshot dir>]
// Headless Chrome at 360x780 CSS px, DPR 3, dark. Checks: the Saved screen shows its
// empty state with nothing saved; saving two stories from their own overflow sheet
// (one has_body, one not) and opening Saved lists both, newest first, with the same
// card the river uses; going offline and opening the saved has_body story still opens
// the reader from its pinned body, not the "you are offline" note; zero CSP violations
// and zero cumulative layout shift throughout. Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, bodyIdArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const bodyId = bodyIdArg || "b827ba1a90cf4138";
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s26-saved");
const { send, evaluate } = chrome;
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

// The one has_body story's body, served over the Fetch domain like reader_check.mjs;
// every other bodies/* request 404s, the same "not here" state a real deploy would give.
chrome.on(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const id = (/\/bodies\/([^/]+)\.json/.exec(request.url) || [])[1];
  if (id === bodyId) {
    const body = {
      schema_version: 1, article_id: id, source_id: "npr", source_name: "NPR",
      url: "https://example.org/2026/09/23/transit-budget",
      body_html: "<p>The council voted 7 to 2 after a long public hearing on the new transit budget.</p>",
    };
    await send("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
    return;
  }
  await send("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [], body: "" });
});

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/bodies/*" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  window.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
`,
});

await send("Page.navigate", { url: `${site.origin}/index.html` });
await sleep(900);

async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
const violations = () => evaluate("window.__csp");
const cls = () => evaluate("window.__cls");

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 0. Go to the Saved screen with nothing saved yet: the empty state, not the list.
await evaluate('location.hash = "#saved"');
await sleep(400);
const empty0 = JSON.parse(await evaluate(`JSON.stringify({
  screenCurrent: document.getElementById("screen-saved").classList.contains("is-current"),
  emptyHidden: document.getElementById("saved-empty").hidden,
  listHidden: document.getElementById("saved-list").hidden,
  rows: document.querySelectorAll("#saved-list li.story").length,
})`));
await shot("empty-dark.png");
check("Saved screen with nothing saved shows the empty state, not the list",
  empty0.screenCurrent && empty0.emptyHidden === false && empty0.listHidden === true && empty0.rows === 0, empty0);

// 1. Back to Home, save the has_body story (article 0's card) and a second, no-body
// story (article 1's card), each through its own overflow sheet, the ordinary save path
// any card on any tab uses (story-actions.js), never a shortcut into IndexedDB.
await evaluate('location.hash = ""');
await sleep(300);
async function saveCard(sid) {
  await evaluate(`document.querySelector('li.story[data-sid="${sid}"] .story-overflow').click()`);
  await sleep(400);
  await evaluate('document.querySelector(\'.sheet-item[data-action="save"]\').click()');
  await sleep(500); // lets the S26 fetch-and-pin (network, above) finish before offline
}
const ids = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#section-today li.story[data-sid]")].slice(0, 2).map((li) => li.dataset.sid))`));
await saveCard(ids[0]);
await saveCard(ids[1]);
await sleep(300);

// 2. Open Saved: both stories listed, newest (second saved) first, the river's own card
// markup and thumbnail, CLS still 0. The save toast is dismissed first so the shot
// shows the screen at rest, not mid-transient.
await evaluate('document.getElementById("toast").hidden = true');
await evaluate('location.hash = "#saved"');
await sleep(500);
const saved = JSON.parse(await evaluate(`JSON.stringify({
  rows: [...document.querySelectorAll("#saved-list li.story")].map((li) => ({
    sid: li.dataset.sid,
    headline: li.querySelector(".headline")?.textContent,
    source: li.querySelector(".meta-source")?.textContent,
    hasThumb: !!li.querySelector(".story-img"),
    hasDataBody: !!li.querySelector("a.story-link[data-body]"),
  })),
  emptyHidden: document.getElementById("saved-empty").hidden,
  listHidden: document.getElementById("saved-list").hidden,
})`));
await shot("final-dark.png");
check("Saved lists both stories, newest first, with the river card's own thumbnail",
  saved.rows.length === 2 && saved.rows[0].sid === ids[1] && saved.rows[1].sid === ids[0]
    && saved.rows.every((r) => r.hasThumb) && saved.listHidden === false && saved.emptyHidden === true,
  saved);
check("only the has_body story's row carries data-body (opens the reader)",
  saved.rows.find((r) => r.sid === ids[0]).hasDataBody && !saved.rows.find((r) => r.sid === ids[1]).hasDataBody,
  saved);

// 3. Offline. Tap the saved has_body story: it must open from its pinned cache, not
// show the "you are offline" note (which is what an unpinned, unfetched body would do).
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await sleep(200);
await evaluate("window.__cls = 0"); // measure from here: opening the reader must add no shift
const clsBeforeOpen = await cls();
await evaluate(`document.querySelector('#saved-list a.story-link[data-body="${bodyId}"]').click()`);
await sleep(700);
const opened = JSON.parse(await evaluate(`JSON.stringify({
  readerHidden: document.getElementById("reader").hidden,
  title: document.getElementById("reader-title")?.textContent,
  bodyText: document.querySelector(".reader-body")?.textContent || "",
  noteHead: document.querySelector(".reader-note-head")?.textContent || null,
})`));
await shot("offline-reader-dark.png");
const clsAfterOpen = await cls();
check("offline, the saved has_body story still opens from its pinned body, no offline note",
  opened.readerHidden === false && opened.noteHead === null && opened.bodyText.includes("transit budget"),
  opened);
check("opening the pinned story offline adds zero layout shift",
  (clsAfterOpen - clsBeforeOpen) === 0, { clsBeforeOpen, clsAfterOpen });

check("zero CSP violations for the whole run", (await violations()).length === 0, { violations: await violations() });

console.log(JSON.stringify({ results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
