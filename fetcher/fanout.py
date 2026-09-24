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

Usage: python -m fetcher.fanout --out dist/pool.json --sources sources.json
"""
import argparse
import concurrent.futures
import hashlib
import json
import socket
import sys
import time
import urllib.error
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from contract.validate import validate
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
MAX_WORKERS = 32


class SourcesError(Exception):
    """sources.json is missing a required field or has a duplicate id."""


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
    """
    if fetch_fn is None:
        fetch_fn = fetch_feed

    def _job(source):
        return source["id"], _fetch_with_retry(source["feed_url"], fetch_fn, timeout, retries)

    results = {}
    workers = max(1, min(max_workers, len(sources)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for sid, outcome in ex.map(_job, sources):
            results[sid] = outcome
    return results


def _extract_article(item, source_id, seen_urls, leniency, drops):
    """Build one article dict from an <item>, or return None (the drop reason is
    already counted). Mirrors fetcher.fetch.build_pool's per-item rules exactly."""
    raw_title = _clean(_text(item, "title"))
    title = _plain(raw_title)
    if title != raw_title:
        leniency["title_markup"] += 1
    if not title:
        drops["no_title"] += 1
        return None
    url = _text(item, "link").strip()
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
    return article


def build_pool_fanout(sources, fetch_results, now, per_source_cap=PER_SOURCE_CAP):
    """Turn fetch results for every source into one pool dict. Pure: no network, no clock."""
    leniency = Counter()
    drops = Counter()
    feed_states = Counter()
    articles = []
    seen_urls = set()
    fetched_total = 0

    for source in sources:
        sid = source["id"]
        data, transport_state = fetch_results[sid]
        if data is None:
            feed_states[transport_state] += 1
            continue
        try:
            root = parse_xml(data, leniency)
        except FeedError:
            feed_states["parse_error"] += 1
            continue
        items = list(root.iter("item"))
        if not items:
            feed_states["empty"] += 1
            continue
        feed_states["ok"] += 1
        fetched_total += len(items)
        published_this_source = 0
        for item in items:
            article = _extract_article(item, sid, seen_urls, leniency, drops)
            if article is None:
                continue
            if published_this_source >= per_source_cap:
                drops["over_cap"] += 1
                continue
            seen_urls.add(article["url"])
            articles.append(article)
            published_this_source += 1

    counts = {
        "fetched": fetched_total,
        "published": len(articles),
        "drops": dict(sorted(drops.items())),
        "leniency": dict(sorted(leniency.items())),
        "feed_states": {k: feed_states.get(k, 0) for k in FEED_STATES},
    }
    _assert_ledger_invariant(counts)
    return {
        "schema_version": 1,
        "generated_at": _utc(now),
        "sources": [
            {"id": s["id"], "name": s["name"], "feed_url": s["feed_url"]} for s in sources
        ],
        "articles": articles,
        "clusters": [],
        "counts": counts,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="dist/pool.json")
    ap.add_argument("--sources", default="sources.json")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    ap.add_argument("--per-source-cap", type=int, default=PER_SOURCE_CAP)
    args = ap.parse_args(argv)

    try:
        sources = load_sources(args.sources)
    except (OSError, ValueError, SourcesError) as exc:
        print(f"BAD SOURCES FILE: {exc}", file=sys.stderr)
        return 1

    t0 = time.monotonic()
    fetch_results = fetch_all(sources, timeout=args.timeout, retries=args.retries)
    pool = build_pool_fanout(
        sources, fetch_results, datetime.now(timezone.utc), per_source_cap=args.per_source_cap
    )
    errors = validate(pool)
    if errors:
        print(f"INVALID POOL, not written: {errors[:10]}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    body = dumps(pool).encode("utf-8")
    out.write_bytes(body)
    c = pool["counts"]
    print(
        f"sources={len(sources)} feed_states={json.dumps(c['feed_states'])} "
        f"fetched={c['fetched']} published={c['published']} "
        f"leniency={sum(c['leniency'].values())} drops={json.dumps(c['drops'])} "
        f"bytes={len(body)} seconds={time.monotonic() - t0:.2f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
