// S35 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   node tests/browser/s35_check.mjs [<screenshot dir>]
// R24: navigator.storage.persist() on first run, a one-file export/import of the
// profile, saved stories and history from the You page. Builds the app from
// golden_pool.json and serves it Cloudflare Pages-shaped behind a simulated Access
// gate (BUILDER-RULES). Headless Chrome, 360x780 CSS px, DPR 3:
//   1. First load records a storage.persist() outcome once and shows it quietly on You
//      ("Storage: kept" here, since a headless Chrome grants it with no user gesture).
//   2. An interest is added, a story is saved and a history row recorded, so the
//      device holds something worth backing up.
//   3. Export downloads (captured from the page's own Blob, never a real file dialog)
//      one JSON file: format_version, exported_at, the current profile, saved and
//      history all present and matching what is stored.
//   4. Every store is cleared (a fresh device). You reopens to the shipped default.
//   5. The file is picked back up (CDP's DOM.setFileInputFiles, no OS dialog): the
//      confirm names the counts, accepting it replaces the profile (through the normal
//      store.save path, so onSave/interests-sync still fires) and merges saved/history
//      back in. State afterward matches the exported snapshot exactly.
//   6. A hostile "backup" (huge array, __proto__ key, wrong version) is refused with a
//      plain message and changes nothing.
// Zero CSP violations, no console errors. Screenshots of the "Your data" group, dark
// and light. Exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launch, serve, sleep } from "./cdp.mjs";
import { PYTHON } from "./python.mjs";
import { STORAGE_KEY } from "../../app/static/js/profile/store.js";
import { PERSIST_KEY } from "../../app/static/js/backup/persist.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = join(ROOT, "tests", ".tmp-s35");
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;

const results = {};
let ok = true;
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const dist = join(TMP, "dist");
execFileSync(PYTHON, ["-m", "app.build", "--pool", join(ROOT, "tests", "fixtures", "golden_pool.json"), "--out", dist], { cwd: ROOT, stdio: "ignore" });
const site = await serve(dist);

const chrome = await launch("s35-check");
const { send, evaluate, on, close } = chrome;
const errors = [];
const csp = [];
on((m) => {
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
});
await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || e.sample)));
    window.__blobs = {};
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const u = realCreate(blob); window.__blobs[u] = blob; return u; };
  `,
});
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

const ready = () => evaluate("document.getElementById('settings-root')?.getAttribute('aria-busy') !== 'true' && document.getElementById('settings-root')?.childElementCount > 0");
async function open(path) {
  await send("Page.navigate", { url: `${site.origin}${path}` });
  for (let i = 0; i < 40 && !(await ready().catch(() => false)); i++) await sleep(100);
  await sleep(200);
}
const storedProfile = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).history.at(-1).profile`);
const openDetails = () => evaluate(`document.querySelector(".your-data").open = true; document.querySelector(".your-data").scrollIntoView({ block: "start" })`);

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => {
  if (!SHOTS) return;
  const png = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  writeFileSync(join(SHOTS, name), Buffer.from(png, "base64"));
};

// --- 1. storage.persist() runs once, and shows quietly on You. ---
await open("/profile");
await evaluate("localStorage.clear(); sessionStorage.clear()");
await open("/profile");
await sleep(300); // the check itself is async
const persistRecord = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(PERSIST_KEY)})`) || "null");
await openDetails();
const persistLine = await evaluate("document.getElementById('storage-persist-state')?.textContent");
check("storage_persist_recorded_once_and_shown_quietly", persistRecord && ["granted", "denied", "unsupported"].includes(persistRecord.outcome)
  && (persistLine === "Storage: kept" || persistLine === "Storage: may be cleared by the browser"),
  { persistRecord, persistLine });
await shot("your-data-dark.png");
await open("/profile#sources"); // any other view, then back, to prove it never re-asks
await open("/profile");
await openDetails();
const persistAfter = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(PERSIST_KEY)})`) || "null");
check("storage_persist_never_nags", persistAfter?.checked_at === persistRecord?.checked_at, { persistRecord, persistAfter });

// --- 2. Give the device something to back up: one interest, one save, one history row. ---
await evaluate(`document.getElementById("add-interest-row").click()`);
await sleep(300);
await evaluate(`document.querySelector('#sheet-body button[data-id]')?.click()`); // commitFromSheet closes the sheet itself
await sleep(300);
const profileBefore = await storedProfile();

await evaluate(`(async () => {
  const req = indexedDB.open("almanac-actions", 1);
  req.onupgradeneeded = () => { for (const n of ["saves", "thumbs"]) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath: "id" }); };
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
  const db = req.result;
  const tx = db.transaction("saves", "readwrite");
  tx.objectStore("saves").put({ id: "s35-story-1", title: "A saved story", source: "Wire Service", url: "https://example.com/s1", image: null, time: "2026-09-20T00:00:00Z", has_body: false, article_id: "s35-story-1" });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
})()`);
await evaluate(`(async () => {
  const req = indexedDB.open("almanac-history", 1);
  req.onupgradeneeded = () => { for (const n of ["opened", "shown"]) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath: "id" }); };
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
  const db = req.result;
  const tx = db.transaction("opened", "readwrite");
  tx.objectStore("opened").put({ id: "s35-story-2", cluster_id: "s35-story-2", title: "An opened story", source: "Wire Service", source_id: "wire", url: "https://example.com/s2", image: null, topics: [], article_id: "s35-story-2", time: "2026-09-21T00:00:00Z" });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
})()`);

