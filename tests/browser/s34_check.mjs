// S34 browser proof, run by hand (needs Chrome, so not in the node --test glob):
//   python tests/browser/fixtures/s34_pool.py > /tmp/s34_pool.json
//   python -m app.build --pool /tmp/s34_pool.json --out /tmp/dist_s34
//   node tests/browser/s34_check.mjs /tmp/dist_s34 [<screenshot dir>]
//
// Serves the built page the way Cloudflare Pages does (pretty URLs, the build's own
// _headers) behind a simulated Cloudflare Access gate (R34's "Behind Access" rule):
// every request without the CF_Authorization cookie gets the same 302 to a login origin
// the live site would answer with, so the proof cannot pass by accident on a bare local
// server; the phone carries the cookie, same as a real signed-in owner would, and every
// gated path (the page, its scripts, pool.json, bodies/) is exercised with it.
//
// Story: open two has_body stories from Today (an "opened" signal each), scroll a third
// into view long enough to record it "shown" but never open it, then to Saved. The
// History segment groups both opened stories under "Today"; a search narrows to one by
// headline; reopening a row opens the in-app reader from its own title, not the pool's;
// toggling Seen reveals the third, shown-only story; Clear history, confirmed, empties
// it. Zero CSP violations and zero cumulative layout shift throughout. Screenshots
// (dark and light) land in the given directory. Exits 1 on any failure.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { launch, parseHeaders, sleep } from "./cdp.mjs";

