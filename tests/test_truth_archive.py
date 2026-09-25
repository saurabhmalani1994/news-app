"""B9: the trumpstruth.org archive lookup and DESIGN-bundles.md section 3's match
rule. No network: every archive fetch is a fixed bytes string or a fake fetch_fn,
same pattern as the other fetcher tests.

Section 7's proof: The Hill names Truth Social and quotes 6 words of one archived
post gets the link; a 5-word quote, a quote matching two posts, a repost, and a
quote where Truth Social is not named all get none. An unreachable archive adds no
links, notes it in the ledger, and the run still passes.
"""
import urllib.error
from datetime import datetime, timezone

import pytest

from contract.validate import validate
from fetcher import fanout
from fetcher.fanout import build_pool_fanout, fetch_all
from fetcher.truth_archive import (
    find_primary_source,
    link_clusters,
    load_archive,
    parse_archive,
)

NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"
POST_TIME = "2026-09-24T10:00:00Z"
VERSION_TIME = "2026-09-24T12:00:00Z"  # 2h after the post, inside the 72h window

QUOTE = "leave it exactly where it is"  # 6 words, today's design-doc example
HILL_TEXT = (
    f'Trump wrote on Truth Social, "{QUOTE}", a spokesperson for The Hill said.'
)

ARCHIVE_FEED = (
    '<rss version="2.0"><channel>'
    f'<item><title>{QUOTE}</title>'
    "<link>https://trumpstruth.org/posts/12345</link>"
    f"<pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>"
    "</channel></rss>"
).encode("utf-8")

EMPTY_ARCHIVE_FEED = b'<rss version="2.0"><channel></channel></rss>'
BROKEN_ARCHIVE_FEED = b"<rss><channel><item><title>Unclosed</channel>"


def _post(url="https://trumpstruth.org/posts/12345", text=QUOTE, published_at=POST_TIME):
    return {"url": url, "text": text, "published_at": published_at}


# --- find_primary_source: the section 3 match rule itself -----------------------

def test_six_word_quote_of_one_post_matches():
    url = find_primary_source(HILL_TEXT, VERSION_TIME, [_post()])
    assert url == "https://trumpstruth.org/posts/12345"


def test_five_word_quote_does_not_match():
    text = 'Trump wrote on Truth Social, "it exactly where it is", The Hill said.'
    assert find_primary_source(text, VERSION_TIME, [_post()]) is None


def test_quote_matching_two_posts_does_not_match():
    posts = [_post(url="https://trumpstruth.org/posts/1"),
             _post(url="https://trumpstruth.org/posts/2")]
    assert find_primary_source(HILL_TEXT, VERSION_TIME, posts) is None


def test_repost_does_not_match():
    posts = [_post(text=f"RT @realDonaldTrump: {QUOTE}")]
    assert find_primary_source(HILL_TEXT, VERSION_TIME, posts) is None


def test_quote_without_truth_social_named_does_not_match():
    text = f'A spokesperson said, "{QUOTE}", according to The Hill.'
    assert find_primary_source(text, VERSION_TIME, [_post()]) is None


def test_post_with_fewer_than_six_words_of_its_own_does_not_match():
    posts = [_post(text="leave it")]
    assert find_primary_source(HILL_TEXT, VERSION_TIME, posts) is None


def test_post_outside_72h_window_does_not_match():
    posts = [_post(published_at="2026-09-20T10:00:00Z")]  # 4 days before the version
    assert find_primary_source(HILL_TEXT, VERSION_TIME, posts) is None


def test_post_after_the_version_does_not_match():
    posts = [_post(published_at="2026-09-25T10:00:00Z")]  # after the version
    assert find_primary_source(HILL_TEXT, VERSION_TIME, posts) is None


def test_curly_quotes_and_case_fold_to_the_same_match():
    text = f'Trump wrote on Truth Social, “LEAVE IT EXACTLY WHERE IT IS”, The Hill said.'
    assert find_primary_source(text, VERSION_TIME, [_post()]) == "https://trumpstruth.org/posts/12345"


def test_no_posts_means_no_match():
    assert find_primary_source(HILL_TEXT, VERSION_TIME, []) is None


# --- link_clusters: applying the rule across a cluster's members -----------------

def _article(aid, title, published_at=VERSION_TIME, dek=""):
    a = {"id": aid, "source_id": "hill", "url": f"https://hill.example/{aid}",
         "title": title, "published_at": published_at}
    if dek:
        a["dek"] = dek
    return a


def test_link_clusters_sets_primary_source_on_the_matching_cluster():
    a0 = _article("a0", HILL_TEXT)
    a1 = _article("a1", "A different outlet's plain headline")
    cluster = {"id": "c0", "article_ids": ["a0", "a1"]}
    links = link_clusters([cluster], {"a0": a0, "a1": a1}, {}, [_post()])
    assert links == {"c0": "https://trumpstruth.org/posts/12345"}


def test_link_clusters_reads_the_body_when_the_title_and_dek_do_not_match():
    a0 = _article("a0", "A headline with no quote or mention")
    cluster = {"id": "c0", "article_ids": ["a0"]}
    bodies = {"a0": {"body_html": f"<p>{HILL_TEXT}</p>"}}
    links = link_clusters([cluster], {"a0": a0}, bodies, [_post()])
    assert links == {"c0": "https://trumpstruth.org/posts/12345"}


def test_link_clusters_no_match_leaves_the_cluster_out():
    a0 = _article("a0", "Nothing about Truth Social here")
    cluster = {"id": "c0", "article_ids": ["a0"]}
    assert link_clusters([cluster], {"a0": a0}, {}, [_post()]) == {}


