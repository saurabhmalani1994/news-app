"""The page renders the pool's titles as text, in order (R26)."""
import copy
import json
from html.parser import HTMLParser
from pathlib import Path

from app.build import main as build_main, render

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))


class _Items(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items, self.tags, self._in_li = [], [], False

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == "li":
            self._in_li = True
            self.items.append("")

    def handle_endtag(self, tag):
        if tag == "li":
            self._in_li = False

    def handle_data(self, data):
        if self._in_li:
            self.items[-1] += data


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
    tags = set(_parse(render(GOLDEN)).tags)
    assert not tags & {"img", "script", "style", "link", "iframe"}


def test_build_writes_page_and_publishes_pool(tmp_path):
    pool_path = tmp_path / "in.json"
    pool_path.write_text(json.dumps(GOLDEN), encoding="utf-8")
    out = tmp_path / "dist"
    assert build_main(["--pool", str(pool_path), "--out", str(out)]) == 0
    page = (out / "index.html").read_text(encoding="utf-8")
    assert _parse(page).items == [a["title"] for a in GOLDEN["articles"]]
    assert json.loads((out / "pool.json").read_text(encoding="utf-8")) == GOLDEN
