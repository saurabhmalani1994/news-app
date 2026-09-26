"""S25: what the build gives the in-app reader. A story link carries data-body only when
its lead article has a body file (S22 has_body) and a link out, and only an id of the
contract's shape; the reader's layer is static chrome that passes the CSP scan; the
rank input names each openable lead's own hero-worthy photo, never a borrowed one."""
import copy
import json
import re
from html import unescape
from pathlib import Path

from app.build import READER, body_id, render
from app.csp import headers_file, scan
from app.page_input import decode_input

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))


def _pool(**changes):
    pool = copy.deepcopy(GOLDEN)
    for index, fields in changes.items():
        pool["articles"][int(index.lstrip("a"))].update(fields)
    return pool


def _rank_input(page):
    text = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    return decode_input(json.loads(unescape(text)))


def _body_links(page):
    return re.findall(r'<a class="story-link" href="[^"]*" target="_blank" rel="noopener noreferrer" data-body="([^"]*)">', page)


def test_only_has_body_leads_open_the_reader():
    first, second = GOLDEN["articles"][0]["id"], GOLDEN["articles"][1]["id"]
    page = render(_pool(a0={"has_body": True}, a1={"has_body": False}))
    assert _body_links(page) == [first]
    assert second not in _body_links(page)
    assert page.count("data-body=") == 1


def test_no_has_body_means_no_reader_links():
    assert "data-body=" not in render(GOLDEN)


def test_a_story_without_a_safe_link_out_never_opens_the_reader():
    page = render(_pool(a0={"has_body": True, "url": "javascript:alert(1)"}))
    assert "data-body=" not in page


def test_body_id_is_the_contract_shape_only():
    base = {"has_body": True, "url": "https://example.org/a"}
    assert body_id({**base, "id": "b827ba1a90cf4138"}) == "b827ba1a90cf4138"
    for bad in ("../pool", "a/b", "A1", "", "x" * 65, '"><script>', None):
        assert body_id({**base, "id": bad}) is None
    assert body_id({"id": "abc", "has_body": "true", "url": "https://example.org/a"}) is None


def test_reader_layer_is_static_hidden_and_csp_clean():
    page = render(_pool(a0={"has_body": True}))
    assert page.count('id="reader"') == 1 and READER in page
    assert re.search(r'<div class="reader" id="reader"[^>]*\bhidden>', page)
    styles, problems = scan(page)
    assert problems == []
    headers_file({"index.html": page})  # raises on anything the CSP would block


def test_reader_photo_is_the_leads_own_hero_worthy_image():
    own = {"url": "https://img.example/own-1200x800.jpg", "width": 1200, "height": 800, "credit": "Photo: A. Person"}
    small = {"url": "https://img.example/small.jpg", "width": 300, "height": 200}
    page = render(_pool(a0={"has_body": True, "image": own}, a1={"has_body": True, "image": small},
                        a2={"has_body": False, "image": own}))
    photos = _rank_input(page)["reader"]
    first = GOLDEN["articles"][0]["id"]
    assert list(photos) == [first]
    url, width, height, credit = photos[first]
    assert url == own["url"] and (width, height) == (360, 270) and credit == "Photo: A. Person"
