// C1: triggers the hourly publish from a Cloudflare Worker Cron Trigger instead of
// relying on GitHub Actions' own `schedule:`, which is best effort and was observed
// firing only twice in about ten hourly slots after it landed on 2026-09-24. Owner
// ruling R44: fire the schedule here, on Cloudflare's clock, and ask GitHub's REST API
// to dispatch the existing publish.yml workflow. This file adds no schedule trigger to
// any GitHub workflow (BUILDER-RULES forbids that); the cron trigger below is a
// Cloudflare Worker feature, approved by the owner for this purpose.
//
// Plain JavaScript, no npm dependencies (R30 spirit carried into cron/ as it is into
// relay/): runtime code is standard-library-equivalent, no build step.
//
// The Worker has no fetch() route that does anything: every HTTP request gets 404, so
// nobody can trigger a publish run by hitting the Worker's URL. Only Cloudflare's own
// cron clock calls scheduled(), which calls triggerPublish().

const DISPATCH_URL =
  "https://api.github.com/repos/saurabhmalani1994/news-app/actions/workflows/publish.yml/dispatches";
const USER_AGENT = "AlmanacCron/1.0 (+https://almanac-dt5.pages.dev; personal news reader)";

// Exported so tests can drive it with a mocked fetch, without a live Workers runtime or
// a real GitHub token. Never logs the token itself, only ever the response status.
export async function triggerPublish(env, fetchImpl = fetch) {
  const token = env && env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.log("no token, skipping");
    return;
  }

  const response = await fetchImpl(DISPATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { trigger: "cron" } }),
  });

  if (response.status !== 204) {
    console.log(`dispatch failed: status=${response.status}`);
  }
}

export { DISPATCH_URL };

export default {
  async fetch(request, env, ctx) {
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerPublish(env));
  },
};
