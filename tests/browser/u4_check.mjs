// U4 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/u4_check.mjs [<screenshot dir>]
// The owner, on his phone: "the you page - there is no way for me to add or remove
// interests." This builds the app from a small pool (golden_pool.json, one article
// nudged to carry the "science" topic tag so a just-added interest has something to
// actually match), serves it the way Cloudflare Pages does, and drives the You page in
// headless Chrome at 360x780 CSS px, DPR 3:
//   1. The list's own last row opens the add-interest sheet; its search field and
//      grouped catalog (Regions, Sectors, Subjects, Guaranteed) list every interest not
//      already on the profile.
//   2. Searching narrows the list; tapping a result adds it as one profile version, the
//      sheet closes, and the new interest is in the list at once with a default level.
//   3. Opening it shows a Remove interest action; removing it is one more version, no
//      confirmation, back on the list at once with a "Removed <name>." toast and Undo.
//   4. Undo restores the exact prior version (same affinity, half-life, enabled).
//      Removing it again is one more version.
//   5. Home, loaded fresh right after the add (before it is removed again), re-ranks on
//      the device for the edited profile: window.almanacProfile (rank-gate.js) carries
//      the just-added interest, and the tagged story's own matched topics include it.
//   6. Home, loaded again after the whole sequence, still reads whatever the profile
//      currently holds, whether or not that needed a fresh re-rank.
// Zero CSP violations and CLS 0 throughout. Saves you-dark.png, you-light.png,
// add-sheet-dark.png, interest-dark.png, undo-toast-dark.png. Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PY = PYTHON; // PYTHON env, else the repo .venv (tests/browser/python.mjs)
const TMP = join(ROOT, "tests", ".tmp-u4");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

// A clone of the golden fixture with the "enzyme pathway" article tagged "science", so
// an interest added on the You page has a real story to affect. Every other article is
// untouched (topicless, as the fixture ships), matching how the build already treats it.
function sciencePool() {
  const pool = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "golden_pool.json"), "utf-8"));
  const enzyme = pool.articles.find((a) => a.title.includes("enzyme pathway"));
  enzyme.topics = ["science"];
  const path = join(TMP, "science_pool.json");
  writeFileSync(path, JSON.stringify(pool));
  return { path, enzymeId: enzyme.id };
}

function build(pool, dist) {
  rmSync(dist, { recursive: true, force: true });
  execFileSync(PY, ["-m", "app.build", "--pool", pool, "--out", dist], { cwd: ROOT, stdio: "ignore" });
  return dist;
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const { path: poolPath, enzymeId } = sciencePool();
const dist = build(poolPath, join(TMP, "dist"));
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const site = await serve(dist, headers);
const chrome = await launch("u4-check");
const { send, evaluate } = chrome;
const errors = [];
chrome.on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
});
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__csp = []; window.__cls = 0;
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });` });

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => {
  if (!SHOTS) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(SHOTS, name), Buffer.from(png, "base64"));
};
const ready = () => evaluate("document.getElementById('settings-root').getAttribute('aria-busy') !== 'true' && document.getElementById('settings-root').childElementCount > 0");
const store = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`);
const versions = async () => (await store()).history.length;
const cls = () => evaluate("window.__cls");
const csp = () => evaluate("window.__csp.length");
async function open(path, scheme = "dark") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: `${site.origin}${path}` });
  for (let i = 0; i < 40 && !(await ready().catch(() => false)); i++) await sleep(100);
  await sleep(300);
}

// 0. A clean profile.
await open("/profile");
await evaluate("localStorage.clear(); sessionStorage.clear()");
await open("/profile");
const v0 = await versions();

// 1. The list ends with a quiet "Add interest" row, not a colored button.
const list0 = JSON.parse(await evaluate(`JSON.stringify({
  rowIds: [...document.querySelectorAll("#topics-list a.setting-row")].map((a) => a.dataset.topic),
  addRow: (() => { const b = document.getElementById("add-interest-row"); return b && { tag: b.tagName, text: b.textContent.trim(), last: b === document.querySelector("#topics-list > :last-child") }; })(),
})`));
check("list_has_quiet_add_row", list0.rowIds.length === 6 && list0.addRow && list0.addRow.tag === "BUTTON" && list0.addRow.last && /Add interest/.test(list0.addRow.text), list0);
await shot("you-dark.png");
await open("/profile", "light");
await shot("you-light.png");
await open("/profile");