def test_link_clusters_with_no_posts_links_nothing():
    a0 = _article("a0", HILL_TEXT)
    cluster = {"id": "c0", "article_ids": ["a0"]}
    assert link_clusters([cluster], {"a0": a0}, {}, []) == {}


# --- parse_archive / load_archive: the feed as a lookup only ---------------------

def test_parse_archive_reads_url_text_and_published_at():
    posts = parse_archive(ARCHIVE_FEED)
    assert posts == [_post(published_at="2026-09-24T10:00:00Z")]


def test_parse_archive_drops_non_https_links():
    feed = (
        '<rss version="2.0"><channel>'
        f'<item><title>{QUOTE}</title>'
        "<link>http://trumpstruth.org/posts/1</link>"
        "<pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>"
        "</channel></rss>"
    ).encode("utf-8")
    assert parse_archive(feed) == []


def test_load_archive_ok():
    posts, status = load_archive(lambda url, timeout=None: ARCHIVE_FEED)
    assert status == "ok"
    assert posts == [_post(published_at="2026-09-24T10:00:00Z")]


def test_load_archive_empty_feed_is_ok_with_no_posts():
    posts, status = load_archive(lambda url, timeout=None: EMPTY_ARCHIVE_FEED)
    assert (posts, status) == ([], "ok")


@pytest.mark.parametrize("exc,status", [
    (TimeoutError("timed out"), "timeout"),
    (urllib.error.HTTPError("u", 503, "Service Unavailable", {}, None), "http_error"),
    (OSError("network unreachable"), "http_error"),
])
def test_load_archive_down_never_raises(exc, status):
    def boom(url, timeout=None):
        raise exc
    posts, got_status = load_archive(boom)
    assert (posts, got_status) == ([], status)


def test_load_archive_unparseable_feed_is_parse_error():
    posts, status = load_archive(lambda url, timeout=None: BROKEN_ARCHIVE_FEED)
    assert (posts, status) == ([], "parse_error")


# --- End to end through build_pool_fanout: the ledger and a real cluster ---------

SOURCES = [{
    "id": "hill", "name": "The Hill", "feed_url": "https://hill.example/feed.xml",
    "bucket": "general", "lean": "center", "lean_basis": "test fixture, not a real rating",
    "syndication_group": "hill",
}, {
    "id": "livemint", "name": "LiveMint", "feed_url": "https://livemint.example/feed.xml",
    "bucket": "general", "lean": "center", "lean_basis": "test fixture, not a real rating",
    "syndication_group": "livemint",
}]

HILL_ITEM_DATE = "<pubDate>Thu, 24 Sep 2026 12:00:00 GMT</pubDate>"
HILL_FEED = (
    '<rss version="2.0"><channel>'
    f"<item><title>{HILL_TEXT}</title>"
    "<link>https://hill.example/a</link>" + HILL_ITEM_DATE + "</item>"
    "</channel></rss>"
).encode("utf-8")
LIVEMINT_FEED = (
    '<rss version="2.0"><channel>'
    f"<item><title>Trump on Truth Social: &quot;{QUOTE}&quot;, LiveMint reports</title>"
    "<link>https://livemint.example/a</link>" + HILL_ITEM_DATE + "</item>"
    "</channel></rss>"
).encode("utf-8")


def _results():
    return {
        "hill": (HILL_FEED, None),
        "livemint": (LIVEMINT_FEED, None),
    }


def _force_one_cluster(monkeypatch):
    """The real clusterer's similarity call is B2's own concern, not B9's; this test
    only needs one deterministic two-outlet cluster to check the link lands on it,
    so cluster_items is replaced with a fake that always groups every candidate
    together (both fixture sources here, one article each)."""
    def fake_cluster_items(candidates, vectors=None):
        ids = [c["id"] for c in candidates]
        return [{"article_ids": ids, "method": "cosine_entity", "near_duplicates": []}]
    monkeypatch.setattr(fanout, "cluster_items", fake_cluster_items)


def test_build_pool_fanout_links_a_matching_cluster_and_reports_it(monkeypatch):
    _force_one_cluster(monkeypatch)
    pool = build_pool_fanout(SOURCES, _results(), NOW,
                             truth_archive_posts=[_post(published_at="2026-09-24T10:00:00Z")],
                             truth_archive_status="ok")
    assert len(pool["clusters"]) == 1
    cluster = pool["clusters"][0]
    assert cluster["primary_source"] == {"url": "https://trumpstruth.org/posts/12345"}
    assert pool["counts"]["primary_source"] == {"status": "ok", "posts": 1, "linked": 1}
    assert validate(pool) == []


def test_build_pool_fanout_archive_down_adds_no_links_and_notes_it_but_still_publishes(monkeypatch):
    _force_one_cluster(monkeypatch)
    pool = build_pool_fanout(SOURCES, _results(), NOW,
                             truth_archive_posts=[], truth_archive_status="http_error")
    assert len(pool["clusters"]) == 1
    assert "primary_source" not in pool["clusters"][0]
    assert pool["counts"]["primary_source"] == {"status": "http_error", "posts": 0, "linked": 0}
    assert validate(pool) == []


def test_build_pool_fanout_default_is_disabled_with_no_posts_and_no_links(monkeypatch):
    _force_one_cluster(monkeypatch)
    pool = build_pool_fanout(SOURCES, _results(), NOW)
    assert "primary_source" not in pool["clusters"][0]
    assert pool["counts"]["primary_source"] == {"status": "disabled", "posts": 0, "linked": 0}
    assert validate(pool) == []
