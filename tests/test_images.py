"""S38 proof: per-article image from the feed's own fields only, never a fetched or
probed url (R34). One fixture per source type picks the right url and size; a bad
http url, a data URI, a 1x1 pixel and a repeated per-source placeholder are each
rejected with the right reason; items without images still validate.
"""
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone

from contract.validate import validate
from fetcher.fanout import build_pool_fanout
from fetcher.images import extract_image, filter_placeholder_logos, tally_found

NS = (
    ' xmlns:media="http://search.yahoo.com/mrss/"'
    ' xmlns:content="http://purl.org/rss/1.0/modules/content/"'
)
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)


def _item(inner):
    return ET.fromstring(f"<item{NS}>{inner}</item>")


# --- one fixture per source type, priority order -----------------------------------

def test_media_content_picks_largest_image_medium_candidate():
    item = _item(
        '<media:content url="https://img.example/small.jpg" medium="image" width="200" height="100"/>'
        '<media:content url="https://img.example/large.jpg" medium="image" width="1200" height="800">'
        "<media:credit>Jane Doe/Agency</media:credit></media:content>"
        '<media:content url="https://img.example/video.mp4" medium="video" width="1920" height="1080"/>'
    )
    rejected = Counter()
    image, method = extract_image(item, rejected)
    assert method == "media_content"
    assert image == {
        "url": "https://img.example/large.jpg", "width": 1200, "height": 800,
        "credit": "Jane Doe/Agency",
    }
    assert rejected == {}


def test_media_thumbnail_used_when_no_media_content():
    item = _item('<media:thumbnail url="https://img.example/thumb.jpg" width="300" height="200"/>')
    image, method = extract_image(item, Counter())
    assert method == "media_thumbnail"
    assert image == {"url": "https://img.example/thumb.jpg", "width": 300, "height": 200}


def test_enclosure_used_when_no_media_tags():
    item = _item('<enclosure url="https://img.example/enc.jpg" type="image/jpeg" length="12345"/>')
    image, method = extract_image(item, Counter())
    assert method == "enclosure"
    assert image == {"url": "https://img.example/enc.jpg"}


def test_enclosure_non_image_type_ignored():
    item = _item('<enclosure url="https://example.com/audio.mp3" type="audio/mpeg"/>')
    image, method = extract_image(item, Counter())
    assert (image, method) == (None, None)


def test_content_img_last_resort_from_description_counted_separately():
    item = _item(
        "<description><![CDATA[<p>Look "
        '<img src="https://img.example/inline.jpg" width="640" height="360"> at this</p>]]>'
        "</description>"
    )
    image, method = extract_image(item, Counter())
    assert method == "content_img"
    assert image == {"url": "https://img.example/inline.jpg", "width": 640, "height": 360}


def test_content_img_falls_back_to_content_encoded():
    item = _item(
        "<content:encoded><![CDATA[<div><img src=\"https://img.example/body.jpg\"></div>]]>"
        "</content:encoded>"
    )
    image, method = extract_image(item, Counter())
    assert method == "content_img"
    assert image == {"url": "https://img.example/body.jpg"}


def test_priority_order_media_content_beats_everything_else():
    item = _item(
        '<media:content url="https://img.example/best.jpg" medium="image" width="800" height="600"/>'
        '<media:thumbnail url="https://img.example/thumb.jpg" width="300" height="200"/>'
        '<enclosure url="https://img.example/enc.jpg" type="image/jpeg"/>'
    )
    image, method = extract_image(item, Counter())
    assert method == "media_content"
    assert image["url"] == "https://img.example/best.jpg"


def test_no_image_field_at_all_is_a_clean_miss():
    item = _item("<title>No pictures here</title>")
    assert extract_image(item, Counter()) == (None, None)


# --- rejections, one reason each ----------------------------------------------------

def test_rejects_non_https_url():
    item = _item('<media:thumbnail url="http://img.example/thumb.jpg" width="300" height="200"/>')
    rejected = Counter()
    image, method = extract_image(item, rejected)
    assert (image, method) == (None, None)
    assert rejected == {"not_https": 1}


def test_rejects_data_uri():
    item = _item(
        '<media:content url="data:image/png;base64,AAAA" medium="image" width="100" height="100"/>'
    )
    rejected = Counter()
    image, method = extract_image(item, rejected)
    assert (image, method) == (None, None)
    assert rejected == {"data_uri": 1}


def test_rejects_1x1_tracking_pixel():
    item = _item('<media:content url="https://img.example/pixel.gif" medium="image" width="1" height="1"/>')
    rejected = Counter()
    image, method = extract_image(item, rejected)
    assert (image, method) == (None, None)
    assert rejected == {"tiny_pixel": 1}


def test_bad_candidate_falls_through_to_next_method():
    # media:content is unusable (http), so the item still gets its media:thumbnail.
    item = _item(
        '<media:content url="http://img.example/insecure.jpg" medium="image" width="900" height="600"/>'
        '<media:thumbnail url="https://img.example/thumb.jpg" width="300" height="200"/>'
    )
    rejected = Counter()
    image, method = extract_image(item, rejected)
    assert method == "media_thumbnail"
    assert rejected == {"not_https": 1}