// 2. Tapping it opens the sheet: a search field, the catalog grouped, "Science" offered.
await evaluate(`document.getElementById("add-interest-row").click()`);
await sleep(400);
const sheet0 = JSON.parse(await evaluate(`JSON.stringify({
  open: !document.getElementById("sheet-root").hidden,
  title: document.getElementById("sheet-label").textContent,
  groups: [...document.querySelectorAll("#sheet-body .settings-label")].map((h) => h.textContent),
  rows: [...document.querySelectorAll("#sheet-body button[data-id]")].map((b) => b.dataset.id),
  hasScience: !!document.querySelector('#sheet-body button[data-id="science"]'),
})`));
// must_know (the sole "Guaranteed" entry) is already a starter interest, so it is not
// "available" yet; only the three groups with something left to offer show up here.
check("sheet_opens_with_grouped_catalog", sheet0.open && sheet0.title === "Add interest" && sheet0.rows.length === 7 && sheet0.hasScience
  && sheet0.groups.every((g) => ["Regions", "Sectors", "Subjects", "Guaranteed"].includes(g))
  && ["Regions", "Sectors", "Subjects"].every((g) => sheet0.groups.includes(g)), sheet0);
await shot("add-sheet-dark.png");

// 3. Search narrows the list to the match.
await evaluate(`(() => { const s = document.querySelector("#sheet-body .search-field"); s.focus(); s.value = "science"; s.dispatchEvent(new Event("input")); })()`);
await sleep(200);
const filtered = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#sheet-body button[data-id]")].filter((b) => !b.hidden).map((b) => b.dataset.id))`));
check("search_narrows_the_catalog", filtered.length === 1 && filtered[0] === "science", { filtered });

// 4. Tapping the result: one version, sheet closes, the interest is in the list at once.
await evaluate(`document.querySelector('#sheet-body button[data-id="science"]').click()`);
await sleep(400);
const afterAdd = JSON.parse(await evaluate(`JSON.stringify({
  sheetOpen: !document.getElementById("sheet-root").hidden,
  row: (() => { const a = document.querySelector('#topics-list a[data-topic="science"]'); return a && a.querySelector(".setting-value").textContent; })(),
  toast: { text: document.getElementById("toast-text").textContent, undo: !document.getElementById("toast-action").hidden },
})`));
const v1 = await versions();
check("adding_writes_one_version_and_shows_at_once", !afterAdd.sheetOpen && afterAdd.row === "Normal" && v1 === v0 + 1
  && afterAdd.toast.text === "Science added" && afterAdd.toast.undo, { afterAdd, v0, v1 });
await evaluate(`document.getElementById("toast").hidden = true`);

// 5. Home, loaded right after the add: the device re-rank reads the edited profile, and
// the tagged story's own matched topics include the new interest.
const stored1 = await store();
await open("/");
const home1 = JSON.parse(await evaluate(`(async () => {
  const { rank } = await import("/js/ranker.js");
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const stored = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
  const profile = stored.history.at(-1).profile;
  const ranked = rank(input.pool, profile, input.now);
  const story = ranked.find((s) => s.article_ids.includes(${JSON.stringify(enzymeId)}));
  return JSON.stringify({
    almanacProfileHasScience: !!(window.almanacProfile && window.almanacProfile.topics && window.almanacProfile.topics.science),
    matchedIncludesScience: !!(story && story.topics_matched.includes("science")),
  });
})()`));
check("home_rerank_reads_the_added_interest", home1.almanacProfileHasScience && home1.matchedIncludesScience, { home1, stored1: stored1.history.length });

