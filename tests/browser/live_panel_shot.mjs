// S33 one-off proof shot: node tests/browser/live_panel_shot.mjs <dist dir> <out dir>
// Loads the built page, taps into the Live tab, and saves the panel as seen: header
// naming the event, then its own clusters, ranked and tiered. Exits 1 if the tab is
// hidden (nothing to shoot) or a CSP violation fires while getting there.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, outArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const out = resolve(outArg || ".");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s33-live-shot");
const { send, evaluate } = chrome;

const violations = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") violations.push("exception: " + m.params.exceptionDetails.exception?.description);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));` });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url: `${site.origin}/index.html` });
for (let i = 0; i < 50; i++) {
  if (await evaluate(`document.documentElement.dataset.sections === "ready" && document.fonts.status === "loaded"`)) break;
  await sleep(100);
}
await sleep(300);

const hidden = await evaluate(`document.getElementById("tab-live").hidden`);
if (hidden) {
  console.error(JSON.stringify({ ok: false, reason: "live tab is hidden on this pool" }));
  chrome.close();
  site.close();
  process.exit(1);
}

const box = await evaluate(`(() => { const t = document.getElementById("tab-live"); const r = t.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`).then(JSON.parse);
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}
await sleep(500);

const info = await evaluate(`(() => {
  const panel = document.getElementById("section-live");
  const header = panel.querySelector(".live-header");
  return JSON.stringify({
    activeTab: document.querySelector('.tab[aria-selected="true"]').dataset.section,
    kicker: header?.querySelector(".live-kicker")?.textContent,
    title: header?.querySelector(".live-title")?.textContent,
    rows: panel.querySelectorAll("li.story[data-sid]").length,
    csp: window.__csp,
  });
})()`).then(JSON.parse);

const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
writeFileSync(join(out, "live-panel-dark.png"), Buffer.from(png, "base64"));

console.log(JSON.stringify({ ok: violations.length === 0 && info.csp.length === 0, info, exceptions: violations }, null, 2));
chrome.close();
site.close();
process.exit(violations.length === 0 && info.csp.length === 0 ? 0 : 1);
