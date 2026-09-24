// S37 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/csp_check.mjs <built dist dir> [<screenshot dir>]
// Serves the built page with the headers from the build's own dist/_headers, as
// Cloudflare Pages does, in headless Chrome at 360x780 CSS px, DPR 3, and checks:
// the default page, a stored profile that makes rank-gate load rerank.js (final order
// must equal passes.js run here on the page's own input), a tap on every section tab
// (each panel must fill), the profile screen, and every hostile body fixture sanitized
// and appended to the live page, each with zero CSP violations and nothing executed.
// A last control appends the same fixtures raw, unsanitized: the CSP must report
// violations there, which shows the headers were enforced during the checks above.
// Exits 1 on any failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { rankPages } from "../../app/static/js/passes.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { BASE, BENIGN, HOSTILE, handlerFixtures } from "../js/hostile-bodies.js";
import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("s37-csp");
const { send, evaluate } = chrome;

const logged = [];
chrome.on((m) => {
  if (m.method === "Log.entryAdded") logged.push(m.params.entry.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logged.push(m.params.args.map((a) => a.value).join(" "));
  if (m.method === "Runtime.exceptionThrown") logged.push("exception: " + m.params.exceptionDetails.exception?.description);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__pwned = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));` });

if (shotsArg) mkdirSync(shotsArg, { recursive: true });
async function load(path, scheme = "dark", stored = null) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}/${path}` });
  await sleep(700);
  await evaluate(stored ? `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))})` : "localStorage.clear()");
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
}
async function shot(name) {
  if (!shotsArg) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(shotsArg, name), Buffer.from(png, "base64"));
}
const violations = () => evaluate("window.__csp");

const results = {};
let ok = true;
const check = (name, pass, detail) => { results[name] = { pass, ...detail }; ok &&= pass; };

// 1. The default page, served with the CSP.
await load("index.html");
const served = await evaluate("fetch(location.href).then((r) => r.headers.get('content-security-policy'))");
const rows = await evaluate("document.querySelectorAll('#section-today li.story').length");
const heroBox = await evaluate("(() => { const f = document.querySelector('.story-media--hero'); return f ? getComputedStyle(f).aspectRatio : null; })()");
await shot("csp-default-dark.png");
check("default page", served === headers["Content-Security-Policy"] && rows > 0 && (await violations()).length === 0,
  { cspServed: served === headers["Content-Security-Policy"], rows, heroAspectRatio: heroBox, violations: await violations() });
await load("index.html", "light");
await shot("csp-default-light.png");
check("default page light", (await violations()).length === 0, { violations: await violations() });

// 2. The device re-rank: rank-gate.js loads rerank.js for a stored non-default profile.
const base = buildDefaultProfile("2026-09-24T00:00:00Z");
const custom = structuredClone(base);
custom.topics.ai.affinity = 1;
custom.topics.us_politics.affinity = 0.1;
custom.topics.world.affinity = 0.2;
const stored = { history: [{ version: 1, timestamp: base.updated_at, profile: base }, { version: 2, timestamp: "2026-09-24T01:00:00Z", profile: { ...custom, profile_version: 2 } }] };
await load("index.html", "dark", stored);
const rr = JSON.parse(await evaluate(`JSON.stringify({ hidden: document.documentElement.classList.contains("rerank"),
  rerankLoaded: performance.getEntriesByType("resource").some((e) => e.name.endsWith("/js/rerank.js")),
  order: [...document.querySelectorAll("#section-today li.story[data-sid]")].map((li) => li.dataset.sid),
  input: JSON.parse(document.getElementById("rank-input").content.textContent) })`));
const opts = { buckets: rr.input.buckets, leans: rr.input.leans, names: rr.input.names };
const expected = rankPages(rr.input.pool, custom, rr.input.now, opts).today.map((s) => s.id);
const builtOrder = rankPages(rr.input.pool, base, rr.input.now, opts).today.map((s) => s.id);
await shot("csp-rerank-dark.png");
check("device re-rank", rr.rerankLoaded && !rr.hidden && rr.order.join() === expected.join() && (await violations()).length === 0,
  { rerankLoaded: rr.rerankLoaded, finalMatchesRanker: rr.order.join() === expected.join(), reordered: builtOrder.join() !== rr.order.join(), violations: await violations() });

