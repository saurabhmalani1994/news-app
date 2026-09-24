"""F6: run-to-run state cache. No network: every previous-state read in these tests
is a local file (load_state/write_state) or a fixed byte string (health's monkeypatched
urlopen, reused from test_health.py's own pattern), never a real fetch.

Four fixtures the brief asks for, each with its own test group below:
  1. state present (cache hit) -> used directly, no network call.
  2. state absent -> falls back to the live pool read, which succeeds.
  3. state absent -> the fallback pool read returns something that is not a valid
     pool (an Access login page), so the run starts fresh.
  4. state present but corrupt -> treated the same as absent, falls back.
"""
import json
import urllib.error
from datetime import datetime, timezone

import pytest

import fetcher.fanout as fanout
import fetcher.health as health
import fetcher.state as state
from contract.validate import validate
from fetcher.events import parse_previous_events
from fetcher.fanout import build_pool_fanout, fetch_all
from fetcher.health import parse_previous_health

RUN1 = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
RUN2 = datetime(2026, 9, 24, 4, 30, 0, tzinfo=timezone.utc)

DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"
ONE_ITEM_FEED = (
    '<rss version="2.0"><channel>'
    '<item><title>Only item</title><link>https://one.example/a</link>' + DATE + "</item>"
    "</channel></rss>"
).encode("utf-8")
EMPTY_FEED = b'<rss version="2.0"><channel></channel></rss>'
LOGIN_PAGE = b"<html><body>Sign in with your Cloudflare Access identity</body></html>"

SOURCES = [{
    "id": "one", "name": "One", "feed_url": "https://one.example/feed.xml",
    "bucket": "general", "lean": "center", "lean_basis": "test fixture",
    "syndication_group": "one",
}]


def _pool(feed_bytes_or_exc, now, **kw):
    def fake_fetch(url, timeout=None):
        if isinstance(feed_bytes_or_exc, Exception):
            raise feed_bytes_or_exc
        return feed_bytes_or_exc

    results = fetch_all(SOURCES, fetch_fn=fake_fetch, timeout=1, retries=0)
    pool = build_pool_fanout(SOURCES, results, now, **kw)
    assert validate(pool) == []
    return pool


# ---------------------------------------------------------------------------
# build_state / validate_state: the closed shape itself.
# ---------------------------------------------------------------------------

def test_build_state_keeps_only_the_five_closed_fields():
    pool = _pool(ONE_ITEM_FEED, RUN1)
    doc = state.build_state(pool)
    assert set(doc) == state.STATE_FIELDS
    assert state.validate_state(doc) == []
    # no article text of any kind leaks into state.json
    assert "articles" not in doc and "sources" not in doc and "counts" not in doc


def test_build_state_trims_clusters_and_events_to_their_needed_fields():
    pool = _pool(ONE_ITEM_FEED, RUN1)
    pool = dict(pool)
    pool["clusters"] = [{"id": "c_x", "article_ids": ["a", "b"], "method": "minhash",
                          "near_duplicates": [], "independent_sources": 2, "lean_buckets": []}]
    pool["events"] = [{"id": "e_x", "label": "X", "cluster_ids": ["c_x"], "hype": 9,
                        "eligible": True, "live": True, "hold_state": "none",
                        "live_since": "2026-09-24T04:00:00Z"}]
    doc = state.build_state(pool)
    assert doc["clusters"] == [{"id": "c_x", "article_ids": ["a", "b"]}]
    assert doc["events"] == [{"id": "e_x", "cluster_ids": ["c_x"], "live": True,
                               "live_since": "2026-09-24T04:00:00Z"}]


def test_build_state_omits_live_since_for_a_non_live_event():
    pool = _pool(ONE_ITEM_FEED, RUN1)
    pool = dict(pool)
    pool["clusters"] = []
    pool["events"] = [{"id": "e_x", "label": "X", "cluster_ids": [], "hype": 0,
                        "eligible": False, "live": False, "hold_state": "none"}]
    doc = state.build_state(pool)
    assert doc["events"] == [{"id": "e_x", "cluster_ids": [], "live": False}]


def test_state_round_trips_through_the_existing_pool_parsers():
    # The whole point of the shape: fetcher.health.parse_previous_health and
    # fetcher.events.parse_previous_events, written for a full pool.json, read a
    # state.json unchanged, because state.json's fields line up with what they use.
    pool = _pool(ONE_ITEM_FEED, RUN1)
    body = state.dumps_state(state.build_state(pool)).encode("utf-8")
    entries, status = parse_previous_health(body)
    assert status == "ok"
    assert entries == pool["source_health"]
    events_state, events_status = parse_previous_events(body)
    assert events_status == "ok"
    assert events_state["events"] == []


