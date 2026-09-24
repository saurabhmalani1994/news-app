"""S22: bodies/<article_id>.json for full_text_ok sources only (R12). No network:
every feed is a fixed bytes string, exactly like the other fanout-level tests."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from contract.validate import check_shape, load_body_schema, validate
from fetcher.bodies import (
    FULL_TEXT_MIN_CHARS,
    build_body,
    collect_bodies,
    extract_body_html,
    write_bodies,
)
from fetcher.fanout import build_pool_fanout, fetch_all

NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)
DATE = "<pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>"

# Comfortably over FULL_TEXT_MIN_CHARS (2000) once tags are stripped.
LONG_PROSE = "<p>" + ("Full article prose sentence. " * 90) + "</p>"
assert len(LONG_PROSE) > FULL_TEXT_MIN_CHARS
SHORT_TEASER = "<p>Just a one line teaser, not the real article.</p>"


def _rss(items_xml):
    return (
        '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">'
        f"<channel>{items_xml}</channel></rss>"
    ).encode("utf-8")


FULL_TEXT_VIA_CONTENT_ENCODED = _rss(
    "<item><title>Full text via content:encoded</title>"
    "<link>https://full.example/a</link>"
    f"<description><![CDATA[{SHORT_TEASER}]]></description>"
    f"<content:encoded><![CDATA[{LONG_PROSE}]]></content:encoded>"
    + DATE + "</item>"
)

FULL_TEXT_VIA_DESCRIPTION = _rss(
    "<item><title>Full text via description</title>"
    "<link>https://full2.example/a</link>"
    f"<description><![CDATA[{LONG_PROSE}]]></description>"
    + DATE + "</item>"
)

TEASER_ONLY = _rss(
    "<item><title>Teaser only</title>"
    "<link>https://teaser.example/a</link>"
    f"<description><![CDATA[{SHORT_TEASER}]]></description>"
    + DATE + "</item>"
)

NO_DESCRIPTION = _rss(
    "<item><title>No description at all</title>"
    "<link>https://nodek.example/a</link>" + DATE + "</item>"
)


def _src(id_, full_text_ok):
    return {
        "id": id_, "name": id_.replace("_", " ").title(), "feed_url": f"https://{id_}.example/feed.xml",
        "bucket": "general", "lean": "center", "lean_basis": "test fixture, not a real rating",
        "syndication_group": id_, "full_text_ok": full_text_ok,
    }


# --- unit level: extract_body_html -----------------------------------------------

def _first_item(rss_bytes):
    import xml.etree.ElementTree as ET
    return ET.fromstring(rss_bytes).find(".//item")


def test_prefers_content_encoded_over_description_when_both_clear_the_bar():
    item = _first_item(FULL_TEXT_VIA_CONTENT_ENCODED)
    html = extract_body_html(item)
    assert html is not None
    assert "Full article prose" in html
    assert "teaser" not in html.lower()


def test_falls_back_to_description_when_no_content_encoded():
    item = _first_item(FULL_TEXT_VIA_DESCRIPTION)
    html = extract_body_html(item)
    assert html is not None
    assert "Full article prose" in html


def test_teaser_only_description_does_not_qualify():
    item = _first_item(TEASER_ONLY)
    assert extract_body_html(item) is None


def _atom_entry(content_xml):
    import xml.etree.ElementTree as ET
    return ET.fromstring(
        '<entry xmlns="http://www.w3.org/2005/Atom">'
        '<link rel="alternate" href="https://atom.example/a"/>' + content_xml + "</entry>"
    )


def test_atom_full_text_via_content_element():
    item = _atom_entry(f'<content type="html">{LONG_PROSE}</content>')
    html = extract_body_html(item, kind="atom")
    assert html is not None
    assert "Full article prose" in html


def test_atom_falls_back_to_summary_when_content_is_short():
    item = _atom_entry(f"<summary>{LONG_PROSE}</summary>")
    html = extract_body_html(item, kind="atom")
    assert html is not None
    assert "Full article prose" in html


def test_atom_teaser_only_summary_does_not_qualify():
    item = _atom_entry("<summary>Just a one line teaser, not the real article.</summary>")
    assert extract_body_html(item, kind="atom") is None


def test_atom_default_kind_argument_does_not_read_atom_fields():
    # kind defaults to "rss": an Atom-shaped <content>/<summary> must not leak into
    # an RSS-flavored body lookup that never asked for it.
    item = _atom_entry(f"<content>{LONG_PROSE}</content>")
    assert extract_body_html(item) is None


def test_no_description_at_all_does_not_qualify():
    item = _first_item(NO_DESCRIPTION)
    assert extract_body_html(item) is None


# --- body record shape -------------------------------------------------------------

def test_build_body_matches_the_closed_schema():
    article = {"id": "abc123", "url": "https://full.example/a"}
    source = {"id": "full_src", "name": "Full Src"}
    record = build_body(article, source, LONG_PROSE)
    assert check_shape(record, load_body_schema()) == []


def test_body_schema_rejects_an_unknown_field():
    article = {"id": "abc123", "url": "https://full.example/a"}
    source = {"id": "full_src", "name": "Full Src"}
    record = build_body(article, source, LONG_PROSE)
    record["extra_field"] = "not allowed"
    assert check_shape(record, load_body_schema()) != []


def test_body_schema_rejects_a_missing_required_field():
    article = {"id": "abc123", "url": "https://full.example/a"}
    source = {"id": "full_src", "name": "Full Src"}
    record = build_body(article, source, LONG_PROSE)
    del record["body_html"]
    assert check_shape(record, load_body_schema()) != []


# --- collect_bodies / write_bodies --------------------------------------------------

def test_collect_bodies_writes_only_for_full_text_ok_sources_that_cleared_the_bar():
    sources = [_src("full_src", True), _src("teaser_src", True), _src("off_src", False)]
    articles = [
        {"id": "a1", "source_id": "full_src", "url": "https://full.example/a"},
        {"id": "a2", "source_id": "teaser_src", "url": "https://teaser.example/a"},
        {"id": "a3", "source_id": "off_src", "url": "https://off.example/a"},
    ]
    candidates = {"a1": LONG_PROSE, "a2": None, "a3": LONG_PROSE}
    bodies, counts = collect_bodies(sources, articles, candidates)
    assert set(bodies) == {"a1"}
    assert counts["written"] == 1
    assert counts["skipped_teaser"] == 1  # a2: full_text_ok source, no usable content
    assert counts["skipped_cap"] == 0
    # a3 never entered candidates as a body attempt at all (off_src is not full_text_ok),
    # so it is neither written nor counted as a skip.


def test_collect_bodies_respects_the_total_byte_cap():
    sources = [_src("s1", True), _src("s2", True)]
    articles = [
        {"id": "a1", "source_id": "s1", "url": "https://s1.example/a"},
        {"id": "a2", "source_id": "s2", "url": "https://s2.example/a"},
    ]
    candidates = {"a1": LONG_PROSE, "a2": LONG_PROSE}
    one_record_size = len(json.dumps(
        build_body(articles[0], sources[0], LONG_PROSE), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8"))
    bodies, counts = collect_bodies(sources, articles, candidates, max_total_bytes=one_record_size)
    assert counts["written"] == 1
    assert counts["skipped_cap"] == 1
    assert len(bodies) == 1


def test_write_bodies_creates_one_file_per_article_id(tmp_path):
    bodies = {
        "a1": {"schema_version": 1, "article_id": "a1", "source_id": "s", "source_name": "S",
               "url": "https://s.example/a", "body_html": LONG_PROSE},
    }
    write_bodies(bodies, tmp_path / "bodies")
    written = tmp_path / "bodies" / "a1.json"
    assert written.exists()
    assert json.loads(written.read_text(encoding="utf-8")) == bodies["a1"]


# --- integration through build_pool_fanout ------------------------------------------

def _run(sources, feeds_by_url):
    def fake_fetch(url, timeout=None):
        return feeds_by_url[url]

    results = fetch_all(sources, fetch_fn=fake_fetch)
    bodies_out = {}
    pool = build_pool_fanout(sources, results, NOW, bodies_out=bodies_out)
    return pool, bodies_out.get("bodies", {})


def test_full_text_source_item_produces_a_valid_body_file_and_has_body_true():
    sources = [_src("full_src", True)]
    feeds = {sources[0]["feed_url"]: FULL_TEXT_VIA_CONTENT_ENCODED}
    pool, bodies = _run(sources, feeds)

    assert len(pool["articles"]) == 1
    article = pool["articles"][0]
    assert article["has_body"] is True
    assert article["id"] in bodies
    assert check_shape(bodies[article["id"]], load_body_schema()) == []
    assert validate(pool) == []


def test_teaser_only_source_produces_no_body_and_has_body_false():
    sources = [_src("full_src", True)]
    feeds = {sources[0]["feed_url"]: TEASER_ONLY}
    pool, bodies = _run(sources, feeds)

    assert len(pool["articles"]) == 1
    article = pool["articles"][0]
    assert "has_body" not in article or article["has_body"] is False
    assert bodies == {}
    assert pool["counts"]["bodies"]["skipped_teaser"] == 1
    assert validate(pool) == []


def test_non_full_text_ok_source_never_gets_a_body_even_with_long_content():
    sources = [_src("off_src", False)]
    feeds = {sources[0]["feed_url"]: FULL_TEXT_VIA_CONTENT_ENCODED}
    pool, bodies = _run(sources, feeds)

    assert len(pool["articles"]) == 1
    article = pool["articles"][0]
    assert "has_body" not in article or article["has_body"] is False
    assert bodies == {}


def test_every_has_body_true_article_has_a_file_and_nothing_else_does():
    sources = [_src("full_src", True), _src("teaser_src", True)]
    feeds = {
        sources[0]["feed_url"]: FULL_TEXT_VIA_CONTENT_ENCODED,
        sources[1]["feed_url"]: TEASER_ONLY,
    }
    pool, bodies = _run(sources, feeds)

    has_body_ids = {a["id"] for a in pool["articles"] if a.get("has_body")}
    no_body_ids = {a["id"] for a in pool["articles"] if not a.get("has_body")}
    assert has_body_ids == set(bodies)
    assert no_body_ids.isdisjoint(bodies)
    assert has_body_ids  # the fixture actually exercises the true branch
    assert no_body_ids  # and the false branch