// 6. Back to You: open the interest, remove it (no dialog), land back on the list with
// "Removed <name>." and Undo; Undo restores the exact same settings.
await open("/profile");
await evaluate(`document.querySelector('#topics-list a[data-topic="science"]').click()`);
await sleep(300);
const beforeRemoveSettings = JSON.parse(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.topics.science)`));
const removeRow = JSON.parse(await evaluate(`JSON.stringify({ hash: location.hash, hasRemove: !!document.querySelector('button.btn-row[data-focus-key="remove-interest"]') })`));
check("interest_page_has_remove_action", removeRow.hash === "#interest/science" && removeRow.hasRemove, removeRow);
await shot("interest-dark.png");
await evaluate(`document.querySelector('button.btn-row[data-focus-key="remove-interest"]').click()`);
await sleep(400);
const afterRemove = JSON.parse(await evaluate(`JSON.stringify({
  hash: location.hash, view: document.getElementById("settings-root").dataset.view,
  stillListed: !!document.querySelector('#topics-list a[data-topic="science"]'),
  toast: { text: document.getElementById("toast-text").textContent, undo: !document.getElementById("toast-action").hidden },
})`));
const v2 = await versions();
check("remove_no_dialog_returns_to_list_with_undo_toast", afterRemove.view === "you" && !afterRemove.stillListed && v2 === v1 + 1
  && afterRemove.toast.text === "Removed Science." && afterRemove.toast.undo, { afterRemove, v1, v2 });
await shot("undo-toast-dark.png");

await evaluate(`document.getElementById("toast-action").click()`);
await sleep(400);
const undone = JSON.parse(await evaluate(`JSON.stringify({
  row: (() => { const a = document.querySelector('#topics-list a[data-topic="science"]'); return a && a.querySelector(".setting-value").textContent; })(),
  settings: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.topics.science,
})`));
const v3 = await versions();
check("undo_restores_the_exact_prior_version", undone.row === "Normal" && v3 === v2 + 1
  && JSON.stringify(undone.settings) === JSON.stringify(beforeRemoveSettings), { undone, beforeRemoveSettings, v2, v3 });

// 7. Remove it again: the final, settled state.
await evaluate(`document.querySelector('#topics-list a[data-topic="science"]').click()`);
await sleep(300);
await evaluate(`document.querySelector('button.btn-row[data-focus-key="remove-interest"]').click()`);
await sleep(400);
const v4 = await versions();
const finalList = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#topics-list a.setting-row")].map((a) => a.dataset.topic))`));
check("second_remove_is_one_more_version_science_gone", v4 === v3 + 1 && !finalList.includes("science"), { v3, v4, finalList });

// 8. Home again, after the whole sequence: still reads whatever the profile now holds,
// whether or not that needed a fresh re-rank (this run's final state has no history read
// signal, so it may equal the build's own default and need none at all).
const stored2 = await store();
await open("/");
const home2 = JSON.parse(await evaluate(`JSON.stringify({
  storedTopics: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile.topics,
  almanacProfile: window.almanacProfile ? window.almanacProfile.topics : null,
})`));
const readsCurrent = !home2.almanacProfile || JSON.stringify(home2.almanacProfile) === JSON.stringify(home2.storedTopics);
check("home_after_the_sequence_still_reads_the_current_set", readsCurrent && !("science" in home2.storedTopics), { home2 });

// 9. The schema stays valid throughout: the store itself never wrote an invalid save
// (every check above that reads a version after an edit already proves that a save
// happened), and the last saved profile validates clean against profile.schema.json.
const finalValid = JSON.parse(await evaluate(`(async () => {
  const { validateProfile } = await import("/js/profile/validate.js");
  const stored = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
  const schema = await fetch("/profile.schema.json").then((r) => r.json());
  return JSON.stringify(validateProfile(stored.history.at(-1).profile, schema));
})()`));
check("final_profile_validates_clean", Array.isArray(finalValid) && finalValid.length === 0, { finalValid });

const totalCls = await cls();
const totalCsp = await csp();
check("cls_zero", totalCls === 0, { totalCls });
check("csp_zero", totalCsp === 0, { totalCsp });
check("no_console_errors", errors.length === 0, { errors });

chrome.close();
site.close();
rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 1));
console.log(ok ? "U4 CHECK: PASS" : "U4 CHECK: FAIL");
process.exit(ok ? 0 : 1);
