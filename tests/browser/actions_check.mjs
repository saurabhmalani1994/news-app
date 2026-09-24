// S24 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/actions_check.mjs <built dist dir> [<screenshot dir>]
// Headless Chrome at 360x780 CSS px, DPR 3, dark. Checks: the overflow sheet opens and
// dismisses by its close button, the scrim and the browser back button; muting a
// source removes its rows and leaves the scroll anchored (the row the reader was
// looking at stays in the same screen position) with zero layout shift; zero CSP
// violations throughout. Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s24-actions");
const { send, evaluate } = chrome;

await send("Page.enable");
await send("Runtime.enable");
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

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
const violations = () => evaluate("window.__csp");

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 0. Loaded, a card with the overflow control visible.
const loaded = JSON.parse(await evaluate(`JSON.stringify({
  rows: document.querySelectorAll("#section-today li.story[data-sid]").length,
  overflowButtons: document.querySelectorAll("#section-today .story-overflow").length,
  sheetHidden: document.getElementById("sheet-root").hidden,
})`));
await shot("final-dark.png");
check("card carries the overflow control", loaded.rows > 0 && loaded.overflowButtons === loaded.rows && loaded.sheetHidden, loaded);

// 1. Open the sheet (first card's overflow button) and check its content and focus trap.
async function openFirstSheet() {
  await evaluate('document.querySelector("#section-today .story-overflow").click()');
  await sleep(500);
}
await openFirstSheet();
const opened = JSON.parse(await evaluate(`JSON.stringify({
  hidden: document.getElementById("sheet-root").hidden,
  isOpen: document.getElementById("sheet-root").classList.contains("is-open"),
  items: [...document.querySelectorAll(".sheet-item")].map((b) => b.dataset.action),
  whyVisible: document.querySelector('.sheet-item[data-action="why"]').hidden === false,
  activeInSheet: document.getElementById("sheet").contains(document.activeElement),
  historyPushed: history.state && history.state.almanacSheet === 1,
})`));
await shot("sheet-dark.png");
// T1: S12 landed after this proof was authored and flipped WHY_THIS_ENABLED on, so
// "why" is a visible menu item now, not a hidden one held back for a later slice.
check("sheet opens with every menu item, focus inside it, why-this visible (S12), history pushed",
  opened.hidden === false && opened.isOpen && opened.items.includes("save") && opened.items.includes("mute-source")
    && opened.items.includes("mute-topic") && opened.items.includes("boost-topic") && opened.whyVisible
    && opened.activeInSheet && opened.historyPushed,
  opened);

// 2. Dismiss by its own close button.
await evaluate('document.getElementById("sheet-close").click()');
await sleep(400);
const closedByButton = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden })'));
check("dismiss by the sheet's own close button", closedByButton.hidden === true, closedByButton);

// 3. Dismiss by tapping the scrim.
await openFirstSheet();
await evaluate('document.getElementById("sheet-scrim").click()');
await sleep(400);
const closedByScrim = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden })'));
check("dismiss by tapping the scrim", closedByScrim.hidden === true, closedByScrim);

// 4. Dismiss by the browser's own back button.
await openFirstSheet();
await evaluate("history.back()");
await sleep(400);
const closedByBack = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden })'));
check("dismiss by the browser back button", closedByBack.hidden === true, closedByBack);

// 5. Mute a source: pick a source with several rows below the fold, scroll so some of
// its rows sit above the viewport, note the anchor row's screen position, mute, and
// check the anchor never visibly moved (the scroll offset absorbed the removals above
// it) with zero cumulative layout shift.
const before = JSON.parse(await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#section-today li.story[data-sid]')];
  const bySource = new Map();
  for (const li of rows) {
    const src = li.querySelector('.meta-source')?.textContent || '';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(li.dataset.sid);
  }
  const [source, ids] = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return JSON.stringify({ source, ids, total: rows.length });
})()`));
const panelHeight = 780;
await evaluate(`document.getElementById("section-today").scrollTop = ${panelHeight * 1.5}`);
await sleep(300);
const anchorBefore = JSON.parse(await evaluate(`(() => {
  const panel = document.getElementById("section-today");
  const rows = [...panel.querySelectorAll("li.story[data-sid]")];
  const top = panel.getBoundingClientRect().top;
  const anchor = rows.find((li) => li.getBoundingClientRect().bottom > top);
  return JSON.stringify({ sid: anchor?.dataset.sid, top: anchor?.getBoundingClientRect().top, mutedIsAnchor: ${JSON.stringify(before.ids)}.includes(anchor?.dataset.sid) });
})()`));
await evaluate("window.__cls = 0"); // measure layout shift from the mute action alone
const clsBeforeMute = await evaluate("window.__cls");

// Open the sheet on a row from the chosen source and mute it.
await evaluate(`(() => {
  const li = document.querySelector('#section-today li.story[data-sid="${before.ids[0]}"]');
  li.querySelector(".story-overflow").click();
})()`);
await sleep(400);
await evaluate('document.querySelector(\'.sheet-item[data-action="mute-source"]\').click()');
await sleep(600);

const after = JSON.parse(await evaluate(`(() => {
  const panel = document.getElementById("section-today");
  const remaining = [...panel.querySelectorAll("li.story[data-sid]")].map((li) => li.dataset.sid);
  const anchorLi = document.querySelector('li.story[data-sid="${anchorBefore.sid}"]');
  return JSON.stringify({
    remaining,
    anchorStillThere: !!anchorLi,
    anchorTop: anchorLi ? anchorLi.getBoundingClientRect().top : null,
    toastHidden: document.getElementById("toast").hidden,
    toastText: document.getElementById("toast-text").textContent,
    sheetHidden: document.getElementById("sheet-root").hidden,
  });
})()`));
await shot("toast-dark.png");
const clsAfterMute = await evaluate("window.__cls");
const mutedGone = before.ids.every((id) => !after.remaining.includes(id));
const anchorSteady = anchorBefore.mutedIsAnchor || (after.anchorStillThere && Math.abs(after.anchorTop - anchorBefore.top) < 1);
check("mute source removes its rows, sheet closes, toast shown with the source's name",
  mutedGone && after.sheetHidden && !after.toastHidden && after.toastText.length > 0,
  { before, after, anchorBefore });
check("scroll stayed anchored on the row the reader was looking at (CLS 0 from the viewer's view)",
  anchorSteady && (clsAfterMute - clsBeforeMute) === 0,
  { anchorBefore, anchorAfterTop: after.anchorTop, clsDelta: clsAfterMute - clsBeforeMute });

// 6. Undo: the toast's own button reverts the mute, the row set is restored.
await evaluate('document.getElementById("toast-action").click()');
await sleep(500);
const undone = JSON.parse(await evaluate(`(() => {
  const remaining = [...document.querySelectorAll('#section-today li.story[data-sid]')].map((li) => li.dataset.sid);
  return JSON.stringify({ remaining });
})()`));
check("Undo restores the muted source's rows", before.ids.every((id) => undone.remaining.includes(id)), undone);

check("zero CSP violations for the whole run", (await violations()).length === 0, { violations: await violations() });

console.log(JSON.stringify({ results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
