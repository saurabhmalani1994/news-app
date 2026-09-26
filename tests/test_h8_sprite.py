"""H8: the page's <symbol> sprite takes no room.

T2 put the overflow glyph's <svg><symbol> first in <body class="app"> (a flex column)
with only the HTML `hidden` attribute, which does not hide an SVG element: the sprite
laid out at its default 300x150, stretched to 360x150, an empty band above the tab strip
on the owner's phone. The browser half of the proof is tests/browser/h8_layout_check.mjs.
"""
import json
import re
from pathlib import Path

from app.build import render

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
STYLE = (ROOT / "app/static/style.css").read_text(encoding="utf-8")


def _sprites(page):
    return re.findall(r"<svg\b[^>]*>(?=<symbol\b)", page)


def test_every_symbol_sprite_is_zero_sized_by_its_own_attributes():
    page = render(GOLDEN)
    sprites = _sprites(page)
    assert sprites, "the page has no <symbol> sprite"
    for tag in sprites:
        assert 'width="0"' in tag and 'height="0"' in tag, tag
        assert 'aria-hidden="true"' in tag, tag


def test_the_rows_still_point_at_the_symbol():
    page = render(GOLDEN)
    assert 'id="i-more"' in page
    assert '<use href="#i-more">' in page


def test_the_sprite_is_out_of_the_flow_in_css():
    rule = re.search(r"\.icon-sprite\s*\{([^}]*)\}", STYLE)
    assert rule, "style.css has no .icon-sprite rule"
    body = rule.group(1)
    assert "position: absolute" in body
    assert "width: 0" in body and "height: 0" in body
    assert "display: none" not in body  # <use> must still resolve the symbol
