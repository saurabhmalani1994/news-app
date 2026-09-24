// S12 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/why_check.mjs <built dist dir> [<screenshot dir>]
// Headless Chrome at 360x780 CSS px, DPR 3, dark. Opens the why-this sheet from the
// overflow menu on today's hero: checks the rows sum to the total shown, the scale is
// stated once, zero layout shift opening it, dismiss by the browser back button, and
// zero CSP violations. Then opens it again on a story the standing-story floor placed,
// checking its pass entry reads in plain words. Exits 1 on any failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s12-why");
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

async function readSheet() {
  return JSON.parse(await evaluate(`JSON.stringify((() => {
    const hidden = document.getElementById("sheet-root").hidden;
    if (hidden) return { hidden: true };
    const rows = [...document.querySelectorAll(".why-row")].map((r) => ({
      label: r.querySelector(".why-row-label").textContent,
      value: r.querySelector(".why-row-value").textContent,
    }));
    const total = document.querySelector(".why-total span:last-child")?.textContent;
    const passes = [...document.querySelectorAll(".why-pass")].map((p) => p.textContent);
    const scale = document.querySelector(".why-scale-note")?.textContent || "";
    const headline = document.querySelector(".why-headline")?.textContent || "";
    const editHref = document.querySelector(".why-edit-link")?.getAttribute("href") || "";
    const label = document.getElementById("sheet-label").textContent;
    const isOpen = document.getElementById("sheet-root").classList.contains("is-open");
    return { hidden: false, label, isOpen, rows, total, passes, scale, headline, editHref };
  })())`));
}

const parseSigned = (s) => (s.startsWith("−") ? -1 : 1) * Number(s.slice(1));

async function openWhyOn(sid) {
  await evaluate(`document.querySelector('li.story[data-sid="${sid}"] .story-overflow').click()`);
  await sleep(400);
  await evaluate('document.querySelector(\'.sheet-item[data-action="why"]\').click()');
  await sleep(900); // the actions sheet closes, then the why-this sheet opens (story-actions.js's own 220ms handoff)
}

// 0. Loaded.
const loaded = JSON.parse(await evaluate(`JSON.stringify({
  heroSid: document.querySelector("#section-today .story--hero")?.dataset.sid || null,
  sdRow: !!document.querySelector('li.story[data-sid="sd1"]'),
})`));
check("today's hero and the standing-story pick are both on the page", Boolean(loaded.heroSid) && loaded.sdRow, loaded);

// 1. Why this on today's hero: rows sum to the total, the scale is stated once, CLS 0.
await evaluate("window.__cls = 0");
await openWhyOn(loaded.heroSid);
const hero = await readSheet();
await shot("final-dark.png");
const clsAfterOpen = await evaluate("window.__cls");
const heroSum = hero.rows.reduce((s, r) => s + parseSigned(r.value), 0);
check("why-this opens on the hero with every explanation row, text only, sum equal to the total shown",
  !hero.hidden && hero.isOpen && hero.label === "Why this" && hero.rows.length >= 4 && heroSum === parseSigned(hero.total),
  { hero, heroSum });
check("the point scale is stated once, in the sheet's own caption", hero.scale.length > 0, { scale: hero.scale });
check("opening the sheet caused zero layout shift", clsAfterOpen === 0, { clsAfterOpen });

// 2. Dismiss by the browser's own back button.
await evaluate("history.back()");
await sleep(400);
const closedByBack = JSON.parse(await evaluate('JSON.stringify({ hidden: document.getElementById("sheet-root").hidden })'));
check("dismiss by the browser back button", closedByBack.hidden === true, closedByBack);

// 3. Why this on the story the standing-story floor placed: its pass entry shows in
// plain words, and its own rows still sum to its own total.
await openWhyOn("sd1");
const sd = await readSheet();
await shot("pass-dark.png");
const sdSum = sd.rows.reduce((s, r) => s + parseSigned(r.value), 0);
check("why-this on the standing-story pick shows its pass entry in plain words",
  !sd.hidden && sd.passes.length === 1 && /^Placed by standing story: Sudan, floor 1 in the top 15/.test(sd.passes[0]),
  { passes: sd.passes });
check("its own rows also sum exactly to its own total", sdSum === parseSigned(sd.total), { sdSum, total: sd.total });
check("it carries the edit-what-drove-this-most link", sd.editHref.startsWith("/profile"), { editHref: sd.editHref });

await evaluate("history.back()");
await sleep(400);

// 4. A quiet story (no pass touched it) shows no pass section at all.
await openWhyOn("a00");
const quiet = await readSheet();
check("a story with no pass entries shows no pass section", !quiet.hidden && quiet.passes.length === 0, { passes: quiet.passes });
await evaluate("history.back()");
await sleep(400);

check("zero CSP violations for the whole run", (await violations()).length === 0, { violations: await violations() });

console.log(JSON.stringify({ results }, null, 2));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
