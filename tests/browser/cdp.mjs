// S37: a small headless Chrome driver over the DevTools protocol, shared by the
// sanitizer's node test (the real HTML parser) and the CSP browser proof. No npm
// dependencies: Node's own fetch and WebSocket, and the Chrome already on the machine
// (CHROME env, the Windows default path, or /usr/bin/google-chrome on the CI runner).
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { decodeInput } from "../../app/static/js/page-input.js";

// T2: the page's #rank-input is written compact (app/page_input.py). A proof reads it
// decoded, as every reader on the page does: decodeInput in Node, and PAGE_INPUT as an
// expression inside a page-side evaluate (the decoder's own source, then the parse).
export { decodeInput };
export const PAGE_INPUT = `(${decodeInput})(JSON.parse(document.getElementById("rank-input").content.textContent))`;

export const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };

// T1: every wait below is bounded so a wedged Chrome fails fast with a clear message
// instead of hanging node --test (and the CI job) until the outer timeout kills it.
const LAUNCH_TIMEOUT_MS = Number(process.env.CDP_LAUNCH_TIMEOUT_MS) || 15000; // chrome.exe -> a debuggable page target
const CONNECT_TIMEOUT_MS = Number(process.env.CDP_CONNECT_TIMEOUT_MS) || 15000; // WebSocket handshake to that target
// T1: generous. The hand-run proofs share this module and run many CDP commands across
// several real Chrome launches on a developer's own loaded machine, not a clean CI
// runner; a bound tight enough to be a fast CI failure was tripping on ordinary local
// system load, not a hang. Still well under CI's 5-minute job budget even if several
// commands in a row each needed the full wait, and every consumer can override it.
const COMMAND_TIMEOUT_MS = Number(process.env.CDP_COMMAND_TIMEOUT_MS) || 45000; // one CDP command's round trip

/** Reject `promise` with `message` if it has not settled within `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One rule of a Cloudflare Pages _headers file as {name: value}: the `/*` catch-all
 * by default, or the rule for one exact path (H1: `/sw.js`). */