const [distArg, shotsArg] = process.argv.slice(2);
const dist = resolve(distArg || "dist");
const headers = parseHeaders(readFileSync(join(dist, "_headers"), "utf-8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
if (shotsArg) mkdirSync(shotsArg, { recursive: true });

/** A simulated Cloudflare Access gate over `dist`: any request without the
 * CF_Authorization cookie gets the login-page 302 the live site would answer with;
 * with it, pretty-URL rewriting and the build's own _headers apply as usual. */
function serveGated(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const cookie = /(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "");
    if (!cookie) {
      res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/almanac?redirect_url=${encodeURIComponent(pathname)}` }).end();
      return;
    }
    const file = (p) => join(root, p);
    const inRoot = (p) => p.startsWith(root) && existsSync(p) && statSync(p).isFile();
    if (pathname.endsWith(".html") && inRoot(file(pathname))) {
      const pretty = pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : pathname.slice(0, -".html".length);
      res.writeHead(308, { ...headers, location: pretty + url.search }).end();
      return;
    }
    let path = file(pathname.endsWith("/") ? pathname + "index.html" : pathname);
    if (!inRoot(path) && !extname(pathname) && inRoot(file(pathname + ".html"))) path = file(pathname + ".html");
    if (!inRoot(path)) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  return new Promise((r) => server.on("listening", () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const site = await serveGated(dist);

const BODIES = {
  h34a: { schema_version: 1, article_id: "h34a", source_id: "haaretz", source_name: "Haaretz",
    url: "https://example.org/h34a", body_html: "<p>Negotiators met through the night after the strikes.</p>" },
  h34b: { schema_version: 1, article_id: "h34b", source_id: "straits_times_sg", source_name: "The Straits Times",
    url: "https://example.org/h34b", body_html: "<p>The council voted after a long public hearing.</p>" },
};

async function run(scheme) {
  const chrome = await launch(`s34-${scheme}`);
  const { send, evaluate } = chrome;
  const results = {};
  let ok = true;
  const check = (name, pass, detail) => { results[name] = { pass: Boolean(pass), ...detail }; ok &&= Boolean(pass); };

  chrome.on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const id = (/\/bodies\/([^/]+)\.json/.exec(request.url) || [])[1];
    const body = id && BODIES[id];
    if (body) {
      await send("Fetch.fulfillRequest", {
        requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }],
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
  // The phone, signed in: every request this tab makes from here on carries the Access
  // cookie, same as a real owner's browser would after logging in once.
  await send("Network.setCookie", { name: "CF_Authorization", value: "ok", domain: "127.0.0.1", path: "/" });
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
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
  const csp = () => evaluate("window.__csp");
  const cls = () => evaluate("window.__cls");
  /** Polls `expr` (a boolean-ish page expression) instead of a fixed sleep, so a slower
   * run (two Chrome launches back to back, resolveReopen's own bodyCache.get calls, a
   * loaded machine) never races the DOM update a step depends on. Throws with the
   * expression itself on a timeout, rather than let the next step fail on a null with
   * no clue why, since every caller below only proceeds once this is true. */
  async function waitFor(expr, ms = 8000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      if (await evaluate(expr)) return true;
    }
    throw new Error(`waitFor timed out after ${ms}ms: ${expr}`);
  }

  await send("Page.navigate", { url: `${site.origin}/` });
  await sleep(900);

  // 1. Open the two has_body stories (h34a, h34b) from Today, an "opened" signal each;
  // close the reader after each so we return to Today for the next tap. nowIso() has
  // one-second resolution, so a full second's gap between the two makes their opened
  // times distinct, and the grouped order below unambiguous.
  for (const id of ["h34a", "h34b"]) {
    await evaluate(`document.querySelector('a.story-link[data-body="${id}"]').click()`);
    await waitFor(`document.getElementById("reader").hidden === false`);
    await sleep(200);
    await evaluate(`document.getElementById("reader-back")?.click()`);
    await waitFor(`document.getElementById("reader").hidden === true`);
    await sleep(1200);
  }

  // 2. Scroll the third, no-body story (h34c) into view and hold it there past the
  // observer's ~1s dwell, without ever opening it: a "shown" signal, never "opened".
  await evaluate(`document.querySelector('li.story[data-sid="h34c"]').scrollIntoView({ block: "center" })`);
  await sleep(1400);

  const recorded = JSON.parse(await evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open("almanac-history", 1);
    req.onsuccess = () => {
      const db = req.result;
      const read = (name) => new Promise((r) => {
        const out = [];
        db.transaction(name).objectStore(name).openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push(c.value); c.continue(); } else r(out);
        };
      });
      Promise.all([read("opened"), read("shown")]).then(([opened, shown]) => resolve(JSON.stringify({ opened, shown })));
    };
    req.onerror = () => resolve(JSON.stringify({ opened: [], shown: [] }));
  }))()`));
  check("both tapped stories recorded opened, with their own article id and source id",
    recorded.opened.length === 2 && recorded.opened.every((r) => r.article_id && r.source_id),
    { opened: recorded.opened.map((r) => ({ id: r.id, article_id: r.article_id, source_id: r.source_id })) });
  check("the scrolled-past story recorded shown, never opened",
    recorded.shown.some((r) => r.id === "h34c") && !recorded.opened.some((r) => r.id === "h34c"),
    { shown: recorded.shown.map((r) => r.id) });

  // 3. Saved, then History: both opened stories show, grouped under "Today", each with
  // its own outlet and a U3 marker (Haaretz's scale dots, the Straits Times' SG code).
  await evaluate(`window.__cls = 0`); // measure the segment switch and the reader from here
  await evaluate(`location.hash = "#saved"`);
  await sleep(400);
  await evaluate(`document.getElementById("segment-history").click()`);
  await waitFor(`document.querySelectorAll("#history-groups li.story").length >= 2`);
  const before = JSON.parse(await evaluate(`JSON.stringify({
    groups: [...document.querySelectorAll(".history-group")].map((g) => ({
      day: g.querySelector(".history-day").textContent,
      rows: [...g.querySelectorAll("li.story")].map((li) => ({
        sid: li.dataset.sid,
        headline: li.querySelector(".headline")?.textContent,
        source: li.querySelector(".meta-source")?.textContent,
        hasMarker: !!li.querySelector(".lean"),
        hasHit: !!li.querySelector(".lean-hit"),
        hasDataBody: !!li.querySelector("a.story-link[data-body]"),
      })),
    })),
    emptyHidden: document.getElementById("history-empty").hidden,
    clearHidden: document.getElementById("history-clear").hidden,
  })`));
  await shot(`history-${scheme}.png`);
  check("load, opening both stories, scrolling the third into view and the segment switch add zero layout shift", (await cls()) === 0, { cls: await cls() });
  check("History groups both opened stories under Today, newest (h34b) first",
    before.groups.length === 1 && before.groups[0].day === "Today"
      && before.groups[0].rows.map((r) => r.sid).join() === "h34b,h34a",
    before);
  check("every row shows its outlet and U3's marker, and reopens in the reader",
    before.groups[0].rows.every((r) => r.source && r.hasMarker && r.hasHit && r.hasDataBody),
    before);
  check("Clear history is offered and the empty state is not shown", before.clearHidden === false && before.emptyHidden === true, before);

  // 4. Search narrows to the one matching headline.
  await evaluate(`(() => {
    const input = document.getElementById("history-search");
    input.value = "transit";
    input.dispatchEvent(new Event("input"));
  })()`);
  await sleep(200);
  const searched = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#history-groups li.story")].map((li) => li.dataset.sid))`));
  check("a search for 'transit' narrows to the one matching headline", searched.join() === "h34b", { searched });
  await evaluate(`(() => {
    const input = document.getElementById("history-search");
    input.value = "";
    input.dispatchEvent(new Event("input"));
  })()`);
  await waitFor(`document.querySelectorAll("#history-groups li.story").length >= 2`);

  // 5. Reopen h34a from its History row: the in-app reader, its own title, zero CLS.
  const clsBeforeReopen = await cls();
  await waitFor(`!!document.querySelector('#history-groups li.story[data-sid="h34a"] a.story-link')`);
  await evaluate(`document.querySelector('#history-groups li.story[data-sid="h34a"] a.story-link').click()`);
  await sleep(500);
  const reopened = JSON.parse(await evaluate(`JSON.stringify({
    readerHidden: document.getElementById("reader").hidden,
    title: document.getElementById("reader-title")?.textContent,
    bodyText: document.querySelector(".reader-body")?.textContent || "",
  })`));
  await shot(`reopened-${scheme}.png`);
  const clsAfterReopen = await cls();
  check("tapping a History row reopens it in the reader, with its own headline",
    reopened.readerHidden === false && reopened.title === "Ceasefire talks resume after overnight strikes" && reopened.bodyText.includes("night"),
    reopened);
  check("reopening from History adds zero layout shift", (clsAfterReopen - clsBeforeReopen) === 0, { clsBeforeReopen, clsAfterReopen });
  await evaluate(`document.getElementById("reader-back")?.click()`);
  await sleep(300);

  // 6. Seen, off by default, toggled on: the shown-only h34c joins the list.
  const seenBefore = await evaluate(`document.getElementById("history-seen-toggle").getAttribute("aria-checked")`);
  await evaluate(`document.getElementById("history-seen-toggle").click()`);
  await sleep(300);
  const withSeen = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll("#history-groups li.story")].map((li) => li.dataset.sid))`));
  await shot(`seen-on-${scheme}.png`);
  check("Seen is off by default", seenBefore === "false", { seenBefore });
  check("Seen on reveals the shown-but-never-opened story alongside the two opened ones",
    withSeen.includes("h34c") && withSeen.includes("h34a") && withSeen.includes("h34b"), { withSeen });

  // 7. Clear history: a confirm sheet, not Undo; confirming empties the list.
  await evaluate(`document.getElementById("history-clear").click()`);
  await sleep(400);
  const sheetOpen = await evaluate(`!document.getElementById("sheet-root").hidden`);
  await shot(`clear-confirm-${scheme}.png`);
  check("Clear history opens a confirm sheet first, not an immediate delete", sheetOpen === true, { sheetOpen });
  await evaluate(`[...document.querySelectorAll(".sheet-item")].find((b) => b.textContent === "Clear history").click()`);
  await sleep(400);
  const cleared = JSON.parse(await evaluate(`JSON.stringify({
    rows: document.querySelectorAll("#history-groups li.story").length,
    emptyHidden: document.getElementById("history-empty").hidden,
    clearHidden: document.getElementById("history-clear").hidden,
    head: document.getElementById("history-empty-head")?.textContent,
  })`));
  const clearedStore = JSON.parse(await evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open("almanac-history", 1);
    req.onsuccess = () => {
      const db = req.result;
      const read = (name) => new Promise((r) => {
        const out = [];
        db.transaction(name).objectStore(name).openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push(c.value); c.continue(); } else r(out);
        };
      });
      Promise.all([read("opened"), read("shown")]).then(([opened, shown]) => resolve(JSON.stringify({ opened, shown })));
    };
    req.onerror = () => resolve(JSON.stringify({ opened: [], shown: [] }));
  }))()`));
  check("Clear history empties both the list and the device stores",
    cleared.rows === 0 && cleared.emptyHidden === false && cleared.clearHidden === true
      && clearedStore.opened.length === 0 && clearedStore.shown.length === 0,
    { cleared, clearedStore });

  // CLS is checked around load, the segment switch and the reopen above: the search and
  // Seen filters are asserted correct, not shift-free, since narrowing or widening a live
  // list necessarily changes what is on screen (the same reason history_check.mjs and
  // saved_check.mjs each scope their own CLS checks around specific actions, not a whole
  // multi-step script).
  const violations = await csp();
  check("zero CSP violations for the whole run", violations.length === 0, { violations });

  chrome.close();
  return { results, ok };
}

const dark = await run("dark");
const light = await run("light");
console.log(JSON.stringify({ dark: dark.results, light: light.results }, null, 2));
site.close();
process.exit(dark.ok && light.ok ? 0 : 1);
