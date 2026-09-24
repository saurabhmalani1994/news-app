"""S05: feed fanout. No network: every fetch is a fake fetch_fn over fixed URLs."""
import json
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import pytest

from contract.validate import validate
from fetcher.fanout import (
    SourcesError,
    build_pool_fanout,
    fetch_all,
    load_sources,
)

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = (ROOT / "tests/fixtures/sample_feed.xml").read_bytes()  # 6 items, cap 5 -> 1 over_cap
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"

GOOD2 = (
    '<rss version="2.0"><channel>'
    '<item><title>Second source item one</title><link>https://good2.example/a</link>' + DATE + "</item>"
    '<item><title>Second source item two</title><link>https://good2.example/b</link>' + DATE + "</item>"
    "</channel></rss>"
).encode("utf-8")

EMPTY_FEED = b'<rss version="2.0"><channel></channel></rss>'
BROKEN_FEED = b"<rss><channel><item><title>Unclosed</channel>"

def _src(id_, name, url, bucket="general", lean="center", syndication_group=None):
    return {
        "id": id_, "name": name, "feed_url": url, "bucket": bucket,
        "lean": lean, "lean_basis": "test fixture, not a real rating",
        "syndication_group": syndication_group or id_,
    }


SOURCES = [
    _src("good1", "Good One", "https://good1.example/feed.xml"),
    _src("good2", "Good Two", "https://good2.example/feed.xml"),
    _src("slow", "Slow Feed", "https://slow.example/feed.xml"),
    _src("missing", "Missing Feed", "https://missing.example/feed.xml"),
    _src("empty", "Empty Feed", "https://empty.example/feed.xml"),
    _src("broken", "Broken Feed", "https://broken.example/feed.xml"),
]


def _fake_fetch(url, timeout=None):
    if "slow" in url:
        raise TimeoutError("timed out")
    if "missing" in url:
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
    if "broken" in url:
        return BROKEN_FEED
    if "empty" in url:
        return EMPTY_FEED
    if "good1" in url:
        return SAMPLE
    if "good2" in url:
        return GOOD2
    raise AssertionError(f"unexpected url in test: {url}")


def test_each_feed_ends_in_its_own_state_and_the_rest_publish():
    results = fetch_all(SOURCES, fetch_fn=_fake_fetch, timeout=1, retries=1)
    pool = build_pool_fanout(SOURCES, results, NOW)
    c = pool["counts"]

    assert c["feed_states"] == {
        "ok": 2, "empty": 1, "http_error": 1, "timeout": 1, "parse_error": 1,
    }
    assert sum(c["feed_states"].values()) == len(SOURCES)
    assert c["fetched"] == c["published"] + sum(c["drops"].values())

    published_ids = {a["source_id"] for a in pool["articles"]}
    assert published_ids == {"good1", "good2"}
    assert c["published"] == 5 + 2  # good1 capped at 5 of 6, good2's 2 both publish
    assert c["drops"]["over_cap"] == 1

    assert validate(pool) == []


def test_transient_failure_gets_exactly_one_retry():
    calls = []

    def flaky(url, timeout=None):
        calls.append(url)
        raise TimeoutError("timed out")

    slow_source = [s for s in SOURCES if s["id"] == "slow"]
    results = fetch_all(slow_source, fetch_fn=flaky, timeout=1, retries=1)
    assert results["slow"] == (None, "timeout")
    assert len(calls) == 2  # first attempt plus one retry


def test_no_retry_means_a_single_attempt():
    calls = []

    def flaky(url, timeout=None):
        calls.append(url)
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    missing_source = [s for s in SOURCES if s["id"] == "missing"]
    results = fetch_all(missing_source, fetch_fn=flaky, timeout=1, retries=0)
    assert results["missing"] == (None, "http_error")
    assert len(calls) == 1


def test_run_still_publishes_when_some_feeds_fail():
    results = fetch_all(SOURCES, fetch_fn=_fake_fetch, timeout=1, retries=1)
    pool = build_pool_fanout(SOURCES, results, NOW)
    assert pool["counts"]["published"] > 0
    assert validate(pool) == []


def test_feed_states_total_equals_source_count_in_the_ledger():
    results = fetch_all(SOURCES, fetch_fn=_fake_fetch, timeout=1, retries=1)
    pool = build_pool_fanout(SOURCES, results, NOW)
    assert sum(pool["counts"]["feed_states"].values()) == len(pool["sources"])


def test_feed_states_mismatch_rejected_by_validator():
    results = fetch_all(SOURCES, fetch_fn=_fake_fetch, timeout=1, retries=1)
    pool = build_pool_fanout(SOURCES, results, NOW)
    pool["counts"]["feed_states"]["ok"] += 1
    assert validate(pool) != []


def test_per_source_cap_counts_the_rest_as_over_cap():
    only_good1 = [s for s in SOURCES if s["id"] == "good1"]
    results = fetch_all(only_good1, fetch_fn=_fake_fetch, timeout=1)
    pool = build_pool_fanout(only_good1, results, NOW, per_source_cap=5)
    assert pool["counts"]["published"] == 5
    assert pool["counts"]["drops"]["over_cap"] == 1


def test_load_sources_from_repo_file():
    sources = load_sources(ROOT / "sources.json")
    ids = [s["id"] for s in sources]
    assert len(ids) == len(set(ids)), "duplicate source id"
    for s in sources:
        assert s["feed_url"].startswith(("http://", "https://"))
        assert s["bucket"]


def test_sources_file_covers_the_named_buckets():
    sources = load_sources(ROOT / "sources.json")
    buckets = {s["bucket"] for s in sources}
    # R4: Singapore is the source-layer acceptance test, so it must be well covered.
    singapore = [s for s in sources if s["bucket"] == "singapore"]
    assert len(singapore) >= 3
    for expected in ("general", "singapore", "israel_gaza", "sudan", "ai", "biotech", "us_politics", "asia"):
        assert expected in buckets


def test_load_sources_rejects_duplicate_id(tmp_path):
    bad = tmp_path / "sources.json"
    bad.write_text(json.dumps({
        "schema_version": 1,
        "sources": [
            {"id": "dup", "name": "A", "feed_url": "https://a.example/f", "bucket": "general"},
            {"id": "dup", "name": "B", "feed_url": "https://b.example/f", "bucket": "general"},
        ],
    }), encoding="utf-8")
    with pytest.raises(SourcesError):
        load_sources(bad)


def test_load_sources_rejects_missing_field(tmp_path):
    bad = tmp_path / "sources.json"
    bad.write_text(json.dumps({
        "schema_version": 1,
        "sources": [{"id": "x", "name": "X", "feed_url": "https://x.example/f"}],
    }), encoding="utf-8")
    with pytest.raises(SourcesError):
        load_sources(bad)


def test_main_writes_valid_pool_offline(tmp_path, monkeypatch):
    import fetcher.fanout as fanout

    monkeypatch.setattr(fanout, "fetch_feed", _fake_fetch)
    out = tmp_path / "pool.json"
    src = tmp_path / "sources.json"
    src.write_text(json.dumps({"schema_version": 1, "sources": SOURCES}), encoding="utf-8")
    assert fanout.main(["--out", str(out), "--sources", str(src), "--timeout", "1"]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert validate(pool) == []
    assert pool["counts"]["feed_states"]["timeout"] == 1
    assert pool["counts"]["feed_states"]["http_error"] == 1
    assert pool["counts"]["feed_states"]["empty"] == 1
    assert pool["counts"]["feed_states"]["parse_error"] == 1
