"""F7: Atom (<entry>) and RSS 1.0 / RDF (namespaced <item>, dc:date) feed formats.
Standard library only (R30). Mirrors test_fetch.py's own style for the malformed
cases: feeds built inline, since these are format edge cases rather than one
canonical golden pool. R9 leniency is counted through the same _published_at and
_repair logic RSS 2.0 always used (an Atom/RDF date is ISO 8601, so it always trips
the existing iso_date leniency counter, same as an RSS 2.0 feed that happens to use
ISO dates in pubDate already did before this change)."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from contract.validate import validate
from fetcher.fetch import build_pool, feed_kind, parse_xml

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)


def _aid(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _atom(entries):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Sample Atom</title>'
        + entries + "</feed>"
    ).encode("utf-8")


def _rdf(items):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rdf:RDF xmlns="http://purl.org/rss/1.0/" '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<channel rdf:about="https://example.org/rdf"><title>Sample RDF</title></channel>'
        + items + "</rdf:RDF>"
    ).encode("utf-8")


# --- RSS 2.0 regression guard -------------------------------------------------------

def test_rss2_golden_pool_unchanged_after_format_dispatch():
    sample = (ROOT / "tests/fixtures/sample_feed.xml").read_bytes()
    golden = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
    root = parse_xml(sample, {})
    assert feed_kind(root) == "rss"
    assert build_pool(sample, NOW) == golden


# --- Atom -----------------------------------------------------------------------

def test_atom_feed_is_detected_and_parsed():
    data = _atom(
        "<entry><id>tag:example.org,2026:1</id>"
        "<title>Grid batteries reach a price milestone</title>"
        "<summary>Storage costs fell again this quarter.</summary>"
        '<link rel="alternate" href="https://example.org/grid-batteries"/>'
        "<published>2026-09-23T10:00:00Z</published></entry>"
    )
    assert feed_kind(parse_xml(data, {})) == "atom"
    pool = build_pool(data, NOW)
    assert len(pool["articles"]) == 1
    a = pool["articles"][0]
    assert a["title"] == "Grid batteries reach a price milestone"
    assert a["url"] == "https://example.org/grid-batteries"
    assert a["dek"] == "Storage costs fell again this quarter."
    assert a["published_at"] == "2026-09-23T10:00:00Z"
    assert a["id"] == _aid(a["url"])
    assert pool["counts"]["leniency"] == {"iso_date": 1}
    assert validate(pool) == []


def test_atom_falls_back_to_updated_when_published_is_absent():
    data = _atom(
        "<entry><id>tag:example.org,2026:2</id><title>Only updated</title>"
        '<link href="https://example.org/only-updated"/>'
        "<updated>2026-09-22T08:00:00Z</updated></entry>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["published_at"] == "2026-09-22T08:00:00Z"


def test_atom_link_without_rel_defaults_to_alternate():
    # Atom spec 4.2.7.2: a <link> with no rel attribute means rel="alternate".
    data = _atom(
        "<entry><id>tag:example.org,2026:3</id><title>No rel attribute</title>"
        '<link href="https://example.org/no-rel"/>'
        "<published>2026-09-21T00:00:00Z</published></entry>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["url"] == "https://example.org/no-rel"


def test_atom_prefers_alternate_link_over_self_link():
    data = _atom(
        "<entry><id>tag:example.org,2026:4</id><title>Two links</title>"
        '<link rel="self" href="https://feed.example.org/self.atom"/>'
        '<link rel="alternate" href="https://example.org/the-article"/>'
        "<published>2026-09-20T00:00:00Z</published></entry>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["url"] == "https://example.org/the-article"


def test_atom_falls_back_to_id_when_no_link_has_an_href():
    data = _atom(
        "<entry><id>https://example.org/from-id</id><title>Only an id</title>"
        "<published>2026-09-19T00:00:00Z</published></entry>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["url"] == "https://example.org/from-id"


def test_atom_dek_falls_back_to_content_when_summary_absent():
    data = _atom(
        "<entry><id>tag:example.org,2026:5</id><title>Content only</title>"
        '<link href="https://example.org/content-only"/>'
        "<published>2026-09-18T00:00:00Z</published>"
        '<content type="html">&lt;p&gt;Full body text here.&lt;/p&gt;</content></entry>'
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["dek"] == "Full body text here."


def test_atom_missing_title_is_dropped():
    data = _atom(
        "<entry><id>tag:example.org,2026:6</id>"
        '<link href="https://example.org/no-title"/>'
        "<published>2026-09-17T00:00:00Z</published></entry>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"] == []
    assert pool["counts"]["drops"] == {"no_title": 1}


def test_atom_missing_date_is_dropped():
    data = _atom(
        "<entry><id>tag:example.org,2026:7</id><title>No date</title>"
        '<link href="https://example.org/no-date"/></entry>'
    )
    pool = build_pool(data, NOW)
    assert pool["articles"] == []
    assert pool["counts"]["drops"] == {"no_date": 1}


def test_malformed_atom_repairs_and_counts_leniency():
    data = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Sample</title>'
        "<entry><id>tag:example.org,2026:8</id>"
        "<title>Salt & pepper\x01 prices rise</title>"
        '<link href="https://example.org/salt-pepper?x=1&y=2"/>'
        "<published>2026-09-16T00:00:00Z</published></entry></feed>"
    ).encode("utf-8")
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["title"] == "Salt & pepper prices rise"
    assert pool["articles"][0]["url"] == "https://example.org/salt-pepper?x=1&y=2"
    assert pool["counts"]["leniency"] == {
        "bare_ampersand": 2, "control_chars": 1, "iso_date": 1,
    }
    assert validate(pool) == []


# --- RSS 1.0 / RDF ----------------------------------------------------------------

def test_rdf_feed_is_detected_and_parsed():
    data = _rdf(
        '<item rdf:about="https://example.org/rdf-1">'
        "<title>Carbon capture plant breaks ground</title>"
        "<link>https://example.org/rdf-1</link>"
        "<description>Construction begins on the new facility.</description>"
        "<dc:date>2026-09-23T09:00:00Z</dc:date></item>"
    )
    assert feed_kind(parse_xml(data, {})) == "rdf"
    pool = build_pool(data, NOW)
    assert len(pool["articles"]) == 1
    a = pool["articles"][0]
    assert a["title"] == "Carbon capture plant breaks ground"
    assert a["url"] == "https://example.org/rdf-1"
    assert a["dek"] == "Construction begins on the new facility."
    assert a["published_at"] == "2026-09-23T09:00:00Z"
    assert pool["counts"]["leniency"] == {"iso_date": 1}
    assert validate(pool) == []


def test_rdf_falls_back_to_rdf_about_when_link_element_is_missing():
    data = _rdf(
        '<item rdf:about="https://example.org/rdf-about-fallback">'
        "<title>No link element</title>"
        "<dc:date>2026-09-22T09:00:00Z</dc:date></item>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"][0]["url"] == "https://example.org/rdf-about-fallback"


def test_rdf_missing_date_is_dropped():
    # Real-world case found live (Nikkei Asia's RDF feed): title and link present,
    # no dc:date or any other date field on the item at all.
    data = _rdf(
        '<item rdf:about="https://example.org/rdf-no-date">'
        "<title>No date field</title>"
        "<link>https://example.org/rdf-no-date</link></item>"
    )
    pool = build_pool(data, NOW)
    assert pool["articles"] == []
    assert pool["counts"]["drops"] == {"no_date": 1}


def test_malformed_rdf_repairs_and_counts_leniency():
    data = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rdf:RDF xmlns="http://purl.org/rss/1.0/" '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<channel rdf:about="https://example.org/rdf"><title>Sample</title></channel>'
        '<item rdf:about="https://example.org/rdf-2">'
        "<title>Second &mdash; item</title>"
        "<link>https://example.org/rdf-2</link>"
        "<dc:date>2026-09-21T09:00:00</dc:date></item></rdf:RDF>"
    ).encode("utf-8")
    pool = build_pool(data, NOW)
    mdash = chr(8212)
    assert pool["articles"][0]["title"] == f"Second {mdash} item"
    assert pool["counts"]["leniency"] == {"html_entity": 1, "iso_date": 1, "naive_date": 1}
    assert validate(pool) == []


def test_rdf_over_cap_and_duplicate_url_still_drop_correctly():
    # H6 item 2: every date stays inside the fetcher's own bounds (30 days back, 1
    # ahead of NOW) so the cap drop this test checks is never shadowed by a date drop.
    items = "".join(
        f'<item rdf:about="https://example.org/rdf-cap-{n}">'
        f"<title>Item {n}</title><link>https://example.org/rdf-cap-{n}</link>"
        f"<dc:date>2026-09-24T0{n}:00:00Z</dc:date></item>"
        for n in range(1, 7)
    )
    pool = build_pool(_rdf(items), NOW, limit=5)
    assert pool["counts"]["drops"] == {"over_cap": 1}
    assert len(pool["articles"]) == 5
