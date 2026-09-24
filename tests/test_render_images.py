"""S39 proof, render side: pool photos become a hero image and river thumbnails with
reserved boxes, the text-only variant everywhere else, and never any other HTML.

- every rendered img has width, height and a 1 / 1 aspect-ratio box (style.css);
- non-https or missing images render exactly the text-only row;
- tier order and counts are the same as the render with every image stripped;
- the hero gets a photo only when its stated width is hero-worthy (app.images);
- urls and credits are escaped attribute values and text, never markup (R26).
The CLS half of the proof is tests/browser/images_cls.mjs (headless Chrome).
"""
import copy
import json
import re
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

from app.build import render
from app.frontpage import front_page
from app.images import HERO_MIN_WIDTH, credit_text, hero_worthy, image_url, media_for, thumb_ok

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
STYLE = (ROOT / "app/static/style.css").read_text(encoding="utf-8")
PHOTO = {"url": "https://img.example/photo.jpg", "width": 1200, "height": 675}


def _big_pool(copies=5):
    """The golden pool five times over (new ids and titles), so every tier, text-only
    included, has rows."""
    pool = copy.deepcopy(GOLDEN)
    extra = []
    for n in range(1, copies):
        for a in GOLDEN["articles"]:
            b = copy.deepcopy(a)
            b["id"] = f"{a['id']}-{n}"
            b["title"] = f"{a['title']} {n}"
            extra.append(b)
    pool["articles"] += extra
    return pool


def _with_images(pool, image=PHOTO):
    pool = copy.deepcopy(pool)
    for a in pool["articles"]:
        a["image"] = copy.deepcopy(image)
    return pool


def _stripped(pool):
    pool = copy.deepcopy(pool)
    for a in pool["articles"]:
        a.pop("image", None)
    return pool


class _Rows(HTMLParser):
    """Per row: sid, tier, and every img's attributes, frame kind and credit text."""

    def __init__(self):
        super().__init__()
        self.rows, self._credit = [], False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "li" and "story" in classes:
            tier = next(c[len("story--"):] for c in classes if c.startswith("story--"))
            self.rows.append({"sid": a["data-sid"], "tier": tier, "imgs": [], "frames": [], "credit": None})
        elif tag == "img":
            self.rows[-1]["imgs"].append(a)
        elif tag == "span" and "story-media" in classes:
            self.rows[-1]["frames"].append(a["class"])
        elif tag == "span" and "story-credit" in classes:
            self._credit, self.rows[-1]["credit"] = True, ""

    def handle_endtag(self, tag):
        if tag == "span":
            self._credit = False

    def handle_data(self, data):
        if self._credit:
            self.rows[-1]["credit"] += data


def _rows(page):
    p = _Rows()
    p.feed(page)
    return p.rows


def _css_rule(selector):
    return re.search(re.escape(selector) + r"\s*\{([^}]*)\}", STYLE).group(1)


def test_every_rendered_image_has_width_height_and_aspect_ratio_box():
    page = render(_with_images(_big_pool()))
    imgs = [(row["tier"], img, row["frames"]) for row in _rows(page) for img in row["imgs"]]
    assert imgs, "expected photos on the page"
    for tier, img, frames in imgs:
        size = "360" if tier == "hero" else "88"
        assert img["width"] == size and img["height"] == size
        assert img["class"] == "story-img" and len(frames) == 1
        assert img["alt"] == "" and img["decoding"] == "async" and img["referrerpolicy"] == "no-referrer"
        if tier == "hero":
            assert img["fetchpriority"] == "high" and "loading" not in img
        else:
            assert img["loading"] == "lazy" and "fetchpriority" not in img
    # The frame and the img both carry the square box, the img fills it, cover crops.
    for selector in (".story-media", ".story-img"):
        assert "aspect-ratio: 1 / 1" in _css_rule(selector)
    assert "object-fit: cover" in _css_rule(".story-img")
    assert "var(--color-image-placeholder)" in _css_rule(".story-media")
    river = _css_rule(".story--river .story-media")
    assert "width: 88px" in river and "height: 88px" in river


def test_photos_only_in_hero_and_river_tiers():
    rows = _rows(render(_with_images(_big_pool())))
    by_tier = {}
    for row in rows:
        by_tier.setdefault(row["tier"], []).append(len(row["imgs"]))
    assert by_tier["hero"] == [1]
    assert by_tier["river"] and set(by_tier["river"]) == {1}
    assert set(by_tier["secondary"]) == {0} and set(by_tier["text-only"]) == {0}


def test_tier_order_and_counts_unchanged_versus_no_image_render():
    pool = _big_pool()
    with_images = _with_images(pool)
    # Half the pool with photos, so image and no-image rows interleave.
    for a in with_images["articles"][::2]:
        a.pop("image")
    order = [(r["sid"], r["tier"]) for r in _rows(render(with_images))]
    plain = [(r["sid"], r["tier"]) for r in _rows(render(_stripped(pool)))]
    assert order == plain
    tiers = front_page(with_images)
    assert {k: len(v) for k, v in tiers.items()} == {k: len(v) for k, v in front_page(pool).items()}


