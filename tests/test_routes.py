"""F3 proof: per-source fetch routes (relay, google_news), no network.

A source that names "via"/"via_url" gets fetched from via_url instead of its plain
feed_url, with feed_url kept unchanged as the original, reversible direct route
(dropping via/via_url reverts a source with no other edit). Route use is counted in
the ledger. Google News items keep the real outlet as source_id and only ever swap
in a direct article URL when the feed item's own content actually carries one;
otherwise Google's redirect link is published unchanged, never invented.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from contract.validate import validate
from fetcher.fanout import (
    ROUTES,
    build_pool_fanout,
    fetch_all,
    _fetch_url_for,
    _google_news_real_url,
    _route_for,
)

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = (ROOT / "tests/fixtures/sample_feed.xml").read_bytes()
GOOGLE_NEWS_SAMPLE = (ROOT / "tests/fixtures/google_news_sample.xml").read_bytes()
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)


def _src(id_, name, url, **extra):
    return {
        "id": id_, "name": name, "feed_url": url, "bucket": "general",
        "lean": "center", "lean_basis": "test fixture, not a real rating",
        "syndication_group": id_, **extra,
    }


DIRECT = _src("direct_source", "Direct Source", "https://direct.example/feed.xml")
RELAYED = _src(
    "relayed_source", "Relayed Source", "https://original.example/feed.xml",
    via="relay", via_url="https://almanac-relay.example.workers.dev/feed/relayed_source",
)
GOOGLE_NEWS_SOURCE = _src(
    "example_outlet", "Example Outlet", "https://www.example-outlet.test/feed/",
    via="google_news",
    via_url="https://news.google.com/rss/search?q=site:example-outlet.test&hl=en-US&gl=US&ceid=US:en",
)


def test_route_for_defaults_to_direct_when_via_is_absent():
    assert _route_for(DIRECT) == "direct"
    assert _route_for(RELAYED) == "relay"
    assert _route_for(GOOGLE_NEWS_SOURCE) == "google_news"


def test_fetch_url_for_prefers_via_url_and_keeps_feed_url_untouched():
    assert _fetch_url_for(DIRECT) == DIRECT["feed_url"]
    assert _fetch_url_for(RELAYED) == RELAYED["via_url"]
    assert RELAYED["feed_url"] == "https://original.example/feed.xml"  # unchanged, reversible


def test_fetch_all_requests_via_url_not_feed_url_for_a_routed_source():
    calls = []

    def fake_fetch(url, timeout=None):
        calls.append(url)
        return SAMPLE

    fetch_all([RELAYED], fetch_fn=fake_fetch, timeout=1, retries=0)
    assert calls == [RELAYED["via_url"]]
    assert RELAYED["feed_url"] not in calls


def test_relay_route_publishes_the_same_way_a_direct_feed_does():
    """The relay just passes the original feed bytes through, so a relayed source
    fetched through via_url is otherwise a normal feed as far as the pool is
    concerned. sample_feed.xml stands in for what the relay would return."""

    def fake_fetch(url, timeout=None):
        assert url == RELAYED["via_url"]
        return SAMPLE

    results = fetch_all([RELAYED], fetch_fn=fake_fetch, timeout=1, retries=0)
    pool = build_pool_fanout([RELAYED], results, NOW)
    assert pool["counts"]["feed_states"]["ok"] == 1
    assert pool["counts"]["published"] > 0
    assert all(a["source_id"] == "relayed_source" for a in pool["articles"])
    assert pool["counts"]["routes"] == {"direct": 0, "relay": 1, "google_news": 0}
    assert validate(pool) == []


def test_google_news_real_url_none_when_only_the_redirect_link_is_present():
    import xml.etree.ElementTree as ET

    root = ET.fromstring(GOOGLE_NEWS_SAMPLE)
    first_item = root.find(".//item")
    assert _google_news_real_url(first_item) is None


def test_google_news_real_url_found_when_description_carries_a_direct_outlet_link():
    import xml.etree.ElementTree as ET

    root = ET.fromstring(GOOGLE_NEWS_SAMPLE)
    second_item = root.findall(".//item")[1]
    assert _google_news_real_url(second_item) == "https://www.example-outlet.test/2026/09/23/headline-two"


def test_google_news_route_keeps_the_real_outlet_as_source_and_only_swaps_url_when_present():
    def fake_fetch(url, timeout=None):
        assert url == GOOGLE_NEWS_SOURCE["via_url"]
        return GOOGLE_NEWS_SAMPLE

    results = fetch_all([GOOGLE_NEWS_SOURCE], fetch_fn=fake_fetch, timeout=1, retries=0)
    pool = build_pool_fanout([GOOGLE_NEWS_SOURCE], results, NOW)
    articles = {a["title"]: a for a in pool["articles"]}
    assert len(articles) == 2
    # Every article's source is still the real outlet, never "google_news" or Google.
    assert all(a["source_id"] == "example_outlet" for a in articles.values())

    no_direct_link = articles["Headline one stays on the real outlet - Example Outlet"]
    assert no_direct_link["url"] == "https://news.google.com/rss/articles/redirectone?oc=5"

    has_direct_link = articles["Headline two carries a direct outlet link - Example Outlet"]
    assert has_direct_link["url"] == "https://www.example-outlet.test/2026/09/23/headline-two"

    assert pool["counts"]["routes"] == {"direct": 0, "relay": 0, "google_news": 1}
    assert validate(pool) == []


def test_routes_ledger_counts_every_configured_source_exactly_once():
    sources = [DIRECT, RELAYED, GOOGLE_NEWS_SOURCE]

    def fake_fetch(url, timeout=None):
        return SAMPLE if "example-outlet" not in url and "news.google" not in url else GOOGLE_NEWS_SAMPLE

    results = fetch_all(sources, fetch_fn=fake_fetch, timeout=1, retries=0)
    pool = build_pool_fanout(sources, results, NOW)
    assert pool["counts"]["routes"] == {"direct": 1, "relay": 1, "google_news": 1}
    assert sum(pool["counts"]["routes"].values()) == len(sources)
    assert set(pool["counts"]["routes"]) == set(ROUTES)
    assert validate(pool) == []


def test_sources_json_blocked_feeds_are_wired_to_a_route_with_feed_url_kept():
    """F2 named four feeds blocked from GitHub Actions' network. F3 wires each to an
    explicit, reversible route: feed_url stays the original direct URL, via/via_url
    record what's actually fetched instead."""
    doc = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["sources"]}
    blocked = ("times_of_israel", "middle_east_eye", "import_ai", "indian_express")
    for sid in blocked:
        source = by_id[sid]
        assert source.get("via") in ("relay", "google_news"), sid
        assert source.get("via_url"), sid
        assert source["via_url"] != source["feed_url"], sid
        if source["via"] == "google_news":
            assert source["via_url"].startswith("https://news.google.com/rss/search?q=site:"), sid
