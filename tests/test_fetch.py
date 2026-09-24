"""Fetcher: golden output, no bodies (R12), lenient parsing with every leniency counted (R9)."""
import json
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import pytest

from contract.validate import load_schema, validate
from fetcher import fetch
from fetcher.fetch import USER_AGENT, FeedError, build_pool, dumps, fetch_feed

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = (ROOT / "tests/fixtures/sample_feed.xml").read_bytes()
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"


def _feed(items, prefix=""):
    return (prefix + '<rss version="2.0"><channel>' + items + "</channel></rss>").encode("utf-8")


def test_sample_feed_produces_golden_pool():
    assert build_pool(SAMPLE, NOW) == GOLDEN


def test_body_never_reaches_pool():
    assert "FULL BODY TEXT" not in dumps(build_pool(SAMPLE, NOW))


def test_clean_feed_has_no_leniency():
    assert build_pool(SAMPLE, NOW)["counts"]["leniency"] == {}


def test_malformed_feed_parses_and_counts_each_leniency():
    data = _feed(
        "<item><title>Salt &amp; pepper &nbsp;prices\x01 rise</title>"
        "<link>https://example.org/a?x=1&y=2</link>" + DATE + "</item>"
        "<item><title>Second &mdash; item</title>"
        "<guid>https://example.org/b</guid><pubDate>2026-09-23T09:00:00</pubDate></item>",
        prefix='garbage line\n<?xml version="1.0" encoding="UTF-8"?>\n',
    )
    pool = build_pool(data, NOW)
    mdash = chr(8212)
    assert [a["title"] for a in pool["articles"]] == ["Salt & pepper prices rise", f"Second {mdash} item"]
    assert pool["articles"][0]["url"] == "https://example.org/a?x=1&y=2"
    assert pool["articles"][1]["published_at"] == "2026-09-23T09:00:00Z"
    assert pool["counts"]["leniency"] == {
        "bare_ampersand": 1, "control_chars": 1, "html_entity": 2, "iso_date": 1,
        "leading_junk": 1, "link_from_guid": 1, "naive_date": 1,
    }
    assert validate(pool) == []


def test_title_markup_stripped_and_counted():
    pool = build_pool(_feed(
        "<item><title>&lt;b&gt;Bold&lt;/b&gt; claim</title><link>https://e.org/1</link>" + DATE + "</item>"
    ), NOW)
    assert pool["articles"][0]["title"] == "Bold claim"
    assert pool["counts"]["leniency"] == {"title_markup": 1}


def test_unusable_items_dropped_with_a_reason():
    pool = build_pool(_feed(
        "<item><title></title><link>https://e.org/1</link>" + DATE + "</item>"
        "<item><title>No date</title><link>https://e.org/2</link></item>"
        "<item><title>Bad url</title><link>javascript:alert(1)</link>" + DATE + "</item>"
        "<item><title>Good</title><link>https://e.org/4</link>" + DATE + "</item>"
        "<item><title>Dup</title><link>https://e.org/4</link>" + DATE + "</item>"
    ), NOW)
    c = pool["counts"]
    assert [a["title"] for a in pool["articles"]] == ["Good"]
    assert c["drops"] == {"bad_url": 1, "duplicate_url": 1, "no_date": 1, "no_title": 1}
    assert c["fetched"] == c["published"] + sum(c["drops"].values())


def test_s02_proof_titleless_dateless_duplicate_url():
    # QUEUE.md S02 proof line: a run seeded with a titleless item, a dateless item and
    # a duplicate url ends with fetched == published + sum(drops), each of those three
    # reasons exactly 1.
    pool = build_pool(_feed(
        "<item><title>Good</title><link>https://e.org/good</link>" + DATE + "</item>"
        "<item><title></title><link>https://e.org/no-title</link>" + DATE + "</item>"
        "<item><title>No date</title><link>https://e.org/no-date</link></item>"
        "<item><title>Dup</title><link>https://e.org/good</link>" + DATE + "</item>"
    ), NOW)
    c = pool["counts"]
    assert c["fetched"] == 4
    assert c["published"] == 1
    assert c["drops"] == {"no_title": 1, "no_date": 1, "duplicate_url": 1}
    assert c["fetched"] == c["published"] + sum(c["drops"].values())
    assert validate(pool) == []


def test_ledger_invariant_asserted_at_runtime():
    # S02: fetched == published + sum(drops) is asserted by the fetcher itself, not
    # only checked later by the validator. Exercise the real check with a ledger an
    # honest build_pool run could never produce.
    from fetcher.fetch import _assert_ledger_invariant

    good = {"fetched": 4, "published": 1, "drops": {"no_title": 1, "no_date": 1, "duplicate_url": 1}}
    _assert_ledger_invariant(good)  # does not raise

    bad = {"fetched": 5, "published": 1, "drops": {"no_title": 1}}
    with pytest.raises(FeedError):
        _assert_ledger_invariant(bad)


def test_unparseable_feed_raises():
    with pytest.raises(FeedError):
        build_pool(b"<rss><channel><item></channel>", NOW)


def test_fetch_feed_sends_honest_user_agent_and_feed_accept_header(monkeypatch):
    # F2: some feed hosts bot-score requests that never state what they accept.
    # The user agent stays a polite, honest self-identification (never a browser
    # impersonation), and an Accept header naming feed content types is added
    # alongside it.
    seen = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            return SAMPLE

    def fake_urlopen(req, timeout=None):
        seen["headers"] = dict(req.header_items())
        return FakeResponse()

    monkeypatch.setattr(fetch.urllib.request, "urlopen", fake_urlopen)
    fetch_feed("https://example.org/feed")
    assert seen["headers"]["User-agent"] == USER_AGENT
    assert "browser" not in USER_AGENT.lower() and "mozilla" not in USER_AGENT.lower()
    assert "xml" in seen["headers"]["Accept"].lower()


def test_main_writes_valid_pool_offline(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "fetch_feed", lambda url, timeout=20: SAMPLE)
    out = tmp_path / "pool.json"
    assert fetch.main(["--out", str(out)]) == 0
    pool = json.loads(out.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(load_schema()).validate(pool)
    assert len(pool["articles"]) == 5
