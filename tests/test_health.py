"""S06: per-source health across runs. No network: every previous-pool read is a
fixture dict or a monkeypatched urlopen, never a real fetch."""
import json
import socket
import urllib.error
from datetime import datetime, timezone

import pytest

from contract.validate import validate
import fetcher.health as health
from fetcher.fanout import build_pool_fanout, fetch_all

RUN1 = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
RUN2 = datetime(2026, 9, 24, 4, 30, 0, tzinfo=timezone.utc)
RUN3 = datetime(2026, 9, 24, 5, 0, 0, tzinfo=timezone.utc)

DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"
ONE_ITEM_FEED = (
    '<rss version="2.0"><channel>'
    '<item><title>Only item</title><link>https://one.example/a</link>' + DATE + "</item>"
    "</channel></rss>"
).encode("utf-8")
EMPTY_FEED = b'<rss version="2.0"><channel></channel></rss>'


def _src(id_="one"):
    return {
        "id": id_, "name": "One", "feed_url": f"https://{id_}.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test fixture",
        "syndication_group": id_,
    }


def _run(sources, feed_bytes_or_exc, now, previous_health=None, previous_pool_status="absent"):
    def fake_fetch(url, timeout=None):
        if isinstance(feed_bytes_or_exc, Exception):
            raise feed_bytes_or_exc
        return feed_bytes_or_exc

    results = fetch_all(sources, fetch_fn=fake_fetch, timeout=1, retries=0)
    pool = build_pool_fanout(
        sources, results, now, previous_health=previous_health,
        previous_pool_status=previous_pool_status,
    )
    assert validate(pool) == []
    return pool


# ---------------------------------------------------------------------------
# Proof 1: ok, empty, empty -> consecutive_empty reaches 2, never touching
# consecutive_error, and counters survive being carried from one run's output
# into the next run's input exactly as a real cron cycle would pass them.
# ---------------------------------------------------------------------------

def test_three_runs_ok_empty_empty_yields_consecutive_empty_two():
    sources = [_src()]

    pool1 = _run(sources, ONE_ITEM_FEED, RUN1)
    entry1 = pool1["source_health"]["one"]
    assert entry1 == {
        "state": "ok", "last_ok_at": "2026-09-24T04:00:00Z",
        "last_item_at": "2026-09-23T10:00:00Z", "consecutive_empty": 0,
        "consecutive_error": 0, "items_fetched": 1, "unhealthy": False,
    }

    pool2 = _run(sources, EMPTY_FEED, RUN2, previous_health=pool1["source_health"],
                 previous_pool_status="ok")
    entry2 = pool2["source_health"]["one"]
    assert entry2["state"] == "empty"
    assert entry2["consecutive_empty"] == 1
    assert entry2["consecutive_error"] == 0
    # last_ok_at and last_item_at hold steady from the last ok run.
    assert entry2["last_ok_at"] == "2026-09-24T04:00:00Z"
    assert entry2["last_item_at"] == "2026-09-23T10:00:00Z"

    pool3 = _run(sources, EMPTY_FEED, RUN3, previous_health=pool2["source_health"],
                 previous_pool_status="ok")
    entry3 = pool3["source_health"]["one"]
    assert entry3["state"] == "empty"
    assert entry3["consecutive_empty"] == 2
    assert entry3["consecutive_error"] == 0
    assert entry3["unhealthy"] is False  # threshold is 5, not yet crossed


# ---------------------------------------------------------------------------
# Proof 2: an error, then an ok, resets consecutive_error to 0.
# ---------------------------------------------------------------------------

def test_error_then_ok_resets_consecutive_error_to_zero():
    sources = [_src()]

    pool1 = _run(sources, urllib.error.HTTPError("u", 500, "err", {}, None), RUN1)
    entry1 = pool1["source_health"]["one"]
    assert entry1["state"] == "http_error"
    assert entry1["consecutive_error"] == 1

    pool2 = _run(sources, ONE_ITEM_FEED, RUN2, previous_health=pool1["source_health"],
                 previous_pool_status="ok")
    entry2 = pool2["source_health"]["one"]
    assert entry2["state"] == "ok"
    assert entry2["consecutive_error"] == 0
    assert entry2["last_ok_at"] == "2026-09-24T04:30:00Z"


