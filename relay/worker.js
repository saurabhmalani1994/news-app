// F3: relay for feeds that GitHub Actions' network cannot reach directly (times_of_israel,
// middle_east_eye, import_ai, indian_express all fetch fine from the owner's PC but are
// blocked from GitHub Actions, confirmed by F2). This Worker serves GET /feed/<source_id>
// for a hard-coded allowlist of exactly those four feed URLs and nothing else, so it is
// not an open proxy and needs no secret. Plain JavaScript, no npm dependencies (R30 spirit
// carried into relay/: runtime code is standard-library-equivalent, no build step).
//
// It fetches upstream with an honest user agent naming the app (never a browser UA),
// passes the body and content type through unchanged, caches each feed at the edge for
// 10 minutes with the Workers Cache API, and returns 404 for any path off the allowlist.

const USER_AGENT = "AlmanacRelay/1.0 (+https://almanac-dt5.pages.dev; personal news reader)";
const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";
const CACHE_SECONDS = 600; // 10 minutes, per brief

// Hard-coded allowlist: source_id -> upstream feed URL. Nothing else is ever fetched.
export const ALLOWLIST = {
  times_of_israel: "https://www.timesofisrael.com/feed/",
  middle_east_eye: "https://www.middleeasteye.net/rss",
  import_ai: "https://importai.substack.com/feed",
  indian_express: "https://indianexpress.com/feed/",
};

const FEED_PATH_RE = /^\/feed\/([a-z0-9_-]+)$/;

// Pure: pulls the source id out of a request path, or null if the path does not match
// the /feed/<id> shape at all. Exported so tests can check the routing logic without a
// network call.
export function sourceIdFromPath(pathname) {
  const m = FEED_PATH_RE.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const sourceId = sourceIdFromPath(url.pathname);
    const upstreamUrl = sourceId ? ALLOWLIST[sourceId] : undefined;
    if (!upstreamUrl) {
      return new Response("not found", { status: 404 });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    const upstream = await fetch(upstreamUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: FEED_ACCEPT },
      redirect: "follow",
    });
    const body = await upstream.arrayBuffer();
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });

    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