@pytest.mark.parametrize("mutate,expected_substring", [
    (lambda d: d.pop("clusters"), "missing field"),
    (lambda d: d.__setitem__("extra", 1), "unknown field"),
    (lambda d: d.__setitem__("schema_version", 2), "schema_version"),
    (lambda d: d.__setitem__("generated_at", ""), "generated_at"),
    (lambda d: d.__setitem__("source_health", []), "source_health"),
    (lambda d: d["source_health"].update(bad={"state": "ok"}), "source_health"),
    (lambda d: d.__setitem__("clusters", [{"id": "c_x"}]), "clusters[0]"),
    (lambda d: d.__setitem__("events", [{"id": "e_x"}]), "events[0]"),
    (lambda d: d["events"].append({"id": "e_y", "cluster_ids": [], "live": False, "junk": 1}), "unknown field"),
])
def test_validate_state_rejects_each_kind_of_corruption(mutate, expected_substring):
    pool = _pool(ONE_ITEM_FEED, RUN1)
    doc = state.build_state(pool)
    mutate(doc)
    errors = state.validate_state(doc)
    assert errors, "expected validate_state to reject this mutation"
    assert any(expected_substring in e for e in errors), errors


def test_validate_state_accepts_a_well_formed_empty_state():
    doc = {"schema_version": 1, "generated_at": "2026-09-24T04:00:00Z",
           "source_health": {}, "clusters": [], "events": []}
    assert state.validate_state(doc) == []


# ---------------------------------------------------------------------------
# load_state / write_state: the local file, hit / absent / corrupt.
# ---------------------------------------------------------------------------

def test_load_state_absent_when_no_file(tmp_path):
    data, status = state.load_state(tmp_path / "nope" / "state.json")
    assert data is None
    assert status == "absent"


def test_write_state_then_load_state_is_a_hit(tmp_path):
    pool = _pool(ONE_ITEM_FEED, RUN1)
    path = tmp_path / "state.json"
    state.write_state(pool, path)
    data, status = state.load_state(path)
    assert status == "hit"
    assert json.loads(data) == state.build_state(pool)


def test_load_state_corrupt_when_file_is_not_json(tmp_path):
    path = tmp_path / "state.json"
    path.write_bytes(b"{not valid json")
    data, status = state.load_state(path)
    assert data is None
    assert status == "corrupt"


def test_load_state_corrupt_when_json_fails_validation(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"schema_version": 1, "generated_at": "x"}), encoding="utf-8")
    data, status = state.load_state(path)
    assert data is None
    assert status == "corrupt"


# ---------------------------------------------------------------------------
# fanout.main() integration: the four fixtures, end to end.
# ---------------------------------------------------------------------------

def _write_sources(tmp_path):
    src = tmp_path / "sources.json"
    src.write_text(json.dumps({"schema_version": 1, "sources": SOURCES}), encoding="utf-8")
    return src


def _always_raise(exc):
    def fetch(url, timeout=None):
        raise exc
    return fetch


def test_fixture_1_state_present_is_used_directly_no_network(tmp_path, monkeypatch):
    """Run 1 writes state.json; run 2 restores it (simulating actions/cache) and
    carries consecutive_error forward without ever calling the network fallback."""
    src = _write_sources(tmp_path)
    state_path = tmp_path / "state.json"
    out1 = tmp_path / "pool1.json"
    exc = urllib.error.HTTPError("u", 500, "err", {}, None)
    monkeypatch.setattr(fanout, "fetch_feed", _always_raise(exc))

    def fail_if_called(url, timeout=None):
        raise AssertionError("network fallback must not be called when state.json is a hit")

    assert fanout.main(["--out", str(out1), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1"]) == 0
    pool1 = json.loads(out1.read_text(encoding="utf-8"))
    assert pool1["source_health"]["one"]["consecutive_error"] == 1
    assert state_path.exists()

    monkeypatch.setattr(health.urllib.request, "urlopen", fail_if_called)
    out2 = tmp_path / "pool2.json"
    assert fanout.main(["--out", str(out2), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1"]) == 0
    pool2 = json.loads(out2.read_text(encoding="utf-8"))
    assert pool2["counts"]["previous_pool_status"] == "cache"
    assert pool2["source_health"]["one"]["consecutive_error"] == 2


def test_fixture_2_state_absent_falls_back_to_pool_and_succeeds(tmp_path, monkeypatch):
    src = _write_sources(tmp_path)
    state_path = tmp_path / "does-not-exist" / "state.json"  # absent
    prev_pool = _pool(urllib.error.HTTPError("u", 500, "err", {}, None), RUN1)
    prev_body = json.dumps(prev_pool).encode("utf-8")

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n=None): return prev_body

    monkeypatch.setattr(fanout, "fetch_feed",
                         _always_raise(urllib.error.HTTPError("u", 500, "err", {}, None)))
    monkeypatch.setattr(health.urllib.request, "urlopen", lambda req, timeout=None: Resp())

    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1",
                        "--previous-pool-url", "https://example.test/pool.json"]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert pool["counts"]["previous_pool_status"] == "ok"
    # the previous run's consecutive_error (1) carried forward and advanced to 2
    assert pool["source_health"]["one"]["consecutive_error"] == 2


def test_fixture_3_state_absent_and_access_login_page_starts_fresh(tmp_path, monkeypatch):
    src = _write_sources(tmp_path)
    state_path = tmp_path / "does-not-exist" / "state.json"  # absent

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n=None): return LOGIN_PAGE

    monkeypatch.setattr(fanout, "fetch_feed", lambda url, timeout=None: ONE_ITEM_FEED)
    monkeypatch.setattr(health.urllib.request, "urlopen", lambda req, timeout=None: Resp())

    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1",
                        "--previous-pool-url", "https://example.test/pool.json"]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert pool["counts"]["previous_pool_status"] == "old_schema"
    assert pool["source_health"]["one"]["consecutive_error"] == 0
    assert pool["source_health"]["one"]["state"] == "ok"


