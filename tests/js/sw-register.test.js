// H3 proof: sw-register.js registers a classic worker (a module worker's script is
// fetched without cookies, so it cannot install behind Cloudflare Access), and when a
// new worker takes the page over it asks again for every photo that had failed, and
// only those. Runs the real file in a vm context with a fake navigator and document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../../app/static/js/sw-register.js", import.meta.url), "utf8");

function run(images) {
  const on = {};
  const registered = [];
  vm.runInNewContext(SRC, {
    navigator: {
      serviceWorker: {
        addEventListener: (type, fn) => { on[`sw:${type}`] = fn; },
        register: (url, options) => { registered.push([url, options]); return Promise.resolve(); },
      },
    },
    window: { addEventListener: (type, fn) => { on[`window:${type}`] = fn; } },
    document: { images },
  });
  return { on, registered };
}

function img(src, complete, naturalWidth) {
  const attrs = src === null ? {} : { src };
  const sets = [];
  return {
    complete, naturalWidth, sets,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { sets.push([name, value]); attrs[name] = value; },
  };
}

test("registers /sw.js as a classic worker after load, never through the HTTP cache", () => {
  const { on, registered } = run([]);
  assert.deepEqual(registered, []); // deferred past load
  on["window:load"]();
  assert.equal(registered.length, 1);
  const [url, options] = registered[0];
  assert.equal(url, "/sw.js");
  assert.equal(options.type, undefined); // classic, the default
  assert.equal(options.updateViaCache, "none");
});

test("on takeover, every failed photo is asked for again and nothing else is touched", () => {
  const failed = img("https://images.example/a.jpg", true, 0);
  const loaded = img("https://images.example/b.jpg", true, 640);
  const pending = img("https://images.example/c.jpg", false, 0); // lazy, not asked for yet
  const empty = img(null, true, 0);
  const { on } = run([failed, loaded, pending, empty]);
  on["sw:controllerchange"]();
  assert.deepEqual(failed.sets, [["src", "https://images.example/a.jpg"]]);
  assert.deepEqual(loaded.sets, []);
  assert.deepEqual(pending.sets, []);
  assert.deepEqual(empty.sets, []);
});
