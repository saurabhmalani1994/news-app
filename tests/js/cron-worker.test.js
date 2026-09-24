// C1 proof: the cron Worker's dispatch logic (triggerPublish) with a mocked fetch, and
// its fetch() route, which must never do anything. scheduled() itself needs a live
// Workers runtime cron (proved for real by watching the deploy-cron workflow and a
// manual `gh workflow run publish.yml -f trigger=cron`), so this test covers what
// node --test can check directly: the request triggerPublish makes, and that a request
// to the Worker's own URL never reaches any logic.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { DISPATCH_URL, triggerPublish } from "../../cron/worker.js";

test("token present: one POST to the dispatch URL, with the right headers and body", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  await triggerPublish({ GH_DISPATCH_TOKEN: "secret-token" }, fakeFetch);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DISPATCH_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(calls[0].init.headers["User-Agent"]);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: "main",
    inputs: { trigger: "cron" },
  });
});

test("token absent: no fetch call at all", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response(null, { status: 204 });
  };

  await triggerPublish({}, fakeFetch);
  await triggerPublish(undefined, fakeFetch);

  assert.equal(called, false);
});

test("non-204 response is logged with its status, never the token", async () => {
  const fakeFetch = async () => new Response("nope", { status: 422 });
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await triggerPublish({ GH_DISPATCH_TOKEN: "super-secret-value" }, fakeFetch);
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.length, 1);
  assert.match(logs[0], /422/);
  assert.ok(!logs[0].includes("super-secret-value"));
});

test("fetch() route returns 404 for any request", async () => {
  const request = new Request("https://almanac-cron.example.workers.dev/anything");
  const response = await worker.fetch(request, {}, {});
  assert.equal(response.status, 404);
});

test("scheduled() hands ctx.waitUntil a promise (no token, so no real network call)", async () => {
  let waited;
  const ctx = { waitUntil: (p) => { waited = p; } };
  await worker.scheduled({}, {}, ctx);
  assert.ok(waited && typeof waited.then === "function");
  await waited; // does not throw; logs "no token, skipping" and returns
});
