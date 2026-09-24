"""The page renders the pool's titles as text, in order (R26)."""
import copy
import json
import re
from html.parser import HTMLParser
from pathlib import Path

from app.build import main as build_main, render

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))


class _Items(HTMLParser):
    """Collects each story's headline text (items), its meta line, its link href, and
    every tag seen. Since S03 a row holds a headline span and a meta span."""

    def __init__(self):
        super().__init__()
        self.items, self.metas, self.hrefs, self.tags = [], [], [], []
        self._in = None

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        attrs = dict(attrs)
        cls = attrs.get("class", "")
        if tag == "li":
            self.hrefs.append(None)
        elif tag == "a" and self.hrefs:
            self.hrefs[-1] = attrs.get("href")
        elif cls == "headline":
            self._in = "headline"
            self.items.append("")
        elif cls == "meta":
            self._in = "meta"
            self.metas.append("")

    def handle_endtag(self, tag):
        if tag == "span":
            self._in = None

    def handle_data(self, data):
        if self._in == "headline":
            self.items[-1] += data
        elif self._in == "meta":
            self.metas[-1] += data


def _parse(page):
    p = _Items()
    p.feed(page)
    return p


def test_rendered_titles_equal_fixture_titles_in_order():
    assert _parse(render(GOLDEN)).items == [a["title"] for a in GOLDEN["articles"]]


def test_hostile_title_renders_as_text_only():
    pool = copy.deepcopy(GOLDEN)
    evil = '<script>alert(1)</script><img src=x onerror="alert(2)">'
    pool["articles"][0]["title"] = evil
    parsed = _parse(render(pool))
    assert parsed.items[0] == evil
    assert "script" not in parsed.tags and "img" not in parsed.tags


def test_page_has_no_images_or_scripts():
    # R26 bans feed content from ever becoming a tag or attribute; img, script and
    # iframe are the injection vectors that matter. It does not ban the app's own
    # stylesheet link, added in S03 to apply the design tokens: that CSS carries no
    # feed data and is not user input.
    tags = set(_parse(render(GOLDEN)).tags)
    assert not tags & {"img", "script", "iframe"}


def test_stylesheets_are_same_origin_only():
    # No third-party font or CSS CDN (S03 brief): every <link rel="stylesheet"> href
    # is a bare relative path, never an absolute URL to another host.
    page = render(GOLDEN)
    hrefs = re.findall(r'<link rel="stylesheet" href="([^"]+)">', page)
    assert hrefs, "expected at least one stylesheet link"
    for href in hrefs:
        assert not re.match(r"^[a-zA-Z]+://", href)
        assert "//" not in href


def test_build_writes_page_and_publishes_pool(tmp_path):
    pool_path = tmp_path / "in.json"
    pool_path.write_text(json.dumps(GOLDEN), encoding="utf-8")
    out = tmp_path / "dist"
    assert build_main(["--pool", str(pool_path), "--out", str(out)]) == 0
    page = (out / "index.html").read_text(encoding="utf-8")
    assert _parse(page).items == [a["title"] for a in GOLDEN["articles"]]
    assert json.loads((out / "pool.json").read_text(encoding="utf-8")) == GOLDEN


def test_each_row_carries_source_and_age_meta():
    pool = copy.deepcopy(GOLDEN)
    pool["generated_at"] = "2026-09-24T06:00:00Z"
    pool["articles"][0]["published_at"] = "2026-09-24T05:48:00Z"
    pool["articles"][1]["published_at"] = "2026-09-24T02:59:00Z"
    pool["articles"][2]["published_at"] = "2026-09-21T06:00:00Z"
    pool["articles"][3]["published_at"] = "not a date"
    parsed = _parse(render(pool))
    assert len(parsed.metas) == len(pool["articles"])
    dot = " " + chr(0x00B7) + " "
    assert parsed.metas[:4] == ["NPR" + dot + "12m ago", "NPR" + dot + "3h ago", "NPR" + dot + "3d ago", "NPR"]


def test_story_link_is_emitted_only_for_http_urls():
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["url"] = "javascript:alert(1)"
    pool["articles"][1]["url"] = "data:text/html,<script>alert(1)</script>"
    pool["articles"][2]["url"] = 'https://example.org/a"onmouseover="alert(1)'
    page = render(pool)
    parsed = _parse(page)
    assert parsed.hrefs[0] is None and parsed.hrefs[1] is None
    assert parsed.hrefs[2] == pool["articles"][2]["url"]  # quoted, stays one attribute
    assert "javascript:" not in page and "data:text" not in page
    assert 'onmouseover="' not in page
    assert parsed.items == [a["title"] for a in pool["articles"]]


def test_hostile_source_name_renders_as_text_only():
    pool = copy.deepcopy(GOLDEN)
    pool["sources"][0]["name"] = "<b>NPR</b>"
    parsed = _parse(render(pool))
    assert parsed.metas[0].startswith("<b>NPR</b>")
    assert "b" not in parsed.tags


def test_page_head_meets_the_system_bar():
    page = render(GOLDEN)
    assert "viewport-fit=cover" in page
    assert '<meta name="theme-color" content="#121212">' in page
    assert re.search(r'<link rel="preload" href="fonts/[^"]+\.woff2" as="font" type="font/woff2" crossorigin>', page)
