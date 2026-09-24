// S33 one-off smoke check (not part of the CI glob): node tests/browser/live_overrides_smoke.mjs <dist dir>
// Taps into Live, opens the header's overflow sheet, pins the event, confirms it is a
// new versioned profile save and the tab/panel still read correctly; then blocks it
// and confirms the tab disappears with the pager landing back on Today, no CLS.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const dist = resolve(process.argv[2] || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s33-override-smoke");
const { send, evaluate } = chrome;
const violations = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") violations.push(m.params.exceptionDetails.exception?.description); });
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__shift = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true });` });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url: `${site.origin}/index.html` });
for (let i = 0; i < 50; i++) {
  if (await evaluate(`document.documentElement.dataset.sections === "ready"`)) break;
  await sleep(100);
}
await sleep(300);

async function clickCenterOf(selector) {
  const box = JSON.parse(await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "null";
    const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  if (!box) throw new Error(`not found: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}

await clickCenterOf("#tab-live");
await sleep(400);
await clickCenterOf(".live-overflow");
await sleep(300);
const menuItems = await evaluate(`[...document.querySelectorAll(".sheet-item")].map((n) => n.textContent)`);
await clickCenterOf('.sheet-item[data-action="pin"]');
await sleep(400);
const afterPin = JSON.parse(await evaluate(`(() => {
  const raw = localStorage.getItem("almanac.profile.store.v1");
  const history = JSON.parse(raw).history;
  const top = history[history.length - 1];
  return JSON.stringify({ version: top.version, pinned: top.profile.live_overrides.pinned_event_id, tabHidden: document.getElementById("tab-live").hidden, toast: document.querySelector(".toast")?.textContent || null });
})()`));

await sleep(500);
await clickCenterOf(".live-overflow");
await sleep(300);
await clickCenterOf('.sheet-item[data-action="block"]');
await sleep(500);
const afterBlock = JSON.parse(await evaluate(`(() => {
  const raw = localStorage.getItem("almanac.profile.store.v1");
  const history = JSON.parse(raw).history;
  const top = history[history.length - 1];
  return JSON.stringify({
    version: top.version, blockedIds: top.profile.live_overrides.blocked_event_ids,
    blockedLabels: top.profile.live_overrides.blocked_labels, pinned: top.profile.live_overrides.pinned_event_id,
    tabHidden: document.getElementById("tab-live").hidden,
    activeTab: document.querySelector('.tab[aria-selected="true"]').dataset.section,
  });
})()`));
const shift = await evaluate("window.__shift");

console.log(JSON.stringify({
  ok: violations.length === 0 && menuItems.length === 2 && afterPin.pinned && !afterPin.tabHidden
    && afterBlock.tabHidden && afterBlock.activeTab === "today" && afterBlock.version === afterPin.version + 1,
  menuItems, afterPin, afterBlock, shift, csp: await evaluate("window.__csp"), exceptions: violations,
}, null, 2));
chrome.close();
site.close();