def test_fixture_4_corrupt_state_file_falls_back_like_absent(tmp_path, monkeypatch):
    src = _write_sources(tmp_path)
    state_path = tmp_path / "state.json"
    state_path.write_bytes(b"{ this is not valid json at all")

    prev_pool = _pool(ONE_ITEM_FEED, RUN1)
    prev_body = json.dumps(prev_pool).encode("utf-8")

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n=None): return prev_body

    monkeypatch.setattr(fanout, "fetch_feed", lambda url, timeout=None: EMPTY_FEED)
    monkeypatch.setattr(health.urllib.request, "urlopen", lambda req, timeout=None: Resp())

    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1",
                        "--previous-pool-url", "https://example.test/pool.json"]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    # corrupt state was rejected, so this fell through to the network pool, not
    # straight to a fresh count: the previous run's items_fetched (1) is visible.
    assert pool["counts"]["previous_pool_status"] == "ok"
    assert pool["source_health"]["one"]["consecutive_empty"] == 1
    # the corrupt local file is overwritten with this run's own valid state
    data, status = state.load_state(state_path)
    assert status == "hit"


def test_fixture_4b_corrupt_state_and_unreachable_network_starts_fresh(tmp_path, monkeypatch):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"schema_version": 99}), encoding="utf-8")
    src = _write_sources(tmp_path)

    def raise_timeout(req, timeout=None):
        raise OSError("network unreachable")

    monkeypatch.setattr(fanout, "fetch_feed", lambda url, timeout=None: ONE_ITEM_FEED)
    monkeypatch.setattr(health.urllib.request, "urlopen", raise_timeout)

    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1",
                        "--previous-pool-url", "https://example.test/pool.json"]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert pool["counts"]["previous_pool_status"] == "unreachable"
    assert pool["source_health"]["one"]["consecutive_error"] == 0


def test_state_json_written_after_a_run_is_schema_valid(tmp_path, monkeypatch):
    src = _write_sources(tmp_path)
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(fanout, "fetch_feed", lambda url, timeout=None: ONE_ITEM_FEED)
    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(src),
                        "--state-path", str(state_path), "--timeout", "1"]) == 0
    doc = json.loads(state_path.read_text(encoding="utf-8"))
    assert state.validate_state(doc) == []


def test_state_not_written_when_pool_fails_validation(tmp_path, monkeypatch):
    # A source list that fails the taxonomy/shape check never reaches build_pool_fanout,
    # so main() returns 1 before writing either pool.json or state.json.
    bad_src = tmp_path / "sources.json"
    bad_src.write_text(json.dumps({"schema_version": 1, "sources": [
        {"id": "dup", "name": "A", "feed_url": "https://a.example/f", "bucket": "general"},
        {"id": "dup", "name": "B", "feed_url": "https://b.example/f", "bucket": "general"},
    ]}), encoding="utf-8")
    state_path = tmp_path / "state.json"
    out = tmp_path / "pool.json"
    assert fanout.main(["--out", str(out), "--sources", str(bad_src),
                        "--state-path", str(state_path)]) == 1
    assert not state_path.exists()