export function parseHeaders(text, rule = "/*") {
  const headers = {};
  let inRule = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { inRule = line.trim() === rule; continue; }
    if (!inRule) continue;
    const at = line.indexOf(":");
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * H5: a simulated Cloudflare Access gate, as BUILDER-RULES asks of every proof. The live
 * site answers any request without the login cookie with a 302 to Access's login page,
 * so a fetch that drops the cookie (H3: a service worker script, a manifest) fails here
 * too instead of passing on a bare server. `launch()` gives its browser the cookie;
 * a Node-side fetch sends ACCESS_HEADERS. Returns true when it answered the request.
 */
export const ACCESS_COOKIE = Object.freeze({ name: "CF_Authorization", value: "ok", httpOnly: true, sameSite: "Lax" });
export const ACCESS_HEADERS = Object.freeze({ cookie: `${ACCESS_COOKIE.name}=${ACCESS_COOKIE.value}` });
export const ACCESS_LOGIN = "https://team.cloudflareaccess.com/cdn-cgi/access/login/almanac";
export function accessGate(req, res) {
  if (/(?:^|;\s*)CF_Authorization=ok(?:;|$)/.test(req.headers.cookie || "")) return false;
  res.writeHead(302, { location: `${ACCESS_LOGIN}?redirect_url=${encodeURIComponent(req.url)}` }).end();
  return true;
}

/**
 * Serve `dir` on 127.0.0.1 the way Cloudflare Pages does for this app, behind the
 * simulated Access gate above (H5), every response
 * carrying `headers` (plus `pathHeaders[path]` for one exact path). H1: including Pages'
 * pretty URLs, since S18's proof missed a blank screen by serving `.html` files as is:
 * `/x.html` answers 308 to `/x` (`/index.html` to `/`), and `/x` serves `x.html`.
 * `extra` maps a path to a body, served as is, or to a `(req, res, headers)` handler
 * that answers the request itself (H1: a redirect to a login page). The returned site's
 * `gated` starts true; a proof replaying the time before Access existed (sw_pretty_urls'
 * S18 phone) sets it false for that stretch only.
 */
export async function serve(dir, headers = {}, extra = {}, pathHeaders = {}) {
  const root = resolve(dir);
  const site = { gated: true };
  const server = createServer((req, res) => {
    if (site.gated && accessGate(req, res)) return;
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    const own = { ...headers, ...(pathHeaders[pathname] || {}) };
    if (typeof extra[pathname] === "function") { extra[pathname](req, res, own); return; }
    if (extra[pathname] !== undefined) {
      res.writeHead(200, { ...own, "content-type": TYPES[extname(pathname) || ".html"] }).end(extra[pathname]);
      return;
    }
    const file = (p) => join(root, p);
    const inRoot = (p) => p.startsWith(root) && existsSync(p) && statSync(p).isFile();
    if (pathname.endsWith(".html") && inRoot(file(pathname))) {
      const pretty = pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : pathname.slice(0, -".html".length);
      res.writeHead(308, { ...own, location: pretty + url.search }).end();
      return;
    }
    let path = file(pathname.endsWith("/") ? pathname + "index.html" : pathname);
    if (!inRoot(path) && !extname(pathname) && inRoot(file(pathname + ".html"))) path = file(pathname + ".html");
    if (!inRoot(path)) { res.writeHead(404, own).end(); return; }
    res.writeHead(200, { ...own, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  return Object.assign(site, { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
}

/** Launch headless Chrome on one page target; returns send, evaluate, events and close.
 * `userDataDir` pins the profile dir instead of a fresh mkdtemp one, so a second launch
 * against the same dir sees the first's on-disk Cache Storage and SW registrations, a
 * real Chrome process exit and restart, the least ambiguous "close the app, reopen it"
 * a test can drive (S18's pwa_cls.mjs, checking a waiting worker's own activation).
 * `app: <url>` launches the target as an app window on that URL, and pages under it
 * match `(display-mode: standalone)`. The window loads the URL before this function can
 * give it the Access cookie, so a proof lifts its gate for the launch (site.gated). */
export async function launch(name, { userDataDir, app = false } = {}) {
  if (!CHROME) throw new Error("no Chrome found: set CHROME");
  const port = 9300 + Math.floor(Math.random() * 600);
  // S18: back/forward cache keeps a page navigated away from alive as a service worker
  // client, which stalls a waiting worker's activation in a same-tab navigate/reload
  // loop (pwa_cls.mjs); off is also just a more deterministic default for CDP-driven
  // navigation generally, and no other browser test here relies on bfcache being on.
  const dir = userDataDir || mkdtempSync(join(tmpdir(), `${name}-`));
  const args = ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-features=BackForwardCache"];
  // T1: --disable-dev-shm-usage avoids the classic CI crash-on-launch when the runner's
  // /dev/shm is small; --no-sandbox because the CI runner's kernel may refuse the sandbox.
  if (process.env.CI) args.push("--no-sandbox", "--disable-dev-shm-usage");
  // H8: `app` (a URL) opens the page target as an app window on that URL (--app), whose
  // display mode is standalone, as the installed PWA on the owner's phone is, for pages
  // inside it; a plain tab is "browser".
  const chrome = spawn(CHROME, [...args, app ? `--app=${app}` : "about:blank"], { stdio: "ignore" });
  let killed = false;
  const killChrome = () => { if (killed) return; killed = true; try { chrome.kill(); } catch {} };
  // T1: everything from here on is inside a try/catch so any failure -- the launch
  // wait, the WebSocket handshake, or an unexpected throw -- kills the process this
  // function spawned before rethrowing. Without this, a rejection here would leak the
  // Chrome process forever: the caller never received a `chrome` handle to close.
  let ws;
  try {
    let target;
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (!target && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        target = (await res.json()).find((t) => t.type === "page");
      } catch { /* not listening yet, or not ready */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error(`Chrome did not start (no debuggable page target within ${LAUNCH_TIMEOUT_MS}ms)`);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await withTimeout(
      new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("Chrome DevTools socket errored while connecting")); }),
      CONNECT_TIMEOUT_MS, `Chrome DevTools socket did not open within ${CONNECT_TIMEOUT_MS}ms`);
  } catch (err) {
    try { ws?.close(); } catch {}
    killChrome();
    throw err;
  }
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    const reply = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(reply, COMMAND_TIMEOUT_MS, `Chrome did not respond to ${method} within ${COMMAND_TIMEOUT_MS}ms`)
      .finally(() => pending.delete(id));
  };
  const evaluate = async (expression) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  const close = () => { try { ws.close(); } catch {} killChrome(); };
  // H5: this browser holds the Access login cookie for every local origin (a cookie
  // ignores the port), so each page, worker and manifest request it makes passes
  // serve()'s gate the way the owner's phone passes Cloudflare Access.
  try {
    await send("Network.setCookie", { ...ACCESS_COOKIE, url: "http://127.0.0.1/" });
  } catch (err) {
    close();
    throw err;
  }
  return { send, evaluate, on: (fn) => listeners.push(fn), close, userDataDir: dir };
}
