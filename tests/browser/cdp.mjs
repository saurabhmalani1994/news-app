// S37: a small headless Chrome driver over the DevTools protocol, shared by the
// sanitizer's node test (the real HTML parser) and the CSP browser proof. No npm
// dependencies: Node's own fetch and WebSocket, and the Chrome already on the machine
// (CHROME env, the Windows default path, or /usr/bin/google-chrome on the CI runner).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2" };

/** The `/*` rule of a Cloudflare Pages _headers file as {name: value}. */
export function parseHeaders(text) {
  const headers = {};
  let inAll = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { inAll = line.trim() === "/*"; continue; }
    if (!inAll) continue;
    const at = line.indexOf(":");
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * Serve `dir` on 127.0.0.1 the way Pages does for this app: files by path, `/` as
 * index.html, and every response carrying `headers`. `extra` maps a path to a body.
 */
export async function serve(dir, headers = {}, extra = {}) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (extra[pathname] !== undefined) {
      res.writeHead(200, { ...headers, "content-type": TYPES[extname(pathname) || ".html"] }).end(extra[pathname]);
      return;
    }
    const path = join(root, pathname.replace(/\/$/, "/index.html"));
    if (!path.startsWith(root) || !existsSync(path)) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(readFileSync(path));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Launch headless Chrome on one page target; returns send, evaluate, events and close.
 * `userDataDir` pins the profile dir instead of a fresh mkdtemp one, so a second launch
 * against the same dir sees the first's on-disk Cache Storage and SW registrations, a
 * real Chrome process exit and restart, the least ambiguous "close the app, reopen it"
 * a test can drive (S18's pwa_cls.mjs, checking a waiting worker's own activation). */
export async function launch(name, { userDataDir } = {}) {
  if (!CHROME) throw new Error("no Chrome found: set CHROME");
  const port = 9300 + Math.floor(Math.random() * 600);
  // S18: back/forward cache keeps a page navigated away from alive as a service worker
  // client, which stalls a waiting worker's activation in a same-tab navigate/reload
  // loop (pwa_cls.mjs); off is also just a more deterministic default for CDP-driven
  // navigation generally, and no other browser test here relies on bfcache being on.
  const dir = userDataDir || mkdtempSync(join(tmpdir(), `${name}-`));
  const args = ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-features=BackForwardCache"];
  if (process.env.CI) args.push("--no-sandbox"); // the CI runner's kernel may refuse the sandbox
  const chrome = spawn(CHROME, [...args, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 75 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
  }
  if (!target) { chrome.kill(); throw new Error("Chrome did not start"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  const close = () => { try { ws.close(); } catch {} chrome.kill(); };
  return { send, evaluate, on: (fn) => listeners.push(fn), close, userDataDir: dir };
}