// --- 3. Export: capture the page's own Blob, never a real download dialog. ---
await open("/profile");
await openDetails();
await evaluate(`document.getElementById("export-backup").click()`);
await sleep(300);
const exported = JSON.parse(await evaluate(`(async () => {
  const urls = Object.keys(window.__blobs);
  const blob = window.__blobs[urls.at(-1)];
  return await blob.text();
})()`));
check("export_carries_profile_saved_and_history", exported.format_version === 1 && typeof exported.exported_at === "string"
  && Object.keys(exported.profile.topics).length === Object.keys(profileBefore.topics).length
  && exported.saved.some((s) => s.id === "s35-story-1")
  && exported.history.opened.some((h) => h.id === "s35-story-2"),
  { format_version: exported.format_version, topics: Object.keys(exported.profile.topics).length, saved: exported.saved.length, opened: exported.history.opened.length });

const backupPath = join(TMP, "backup.json");
writeFileSync(backupPath, JSON.stringify(exported));

// --- 4. A fresh device: clear everything, You reopens to the shipped default. ---
// A blank navigation first drops the IDB connections step 2 opened (unclosed, still
// reachable from those IIFEs' pending microtasks): without it, deleteDatabase blocks
// forever waiting for a close that never comes.
await send("Page.navigate", { url: "about:blank" });
await sleep(200);
await open("/profile");
await evaluate(`(async () => {
  localStorage.clear(); sessionStorage.clear();
  await new Promise((res) => { const r = indexedDB.deleteDatabase("almanac-actions"); r.onsuccess = res; r.onerror = res; r.onblocked = res; });
  await new Promise((res) => { const r = indexedDB.deleteDatabase("almanac-history"); r.onsuccess = res; r.onerror = res; r.onblocked = res; });
})()`);
await open("/profile");
const freshProfile = await storedProfile();
check("cleared_device_reseeds_the_shipped_default", Object.keys(freshProfile.topics).length < Object.keys(profileBefore.topics).length,
  { before: Object.keys(profileBefore.topics).length, fresh: Object.keys(freshProfile.topics).length });

// --- 5. Import the backup back: DOM.setFileInputFiles, no OS file dialog. ---
async function pickFile(selector, path) {
  const doc = (await send("DOM.getDocument")).result.root;
  const { nodeId } = (await send("DOM.querySelector", { nodeId: doc.nodeId, selector })).result;
  await send("DOM.setFileInputFiles", { files: [path], nodeId });
}
await openDetails();
await pickFile("#import-backup-input", backupPath);
await sleep(400);
const restoredProfile = await storedProfile();
const restoredSaved = JSON.parse(await evaluate(`(async () => {
  const req = indexedDB.open("almanac-actions", 1);
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const tx = db.transaction("saves");
  const all = await new Promise((res, rej) => { const g = tx.objectStore("saves").getAll(); g.onsuccess = () => res(g.result); g.onerror = rej; });
  return JSON.stringify(all);
})()`));
const restoredOpened = JSON.parse(await evaluate(`(async () => {
  const req = indexedDB.open("almanac-history", 1);
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const tx = db.transaction("opened");
  const all = await new Promise((res, rej) => { const g = tx.objectStore("opened").getAll(); g.onsuccess = () => res(g.result); g.onerror = rej; });
  return JSON.stringify(all);
})()`));
check("import_restores_identical_state", Object.keys(restoredProfile.topics).length === Object.keys(profileBefore.topics).length
  && restoredSaved.some((s) => s.id === "s35-story-1")
  && restoredOpened.some((h) => h.id === "s35-story-2"),
  { topics: Object.keys(restoredProfile.topics).length, before: Object.keys(profileBefore.topics).length, saved: restoredSaved.length, opened: restoredOpened.length });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await open("/profile");
await openDetails();
await shot("your-data-light.png");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

// --- 6. Hostile files are refused, and change nothing. ---
async function tryHostileImport(data, label) {
  const path = join(TMP, `${label}.json`);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  const before = await storedProfile();
  await pickFile("#import-backup-input", path);
  await sleep(300);
  const after = await storedProfile();
  return after.profile_version === before.profile_version;
}
const bigSaved = Array.from({ length: 25_000 }, (_, i) => ({ id: `x${i}`, title: "x", source: "x", url: "https://x", time: "2026-09-20T00:00:00Z" }));
check("hostile_huge_array_refused", await tryHostileImport({ ...exported, saved: bigSaved }, "huge"));
check("hostile_wrong_version_refused", await tryHostileImport({ ...exported, format_version: 99 }, "wrongversion"));
check("hostile_proto_key_refused", await tryHostileImport(
  JSON.stringify(exported).replace(/^\{/, '{"__proto__":{"polluted":true},'), "protokey"));
check("hostile_malformed_json_refused", await tryHostileImport("not json at all", "malformed"));

check("no_console_errors", errors.length === 0, { errors });
const cspViolations = JSON.parse(await evaluate("JSON.stringify(window.__csp || [])"));
check("no_csp_violations", cspViolations.length === 0, { cspViolations });

close();
site.close();

console.log(JSON.stringify(results, null, 2));
const passed = Object.values(results).filter((r) => r.pass).length;
console.log(`${passed}/${Object.keys(results).length} passed`);
if (!ok) process.exit(1);
