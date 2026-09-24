"""S05: concurrent feed fanout. Standard library only (R30).

Reads sources.json, fetches every configured feed concurrently with a thread pool
(I/O bound, so threads are enough), a per-feed timeout and one retry. Every feed
ends in exactly one state, a closed set separate from the item-level drop reasons
S02 already owns: ok, empty, http_error, timeout, parse_error. A feed that fails
does not stop the run; the pool publishes with whatever fed successfully (R9, R11).

Within a feed that did parse, item extraction and R9 leniency reuse the same rules
as the S01 single-feed fetcher (fetcher.fetch), just applied per source instead of
to one hardcoded feed. Articles are capped per source so the published pool holds
near the 400KB size target in DESIGN-v1.1 R12; anything past the cap is counted
over_cap, the reason key S01/S02 already reserved for it.

S07: clustering (fetcher.cluster) runs over every item that survives the item-level
checks, before the cap, so a story's coverage is measured across all fetched items
rather than the first few per feed. The cap is applied after clustering: each source
keeps its first per_source_cap items in feed order, plus up to cluster_extra_cap more
that belong to a multi-source cluster, so a big story is not cut off at item six.
Worst case is (cap + extra) x sources articles, 8 x 61 = 488, which at the measured
~620 bytes per article stays under the 400KB target. Published clusters list only
published articles; a cluster left with fewer than two is not published.

S06: every configured source also gets a health entry (fetcher.health), carrying
consecutive-empty and consecutive-error run counters forward from the previously
published pool. See fetcher/health.py for where that state lives and why.

F6: that carry-forward state (S06 health, S32 event holds) is read from a small
state.json actions/cache restores locally, before the network read fetcher.health
still falls back to when the cache is absent or corrupt. See fetcher/state.py.

Usage: python -m fetcher.fanout --out dist/pool.json --sources sources.json
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from contract.validate import validate
from fetcher.bodies import collect_bodies, extract_body_html, write_bodies
from fetcher.cluster import cluster_items, method_for
from fetcher.events import build_events, parse_previous_events
from fetcher.images import extract_image, filter_placeholder_logos, tally_found
from fetcher.taxonomy import validate_sources_taxonomy
from fetcher.geo import tag_geo
from fetcher.topics import hard_news_topics, load_topics, tag_article
from fetcher.health import compute_source_health, fetch_previous_pool, parse_previous_health
from fetcher.state import DEFAULT_STATE_PATH, load_state, write_state
from fetcher.fetch import (
    DEK_MAX,
    TITLE_MAX,
    FeedError,
    _assert_ledger_invariant,
    _clean,
    _plain,
    _published_at,
    _text,
    _utc,
    dumps,
    fetch_feed,
    parse_xml,
)

FEED_STATES = ("ok", "empty", "http_error", "timeout", "parse_error")
DEFAULT_TIMEOUT = 12
DEFAULT_RETRIES = 1
PER_SOURCE_CAP = 5
CLUSTER_EXTRA_CAP = 3
MAX_WORKERS = 32

# F3: a source may name an explicit fetch route in sources.json when its direct
# feed_url is blocked from GitHub Actions' network but reachable another way. "via"
# is one of ROUTES (absent means "direct", the plain feed_url fetch every source used
# before F3); "via_url" is the URL actually fetched for that route. feed_url itself is
# never changed, so dropping "via"/"via_url" reverts a source to direct with no other
# edit (R: visible and reversible routing, not a silent swap).
ROUTES = ("direct", "relay", "google_news")
GOOGLE_NEWS_HOST = "news.google.com"
_HREF_RE = re.compile(r'href="([^"]+)"')

# F4: the relay Worker's own host, named once here rather than in every relay source's
# via_url. A relay source in sources.json sets "via_url" to just the path
# ("/feed/<id>"); _fetch_url_for joins it onto this base. RELAY_BASE_URL is
# overridable with the RELAY_BASE_URL env var (same pattern publish.yml already uses
# for PREVIOUS_POOL_URL) so a relay redeploy to a new URL is a one-line change, never
# a sources.json edit.
RELAY_BASE_URL = os.environ.get(
    "RELAY_BASE_URL", "https://almanac-relay.saurabhmalani1994.workers.dev"
)


def _route_for(source):
    return source.get("via") or "direct"


def _fetch_url_for(source):
    via_url = source.get("via_url")
    if via_url and source.get("via") == "relay" and not via_url.startswith(("http://", "https://")):
        return RELAY_BASE_URL.rstrip("/") + via_url
    return via_url or source["feed_url"]


def _google_news_real_url(item):
    """Return the outlet's own article URL if the feed item's own description
    carries one outside Google's redirect host, else None. Google News RSS items
    normally only link back through news.google.com (confirmed live for all four
    F3 outlets), so this is usually None and the caller keeps Google's redirect
    link rather than inventing a URL the feed never actually gave it."""
    desc = _text(item, "description")
    for href in _HREF_RE.findall(desc):
        if GOOGLE_NEWS_HOST not in href:
            return href
    return None


class SourcesError(Exception):
    """sources.json is missing a required field, has a duplicate id, or breaks the
    closed lean/ownership/syndication shape (S08)."""


def load_sources(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    sources = doc["sources"]
    seen = set()
    for s in sources:
        for field in ("id", "name", "feed_url", "bucket"):
            if not s.get(field):
                raise SourcesError(f"source missing {field!r}: {s}")
        if s["id"] in seen:
            raise SourcesError(f"duplicate source id {s['id']!r}")
        seen.add(s["id"])
    taxonomy_errors = validate_sources_taxonomy(sources)
    if taxonomy_errors:
        raise SourcesError("; ".join(taxonomy_errors))
    return sources


def _fetch_with_retry(url, fetch_fn, timeout, retries):
    """Return (data, None) on success, or (None, state) after exhausting retries."""
    last_state = "http_error"
    for _ in range(retries + 1):
        try:
            return fetch_fn(url, timeout=timeout), None
        except FeedError:
            last_state = "http_error"
        except urllib.error.HTTPError:
            last_state = "http_error"
        except (socket.timeout, TimeoutError):
            last_state = "timeout"
        except urllib.error.URLError as exc:
            last_state = "timeout" if isinstance(exc.reason, (socket.timeout, TimeoutError)) else "http_error"
        except OSError:
            last_state = "http_error"
    return None, last_state


def fetch_all(sources, fetch_fn=None, timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES,
              max_workers=MAX_WORKERS):
    """Fetch every source concurrently. Returns {source_id: (data_or_None, transport_state_or_None)}.

    fetch_fn defaults to the real fetch_feed, looked up at call time (not baked in as a
    default argument) so tests can monkeypatch this module's fetch_feed name and have it
    take effect even through main()'s indirect call.

    F3: each source's own route decides which URL is actually fetched (_fetch_url_for:
    via_url when the source names one, else its plain feed_url), so a relay or Google
    News route is completely transparent from here down; the rest of the pipeline never
    needs to know a source's items came from anywhere but feed_url.
    """
    if fetch_fn is None:
        fetch_fn = fetch_feed

    def _job(source):
        return source["id"], _fetch_with_retry(_fetch_url_for(source), fetch_fn, timeout, retries)

    results = {}
    workers = max(1, min(max_workers, len(sources)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for sid, outcome in ex.map(_job, sources):
            results[sid] = outcome
    return results


def _extract_article(item, source_id, seen_urls, leniency, drops, source_bucket=None, topics_doc=None,
                      image_rejected=None, is_google_news=False):
    """Build one article dict from an <item>, or return None (the drop reason is
    already counted). Mirrors fetcher.fetch.build_pool's per-item rules exactly.

    S08: when topics_doc is given, every returned article also carries a deterministic
    "topics" tag list, computed from source_bucket plus the article's own title and dek.

    S38: when image_rejected (a Counter) is given, the article also gets a best-effort
    image from the feed's own fields (fetcher.images.extract_image), plus a scratch
    "_image_method" field that build_pool_fanout consumes and strips before publish;
    universal rejections land in image_rejected as they happen.

    F3: when is_google_news is set, the source's configured route is Google News
    per-outlet RSS (via_url), whose <link> is normally a news.google.com redirect
    rather than the real article URL. _google_news_real_url is tried first; only when
    the item's own content actually carries a direct outlet link does this swap it in,
    otherwise Google's redirect link is published unchanged (still a valid, working
    link for the reader).
    """
    raw_title = _clean(_text(item, "title"))
    title = _plain(raw_title)
    if title != raw_title:
        leniency["title_markup"] += 1
    if not title:
        drops["no_title"] += 1
        return None
    url = _text(item, "link").strip()
    if is_google_news:
        url = _google_news_real_url(item) or url
    if not url.startswith(("http://", "https://")):
        guid = item.find("guid")
        guid_url = _text(item, "guid").strip()
        permalink = guid is None or guid.get("isPermaLink", "true") != "false"
        if permalink and guid_url.startswith(("http://", "https://")):
            url = guid_url
            leniency["link_from_guid"] += 1
        else:
            drops["bad_url"] += 1
            return None
    if any(c.isspace() for c in url) or len(url) > 2048:
        drops["bad_url"] += 1
        return None
    if url in seen_urls:
        drops["duplicate_url"] += 1
        return None
    published = _published_at(_text(item, "pubDate"), leniency)
    if published is None:
        drops["no_date"] += 1
        return None
    article = {
        "id": hashlib.sha256(url.encode("utf-8")).hexdigest()[:16],
        "source_id": source_id,
        "url": url,
        "title": title[:TITLE_MAX],
        "published_at": published,
    }
    dek = _plain(_text(item, "description"))[:DEK_MAX]
    if dek:
        article["dek"] = dek
    if topics_doc is not None:
        # G1: geography from the article's own text; singapore and asia topics follow it.
        article["geo"] = tag_geo(source_bucket, title, dek)
        article["topics"] = tag_article(source_bucket, title, dek, topics_doc, geo=article["geo"])
    if image_rejected is not None:
        image, method = extract_image(item, image_rejected)
        if image is not None:
            article["image"] = image
            article["_image_method"] = method
    return article


def build_pool_fanout(sources, fetch_results, now, per_source_cap=PER_SOURCE_CAP,
                      cluster_extra_cap=CLUSTER_EXTRA_CAP, timings=None, topics_doc=None,
                      previous_health=None, previous_pool_status="absent", bodies_out=None,
                      previous_events=None):
    """Turn fetch results for every source into one pool dict. Pure: no network, no clock.

    timings, if a dict is passed, receives the clustering wall time in seconds.
    topics_doc defaults to the repo's topics.json (S08); every article gets a
    deterministic "topics" tag list from its source's bucket and its own text.

    S06: previous_health is the source_health block read back from the previously
    published pool (fetcher.health.fetch_previous_health), or None/{} when there was
    none to read; previous_pool_status records why, straight into the ledger.

    S22: bodies_out, if a dict is passed, receives {"bodies": {article_id: body_dict}}
    for the run's full_text_ok articles, so main() can write bodies/<id>.json without
    this function doing any filesystem I/O itself. Every published article that got a
    body also gets has_body=True set on its own dict here.

    S32: previous_events is fetcher.events.parse_previous_events' state from the
    previous pool, or None for a clean start; it carries the Live slot's hold across
    runs (fetcher/events.py has the state machine).
    """
    if topics_doc is None:
        topics_doc = load_topics()
    leniency = Counter()
    drops = Counter()
    feed_states = Counter()
    image_rejected = Counter()
    per_source = {}
    run_states = {}
    body_candidates = {}
    fetched_total = 0

    for source in sources:
        sid = source["id"]
        data, transport_state = fetch_results[sid]
        if data is None:
            feed_states[transport_state] += 1
            run_states[sid] = (transport_state, 0, None)
            continue
        try:
            root = parse_xml(data, leniency)
        except FeedError:
            feed_states["parse_error"] += 1
            run_states[sid] = ("parse_error", 0, None)
            continue
        items = list(root.iter("item"))
        if not items:
            feed_states["empty"] += 1
            run_states[sid] = ("empty", 0, None)
            continue
        feed_states["ok"] += 1
        fetched_total += len(items)
        kept = per_source.setdefault(sid, [])
        for item in items:
            # The duplicate url check waits for the publish step below, so a url capped
            # out of one feed can still publish from a later feed, as before S07.
            article = _extract_article(item, sid, frozenset(), leniency, drops,
                                        source_bucket=source.get("bucket"), topics_doc=topics_doc,
                                        image_rejected=image_rejected,
                                        is_google_news=_route_for(source) == "google_news")
            if article is not None:
                kept.append(article)
                # S22: only ever look at the feed's own item, and only for a source
                # already claiming full_text_ok, so a body can never come from
                # anywhere but the feed content of a source meant to have one.
                if source.get("full_text_ok"):
                    body_candidates[article["id"]] = extract_body_html(item)
        item_time = max((a["published_at"] for a in kept), default=None)
        run_states[sid] = ("ok", len(items), item_time)

    candidates, seen_ids = [], set()
    for source in sources:
        for article in per_source.get(source["id"], []):
            if article["id"] not in seen_ids:  # one url is one article to the clusterer
                seen_ids.add(article["id"])
                candidates.append(article)
    t0 = time.perf_counter()
    all_clusters = cluster_items(candidates)
    if timings is not None:
        timings["cluster_seconds"] = time.perf_counter() - t0
        timings["cluster_input"] = len(candidates)

    by_id = {a["id"]: a for a in candidates}
    multi_source = set()
    for cl in all_clusters:
        if len({by_id[i]["source_id"] for i in cl["article_ids"]}) > 1:
            multi_source.update(cl["article_ids"])

    articles = []
    published_urls = set()
    for source in sources:
        kept = extra = 0
        for article in per_source.get(source["id"], []):
            if article["url"] in published_urls:
                drops["duplicate_url"] += 1
                continue
            if kept < per_source_cap:
                kept += 1
            elif article["id"] in multi_source and extra < cluster_extra_cap:
                extra += 1
            else:
                drops["over_cap"] += 1
                continue
            published_urls.add(article["url"])
            articles.append(article)

    # S38: the repeated-placeholder check needs every published article for a source
    # at once, so it runs here, after capping, as a second pass; tally_found then
    # strips the "_image_method" scratch field from every article, kept or not.
    filter_placeholder_logos(articles, image_rejected)
    image_found = tally_found(articles)

    # S22: bodies are computed from the final published article list (post-cap,
    # post-dedup), so only articles that actually made the pool ever get a file
    # (R12: old bodies need not be kept, only current pool articles need files).
    bodies, body_counts = collect_bodies(sources, articles, body_candidates)
    for article in articles:
        if article["id"] in bodies:
            article["has_body"] = True
    if bodies_out is not None:
        bodies_out["bodies"] = bodies

    source_lean = {s["id"]: s["lean"] for s in sources if s.get("lean")}
    source_syndication = {s["id"]: s.get("syndication_group") or s["id"] for s in sources}
    clusters = _published_clusters(all_clusters, {a["id"] for a in articles}, by_id,
                                    source_lean, source_syndication)

    generated_at = _utc(now)
    source_health = compute_source_health(sources, run_states, previous_health, generated_at)
    events = build_events(articles, clusters, sources, now, hard_news_topics(topics_doc),
                          previous_events)

    # F3: how many sources are configured on each fetch route, regardless of whether
    # this run's fetch happened to succeed (feed_states already covers success/failure
    # per source); this is purely "which route is wired", visible in every run.
    route_counts = Counter(_route_for(s) for s in sources)
    counts = {
        "fetched": fetched_total,
        "published": len(articles),
        "drops": dict(sorted(drops.items())),
        "leniency": dict(sorted(leniency.items())),
        "feed_states": {k: feed_states.get(k, 0) for k in FEED_STATES},
        "previous_pool_status": previous_pool_status,
        "images": {
            "found": dict(sorted(image_found.items())),
            "rejected": dict(sorted(image_rejected.items())),
        },
        "bodies": body_counts,
        "routes": {r: route_counts.get(r, 0) for r in ROUTES},
    }
    _assert_ledger_invariant(counts)
    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "sources": [
            {"id": s["id"], "name": s["name"], "feed_url": s["feed_url"]} for s in sources
        ],
        "articles": articles,
        "clusters": clusters,
        "counts": counts,
        "source_health": source_health,
        "events": events,
    }


def _published_clusters(all_clusters, published, by_id, source_lean=None, source_syndication=None):
    """Restrict clusters to published articles. The id is the earliest published member's,
    so it holds steady as later coverage joins.

    S08: independent_sources counts distinct syndication groups among the cluster's
    sources, not distinct source_ids, so two outlets carrying the same wire copy count
    as one independent source (fixes the S07 deferral). lean_buckets is the deduplicated
    set of lean buckets those sources cover.
    """
    source_lean = source_lean or {}
    source_syndication = source_syndication or {}
    out = []
    for cl in all_clusters:
        ids = [i for i in cl["article_ids"] if i in published]
        if len(ids) < 2:
            continue
        dups = [[i for i in g if i in published] for g in cl["near_duplicates"]]
        dups = [g for g in dups if len(g) > 1]
        in_dups = {i for g in dups for i in g}
        units = len(dups) + sum(1 for i in ids if i not in in_dups)
        seed = min(ids, key=lambda i: (by_id[i]["published_at"], i))
        cluster_source_ids = {by_id[i]["source_id"] for i in ids}
        syn_groups = {source_syndication.get(sid, sid) for sid in cluster_source_ids}
        leans = sorted({source_lean[sid] for sid in cluster_source_ids if sid in source_lean})
        out.append({
            "id": f"c_{seed}",
            "method": method_for(units, bool(dups)),
            "article_ids": ids,
            "near_duplicates": dups,
            "independent_sources": len(syn_groups),
            "lean_buckets": leans,
        })
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="dist/pool.json")
    ap.add_argument("--sources", default="sources.json")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    ap.add_argument("--per-source-cap", type=int, default=PER_SOURCE_CAP)
    # S06: never hard-code the live site here. The workflow sets PREVIOUS_POOL_URL
    # (see .github/workflows/publish.yml); a local run with it unset simply starts
    # every source's health counters at zero, recorded as previous_pool_status=absent.
    ap.add_argument("--previous-pool-url", default=os.environ.get("PREVIOUS_POOL_URL", ""))
    # F6: state.json actions/cache restores locally is tried before that network
    # read at all (fetcher/state.py). STATE_PATH mirrors the PREVIOUS_POOL_URL
    # pattern so a local run can point elsewhere without a code change.
    ap.add_argument("--state-path", default=os.environ.get("STATE_PATH", DEFAULT_STATE_PATH))
    args = ap.parse_args(argv)

    try:
        sources = load_sources(args.sources)
    except (OSError, ValueError, SourcesError) as exc:
        print(f"BAD SOURCES FILE: {exc}", file=sys.stderr)
        return 1

    t0 = time.monotonic()
    fetch_results = fetch_all(sources, timeout=args.timeout, retries=args.retries)

    # F6: state.json restored by actions/cache is tried first; only when it is
    # absent or corrupt does this run fall back to the live pool.json read S06 has
    # always used, and only when that also comes up empty (or is not a valid pool,
    # e.g. an Access login page) does every counter start fresh. See fetcher/state.py.
    state_bytes, state_local_status = load_state(args.state_path)
    if state_bytes is not None:
        previous_bytes, previous_pool_status = state_bytes, "cache"
    else:
        previous_bytes, previous_pool_status = fetch_previous_pool(args.previous_pool_url)
    previous_health = {}
    if previous_bytes is not None:
        previous_health, parsed_status = parse_previous_health(previous_bytes)
        if previous_pool_status != "cache":
            previous_pool_status = parsed_status
    previous_events, previous_events_status = parse_previous_events(previous_bytes)
    timings = {}
    bodies_out = {}
    pool = build_pool_fanout(
        sources, fetch_results, datetime.now(timezone.utc), per_source_cap=args.per_source_cap,
        timings=timings, previous_health=previous_health, previous_pool_status=previous_pool_status,
        bodies_out=bodies_out, previous_events=previous_events,
    )
    errors = validate(pool)
    if errors:
        print(f"INVALID POOL, not written: {errors[:10]}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    body = dumps(pool).encode("utf-8")
    out.write_bytes(body)
    write_bodies(bodies_out.get("bodies", {}), out.parent / "bodies")
    # F6: only ever written from a pool that already passed validate() above, so a
    # bad run can never hand the next run bad state either.
    write_state(pool, args.state_path)
    c = pool["counts"]
    lean_counts = Counter(s["lean"] for s in sources if s.get("lean"))
    syn_groups = {s.get("syndication_group") or s["id"] for s in sources}
    topic_counts = Counter(t for a in pool["articles"] for t in a.get("topics", ()))
    r16_clusters = sum(1 for cl in pool["clusters"] if len(cl["lean_buckets"]) >= 2)
    print(
        f"sources={len(sources)} feed_states={json.dumps(c['feed_states'])} "
        f"fetched={c['fetched']} published={c['published']} "
        f"leniency={sum(c['leniency'].values())} drops={json.dumps(c['drops'])} "
        f"clusters={len(pool['clusters'])} "
        f"near_dup_groups={sum(len(k['near_duplicates']) for k in pool['clusters'])} "
        f"cluster_input={timings['cluster_input']} cluster_seconds={timings['cluster_seconds']:.2f} "
        f"bytes={len(body)} seconds={time.monotonic() - t0:.2f}"
    )
    print(
        f"lean_buckets={json.dumps(dict(sorted(lean_counts.items())))} "
        f"syndication_groups={len(syn_groups)} "
        f"topics={json.dumps(dict(sorted(topic_counts.items())))} "
        f"r16_lean_span_clusters={r16_clusters}/{len(pool['clusters'])}"
    )
    unhealthy = sorted(sid for sid, h in pool["source_health"].items() if h["unhealthy"])
    print(
        f"state_local={state_local_status} previous_pool_status={c['previous_pool_status']} "
        f"unhealthy_sources={len(unhealthy)}/{len(sources)} {json.dumps(unhealthy)}"
    )
    routed = sorted(s["id"] for s in sources if _route_for(s) != "direct")
    print(f"routes={json.dumps(c['routes'])} routed_sources={json.dumps(routed)}")
    with_image = sum(1 for a in pool["articles"] if "image" in a)
    hero_worthy = sum(1 for a in pool["articles"] if a.get("image", {}).get("width", 0) >= 600)
    bucket_by_source = {s["id"]: s.get("bucket") for s in sources}
    bucket_totals = Counter(bucket_by_source.get(a["source_id"]) for a in pool["articles"])
    bucket_with_image = Counter(
        bucket_by_source.get(a["source_id"]) for a in pool["articles"] if "image" in a
    )
    share_by_bucket = {
        b: f"{bucket_with_image.get(b, 0)}/{n}" for b, n in sorted(bucket_totals.items())
    }
    articles_by_source = {}
    for a in pool["articles"]:
        articles_by_source.setdefault(a["source_id"], []).append(a)
    sources_no_images = sorted(
        sid for sid, arts in articles_by_source.items()
        if arts and not any("image" in a for a in arts)
    )
    print(
        f"images_found={json.dumps(c['images']['found'])} "
        f"images_rejected={json.dumps(c['images']['rejected'])} "
        f"with_image={with_image}/{c['published']} hero_worthy_600px={hero_worthy} "
        f"share_by_bucket={json.dumps(share_by_bucket)} "
        f"sources_no_images={len(sources_no_images)}/{len(sources)} {json.dumps(sources_no_images)}"
    )
    full_text_sources = sorted(s["id"] for s in sources if s.get("full_text_ok"))
    with_body = sum(1 for a in pool["articles"] if a.get("has_body"))
    print(
        f"full_text_ok_sources={len(full_text_sources)}/{len(sources)} {json.dumps(full_text_sources)} "
        f"bodies_written={c['bodies']['written']} bodies_skipped_teaser={c['bodies']['skipped_teaser']} "
        f"bodies_skipped_cap={c['bodies']['skipped_cap']} bodies_bytes={c['bodies']['bytes']} "
        f"has_body_articles={with_body}/{c['published']}"
    )
    ev = pool["events"]
    live = [e for e in ev if e["live"]]
    print(
        f"previous_events_status={previous_events_status} events={len(ev)} "
        f"eligible={sum(e['eligible'] for e in ev)} live={len(live)} "
        f"live_events={json.dumps([[e['id'], e['label'], e['hype'], e['hold_state'], e['live_since']] for e in live], ensure_ascii=False)} "
        f"held={sum(e['hold_state'] == 'holding' for e in ev)} "
        f"released={sum(e['hold_state'] == 'released' for e in ev)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