BAD_URLS = [
    "http://img.example/photo.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//img.example/photo.jpg",
    "https:/img.example/photo.jpg",
    "https://",
    "https://img.example/a b.jpg",
    "https://img.example/\u0000.jpg",
    "",
    None,
    42,
]


def test_non_https_or_missing_image_renders_the_text_only_variant():
    pool = _big_pool()
    plain = render(_stripped(pool))
    for bad in BAD_URLS:
        page = render(_with_images(pool, {"url": bad, "width": 1200, "height": 800, "credit": "Photo: A"}))
        assert page == plain, bad  # byte for byte, device image records included
        assert "<img" not in page and "story-media" not in page and "story-credit" not in page
    # An article with no image key at all is the same as the stripped render.
    assert render(pool) == plain


def test_hero_image_needs_a_stated_hero_worthy_width():
    pool = _big_pool()
    hero_id = front_page(pool)["hero"][0].id
    for image, expect in [
        ({"url": PHOTO["url"]}, False),  # size unknown: the hero stays text-only
        ({"url": PHOTO["url"], "width": HERO_MIN_WIDTH - 1, "height": 400}, False),
        ({"url": PHOTO["url"], "width": HERO_MIN_WIDTH}, True),
        ({"url": PHOTO["url"], "width": 1600, "height": 900}, True),
    ]:
        p = copy.deepcopy(pool)
        next(a for a in p["articles"] if a["id"] == hero_id)["image"] = image
        hero = _rows(render(p))[0]
        assert hero["tier"] == "hero" and bool(hero["imgs"]) is expect, image
        assert hero_worthy(image) is expect


def test_thumbnail_rule_skips_images_stated_smaller_than_the_box():
    assert thumb_ok({"url": PHOTO["url"]})
    assert thumb_ok({"url": PHOTO["url"], "width": 240, "height": 135})
    assert not thumb_ok({"url": PHOTO["url"], "width": 240, "height": 60})
    assert not thumb_ok({"url": "http://img.example/x.jpg", "width": 240, "height": 135})
    assert image_url({"url": "HTTPS://img.example/x.jpg"}) == "HTTPS://img.example/x.jpg"


def test_hostile_image_url_is_an_escaped_attribute_value():
    evil = 'https://img.example/a"onerror="alert(1)"><script>alert(2)</script>.jpg'
    pool = _with_images(_big_pool(), {"url": evil, "width": 1200, "height": 675})
    page = render(pool)
    rows = _rows(page)
    imgs = [img for row in rows for img in row["imgs"]]
    assert imgs and all(img["src"] == evil for img in imgs)
    assert all(set(img) == {"class", "src", "width", "height", "alt", "decoding", "referrerpolicy",
                            "fetchpriority" if "fetchpriority" in img else "loading"} for img in imgs)
    # Outside src values and the device's JSON template (text, R26), no trace of it.
    markup = re.sub(r'<template id="rank-input">.*?</template>', "", page, flags=re.S)
    assert "onerror" not in re.sub(r'src="[^"]*"', "", markup)
    assert "&gt;&lt;script&gt;" in page and "<script>alert" not in page
    assert re.findall(r"<script\b[^>]*>", page) == ['<script src="js/rank-gate.js">']


def test_credit_is_text_under_the_hero_only():
    pool = _big_pool()
    hostile = "<b>Photo</b>: Jane <img src=x onerror=alert(1)>"
    p = _with_images(pool, dict(PHOTO, credit=hostile))
    rows = _rows(render(p))
    assert rows[0]["tier"] == "hero" and rows[0]["credit"] == hostile
    assert all(row["credit"] is None for row in rows[1:])
    assert sum(len(row["imgs"]) for row in rows) == 1 + sum(1 for r in rows if r["tier"] == "river")


def test_credit_rule_keeps_a_short_credit_and_drops_a_caption():
    assert credit_text({"credit": "Photo: Ina Fried/Axios"}) == "Photo: Ina Fried/Axios"
    assert credit_text({"credit": "Sen. Jon Ossoff. Photo: Elijah Nouvelage/Getty Images"}) == \
        "Photo: Elijah Nouvelage/Getty Images"
    assert credit_text({"credit": "Aurich Lawson | Getty Images"}) == "Aurich Lawson | Getty Images"
    assert credit_text({"credit": "A long caption " * 8}) == ""
    assert credit_text({}) == "" and credit_text(None) == ""


def test_page_embeds_image_records_for_a_device_rerank():
    pool = _with_images(_big_pool())
    pool["articles"][0]["image"] = {"url": "http://img.example/x.jpg", "width": 1200}
    page = render(pool)
    data = json.loads(unescape(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)))
    images = data["images"]
    assert pool["articles"][0]["id"] not in images
    assert len(images) == len(pool["articles"]) - 1
    assert all(record == [PHOTO["url"], 1, 1, ""] for record in images.values())
    assert media_for({"url": PHOTO["url"], "width": 240, "height": 135}) == [PHOTO["url"], 0, 1, ""]
    assert media_for({"url": PHOTO["url"], "width": 40, "height": 40}) is None