def test_repeated_placeholder_rejected_across_a_source(monkeypatch):
    # Three items from one source, every one carrying the exact same "logo" image:
    # an obvious placeholder, not a photo, per R34. Needs the whole source's worth of
    # published articles, so this exercises the full fanout pipeline, not extract_image
    # alone.
    logo = '<media:content url="https://img.example/logo.png" medium="image" width="400" height="300"/>'
    feed = (
        f'<rss version="2.0"{NS}><channel>'
        '<item><title>One</title><link>https://good.example/1</link>'
        '<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>' + logo + "</item>"
        '<item><title>Two</title><link>https://good.example/2</link>'
        '<pubDate>Wed, 23 Sep 2026 10:01:00 GMT</pubDate>' + logo + "</item>"
        '<item><title>Three</title><link>https://good.example/3</link>'
        '<pubDate>Wed, 23 Sep 2026 10:02:00 GMT</pubDate>' + logo + "</item>"
        "</channel></rss>"
    ).encode("utf-8")

    sources = [{
        "id": "good", "name": "Good", "feed_url": "https://good.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test",
        "syndication_group": "good",
    }]
    results = {"good": (feed, None)}
    pool = build_pool_fanout(sources, results, NOW)

    assert pool["counts"]["published"] == 3
    assert all("image" not in a for a in pool["articles"])
    assert pool["counts"]["images"]["rejected"] == {"repeated_placeholder": 3}
    assert pool["counts"]["images"]["found"] == {}
    assert validate(pool) == []


def test_distinct_images_from_one_source_are_not_treated_as_placeholders():
    feed = (
        f'<rss version="2.0"{NS}><channel>'
        '<item><title>One</title><link>https://good.example/1</link>'
        '<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>'
        '<media:content url="https://img.example/a.jpg" medium="image" width="400" height="300"/>'
        "</item>"
        '<item><title>Two</title><link>https://good.example/2</link>'
        '<pubDate>Wed, 23 Sep 2026 10:01:00 GMT</pubDate>'
        '<media:content url="https://img.example/b.jpg" medium="image" width="400" height="300"/>'
        "</item>"
        "</channel></rss>"
    ).encode("utf-8")
    sources = [{
        "id": "good", "name": "Good", "feed_url": "https://good.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test",
        "syndication_group": "good",
    }]
    pool = build_pool_fanout(sources, {"good": (feed, None)}, NOW)
    assert pool["counts"]["published"] == 2
    assert all("image" in a for a in pool["articles"])
    assert pool["counts"]["images"]["found"] == {"media_content": 2}
    assert pool["counts"]["images"]["rejected"] == {}
    assert validate(pool) == []


def test_single_item_source_same_url_is_not_a_repeat():
    # Repetition needs at least two items to observe; a lone item keeps its image.
    feed = (
        f'<rss version="2.0"{NS}><channel>'
        '<item><title>Only</title><link>https://good.example/1</link>'
        '<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>'
        '<media:content url="https://img.example/only.jpg" medium="image" width="400" height="300"/>'
        "</item>"
        "</channel></rss>"
    ).encode("utf-8")
    sources = [{
        "id": "good", "name": "Good", "feed_url": "https://good.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test",
        "syndication_group": "good",
    }]
    pool = build_pool_fanout(sources, {"good": (feed, None)}, NOW)
    assert pool["articles"][0]["image"]["url"] == "https://img.example/only.jpg"
    assert pool["counts"]["images"]["found"] == {"media_content": 1}


def test_items_without_images_still_validate():
    feed = (
        f'<rss version="2.0"{NS}><channel>'
        '<item><title>Plain text story</title><link>https://good.example/1</link>'
        "<description>No media tags anywhere in this item.</description>"
        '<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate></item>'
        "</channel></rss>"
    ).encode("utf-8")
    sources = [{
        "id": "good", "name": "Good", "feed_url": "https://good.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test",
        "syndication_group": "good",
    }]
    pool = build_pool_fanout(sources, {"good": (feed, None)}, NOW)
    assert "image" not in pool["articles"][0]
    assert pool["counts"]["images"] == {"found": {}, "rejected": {}}
    assert validate(pool) == []


def test_no_scratch_field_leaks_into_the_published_pool():
    feed = (
        f'<rss version="2.0"{NS}><channel>'
        '<item><title>One</title><link>https://good.example/1</link>'
        '<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>'
        '<media:content url="https://img.example/a.jpg" medium="image" width="400" height="300"/>'
        "</item>"
        "</channel></rss>"
    ).encode("utf-8")
    sources = [{
        "id": "good", "name": "Good", "feed_url": "https://good.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test",
        "syndication_group": "good",
    }]
    pool = build_pool_fanout(sources, {"good": (feed, None)}, NOW)
    assert "_image_method" not in pool["articles"][0]


def test_filter_and_tally_helpers_directly():
    articles = [
        {"source_id": "s", "image": {"url": "https://x/1.jpg"}, "_image_method": "enclosure"},
        {"source_id": "s", "image": {"url": "https://x/1.jpg"}, "_image_method": "enclosure"},
        {"source_id": "t", "image": {"url": "https://x/2.jpg"}, "_image_method": "media_content"},
    ]
    rejected = Counter()
    filter_placeholder_logos(articles, rejected)
    assert rejected == {"repeated_placeholder": 2}
    found = tally_found(articles)
    assert found == {"media_content": 1}
    assert all("_image_method" not in a for a in articles)