// 3. Every section tab, tapped.
const tabs = JSON.parse(await evaluate(`(async () => {
  const out = [];
  for (const tab of [...document.querySelectorAll(".tab")].filter((t) => !t.hidden)) {
    tab.click();
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    out.push({ id: tab.dataset.section, selected: tab.getAttribute("aria-selected") === "true", rows: panel.querySelectorAll("li.story").length });
  }
  return JSON.stringify(out);
})()`));
await shot("csp-tab-last-dark.png");
check("section tabs", tabs.every((t) => t.selected && t.rows > 0) && (await violations()).length === 0, { tabs, violations: await violations() });

// 4. The profile screen (its own module script and the schema fetch).
await load("profile.html");
const profileReady = await evaluate("document.getElementById('settings-root').getAttribute('aria-busy') !== 'true' && document.querySelectorAll('#topics-list *').length > 0");
await shot("csp-profile-dark.png");
check("profile screen", profileReady && (await violations()).length === 0, { profileReady, violations: await violations() });

// 5. Hostile bodies sanitized into the live page under the CSP.
await load("index.html");
const handlers = await evaluate(`(() => { const n = new Set(); for (const s of [window, document, document.body, document.createElement("video"), document.createElement("details"), document.createElement("img"), document.createElement("input"), document.createElementNS("http://www.w3.org/2000/svg", "svg")]) for (const k in s) if (/^on[a-z]+$/.test(k)) n.add(k); return [...n]; })()`);
const fixtures = [...HOSTILE, ...handlerFixtures(handlers), BENIGN];
// Parsing hostile HTML in the inert document already meets the CSP: Chrome reports a
// style attribute, a <style> or a <base> there (blocked, never applied). So the parse
// and the insertion are counted apart: the benign body must report nothing at all, and
// inserting the sanitized hostile output must add zero violations and run nothing.
const benign = await evaluate(`(async (html) => {
  const { sanitizeBody } = await import("./js/sanitize.js");
  const reader = document.createElement("article");
  reader.append(sanitizeBody(html, { base: ${JSON.stringify(BASE)} }));
  document.querySelector("#section-today").append(reader);
  await new Promise((r) => setTimeout(r, 800));
  return { violations: window.__csp.slice(), paragraphs: reader.querySelectorAll("p").length };
})(${JSON.stringify(BENIGN.html)})`);
check("benign body sanitized and inserted", benign.violations.length === 0 && benign.paragraphs > 0, benign);
const parsed = await evaluate(`(async (fixtures) => {
  const { sanitizeBody } = await import("./js/sanitize.js");
  window.__frags = fixtures.map((f) => sanitizeBody(f.html, { base: ${JSON.stringify(BASE)} }));
  await new Promise((r) => setTimeout(r, 300));
  return window.__csp.slice();
})(${JSON.stringify(fixtures)})`);
await evaluate(`(() => { const reader = document.createElement("article"); reader.id = "s37-reader"; for (const f of window.__frags) reader.append(f); document.querySelector("#section-today").append(reader); })()`);
await evaluate("document.querySelectorAll('#s37-reader *').forEach((el) => { el.focus?.(); el.dispatchEvent(new Event('mouseover')); })");
await sleep(1500);
const after = await violations();
const parseOnly = parsed.every((v) => /^(style-src-attr|style-src-elem|base-uri) /.test(v));
const sanitized = { fixtures: fixtures.length, pwned: await evaluate("window.__pwned"), inertParseReports: parsed.length, parseReportsAreBlockedStyleOrBase: parseOnly, violationsFromInsertion: after.length - parsed.length };
check("hostile bodies sanitized and inserted", sanitized.pwned.length === 0 && parseOnly && after.length === parsed.length, sanitized);

const loggedBeforeControl = logged.length;
// 6. Control: the same fixtures raw. The CSP must block and report here.
await evaluate(`(() => { const box = document.createElement("div"); box.innerHTML = ${JSON.stringify(fixtures.map((f) => f.html).join(""))}; document.body.append(box); })()`);
await sleep(1500);
const control = { pwned: await evaluate("window.__pwned"), violations: (await violations()).length };
check("control: raw bodies blocked by the CSP", control.pwned.length === 0 && control.violations > 0, control);

const policyNoise = logged.slice(0, loggedBeforeControl).filter((t) => /Permissions-Policy|Unrecognized feature|Content Security Policy|Content-Security-Policy/i.test(t));
results.consoleBeforeControl = { policyMessages: policyNoise.length };
console.log(JSON.stringify({ csp: headers["Content-Security-Policy"], results }, null, 2));
if (policyNoise.length) console.log("policy console messages (first 5):", policyNoise.slice(0, 5));
chrome.close();
site.close();
process.exit(ok ? 0 : 1);