def test_three_consecutive_errors_marks_a_source_unhealthy():
    sources = [_src()]
    exc = urllib.error.HTTPError("u", 500, "err", {}, None)

    pool1 = _run(sources, exc, RUN1)
    assert pool1["source_health"]["one"]["unhealthy"] is False  # 1 error

    pool2 = _run(sources, exc, RUN2, previous_health=pool1["source_health"],
                 previous_pool_status="ok")
    assert pool2["source_health"]["one"]["unhealthy"] is False  # 2 errors

    pool3 = _run(sources, exc, RUN3, previous_health=pool2["source_health"],
                 previous_pool_status="ok")
    assert pool3["source_health"]["one"]["consecutive_error"] == 3
    assert pool3["source_health"]["one"]["unhealthy"] is True  # 3 errors crosses the threshold


# ---------------------------------------------------------------------------
# Proof 3: a missing or corrupt previous pool starts cleanly, and the fact is
# recorded in counts.previous_pool_status rather than failing the run.
# ---------------------------------------------------------------------------

def test_no_previous_pool_url_is_tolerated_and_recorded_as_absent():
    entries, status = health.fetch_previous_health("")
    assert entries == {}
    assert status == "absent"


def test_404_previous_pool_is_tolerated_and_recorded_as_absent(monkeypatch):
    def raise_404(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(health.urllib.request, "urlopen", raise_404)
    entries, status = health.fetch_previous_health("https://almanac-dt5.pages.dev/pool.json")
    assert entries == {}
    assert status == "absent"


def test_unreachable_previous_pool_is_tolerated_and_recorded(monkeypatch):
    def raise_timeout(req, timeout=None):
        raise socket.timeout("timed out")

    monkeypatch.setattr(health.urllib.request, "urlopen", raise_timeout)
    entries, status = health.fetch_previous_health("https://almanac-dt5.pages.dev/pool.json")
    assert entries == {}
    assert status == "unreachable"


def test_corrupt_previous_pool_body_is_tolerated_and_recorded_as_old_schema():
    entries, status = health.parse_previous_health(b"{not valid json")
    assert entries == {}
    assert status == "old_schema"


def test_previous_pool_missing_source_health_key_is_old_schema():
    # A pool published before this slice: valid JSON, no source_health block at all.
    pre_s06_pool = json.dumps({"schema_version": 1, "sources": [], "articles": []}).encode()
    entries, status = health.parse_previous_health(pre_s06_pool)
    assert entries == {}
    assert status == "old_schema"


def test_a_run_with_no_usable_previous_pool_starts_every_counter_at_zero():
    sources = [_src()]
    pool = _run(sources, ONE_ITEM_FEED, RUN1, previous_health={}, previous_pool_status="absent")
    entry = pool["source_health"]["one"]
    assert entry["consecutive_empty"] == 0
    assert entry["consecutive_error"] == 0
    assert pool["counts"]["previous_pool_status"] == "absent"


def test_a_run_never_fails_because_the_previous_pool_was_unreadable():
    # The point of tolerating a bad previous pool: build_pool_fanout still produces
    # a schema-valid pool even when previous_health is empty because the read failed.
    sources = [_src()]
    pool = _run(sources, ONE_ITEM_FEED, RUN1, previous_health={}, previous_pool_status="unreachable")
    assert validate(pool) == []
    assert pool["counts"]["previous_pool_status"] == "unreachable"


# ---------------------------------------------------------------------------
# Contract: closed shape, both validators.
# ---------------------------------------------------------------------------

def test_source_health_unknown_field_rejected():
    import jsonschema
    from contract.validate import SchemaError, load_schema

    sources = [_src()]
    pool = _run(sources, ONE_ITEM_FEED, RUN1)
    pool["source_health"]["one"]["extra_field"] = 1
    JS = jsonschema.Draft202012Validator(load_schema())
    assert not JS.is_valid(pool)
    assert validate(pool) != []


def test_source_health_missing_source_entry_rejected_by_integrity_check():
    sources = [_src("one"), _src("two")]
    pool = _run(sources, ONE_ITEM_FEED, RUN1)
    del pool["source_health"]["two"]
    errors = validate(pool)
    assert any("source_health" in e for e in errors)


def test_source_health_unknown_source_id_rejected_by_integrity_check():
    sources = [_src()]
    pool = _run(sources, ONE_ITEM_FEED, RUN1)
    pool["source_health"]["nobody"] = pool["source_health"]["one"]
    errors = validate(pool)
    assert any("source_health" in e for e in errors)


def test_items_fetched_reflects_this_run_only_not_a_running_total():
    sources = [_src()]
    pool1 = _run(sources, ONE_ITEM_FEED, RUN1)
    assert pool1["source_health"]["one"]["items_fetched"] == 1
    pool2 = _run(sources, EMPTY_FEED, RUN2, previous_health=pool1["source_health"],
                 previous_pool_status="ok")
    assert pool2["source_health"]["one"]["items_fetched"] == 0
