"""S39 proof, render side: pool photos become a hero image and river thumbnails with
reserved boxes, the text-only variant everywhere else, and never any other HTML.

- every rendered img has width, height and an aspect-ratio box (style.css): 1 / 1 for a
  thumbnail, the hero's stated shape clamped to [1:1, 4:3] (D2);
- non-https or missing images render exactly the text-only row;
- tier order and counts are the same as the render with every image stripped;
- the hero gets a photo only when a stated width is hero-worthy (app.images), and (D2)
  takes it from the best-shaped, widest non-video photo in its cluster without changing
  the lead or its headline, crediting another outlet's photo by name;
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
from app.images import (HERO_MIN_WIDTH, credit_text, hero_box, hero_media, hero_pick, hero_worthy, image_url,
                        likely_video_or_graphic, media_for, thumb_ok)

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
        self.rows, self._credit, self._headline = [], False, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "li" and "story" in classes:
            tier = next(c[len("story--"):] for c in classes if c.startswith("story--"))
            self.rows.append({"sid": a["data-sid"], "tier": tier, "imgs": [], "frames": [], "credit": None,
                              "box": None, "headline": ""})
        elif tag == "span" and "headline" in classes:
            self._headline = True
        elif tag == "img":
            self.rows[-1]["imgs"].append(a)
        elif tag == "span" and "story-media" in classes:
            self.rows[-1]["frames"].append(a["class"])
            self.rows[-1]["box"] = a.get("style")
        elif tag == "span" and "story-credit" in classes:
            self._credit, self.rows[-1]["credit"] = True, ""

    def handle_endtag(self, tag):
        if tag == "span":
            self._credit = self._headline = False

    def handle_data(self, data):
        if self._credit:
            self.rows[-1]["credit"] += data
        if self._headline:
            self.rows[-1]["headline"] += data


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
        # PHOTO states 1200x675 (16:9): the hero box is 4:3, never narrower (D2).
        size = ("360", "270") if tier == "hero" else ("88", "88")
        assert (img["width"], img["height"]) == size
        assert img["class"] == "story-img" and len(frames) == 1
        assert img["alt"] == "" and img["decoding"] == "async" and img["referrerpolicy"] == "no-referrer"
        if tier == "hero":
            assert img["fetchpriority"] == "high" and "loading" not in img
        else:
            assert img["loading"] == "lazy" and "fetchpriority" not in img
    # The frame and the img both carry the box (square, or in the hero the --box the
    # build set), the img fills it, cover crops with the D2 crop focus.
    for selector in (".story-media", ".story-img"):
        assert "aspect-ratio: 1 / 1" in _css_rule(selector)
    assert "aspect-ratio: var(--box, 1 / 1)" in _css_rule(".story--hero .story-img")
    assert "object-fit: cover" in _css_rule(".story-img")
    assert "object-position: 50% 30%" in _css_rule(".story-img")
    rows = _rows(page)
    assert rows[0]["box"] == "--box: 360 / 270"
    assert all(row["box"] is None for row in rows[1:])
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
    assert re.findall(r"<script\b[^>]*>", page) == [
        '<script src="js/offline-gate.js">', '<script src="js/rank-gate.js">',
        '<script type="module" src="js/tabs.js">', '<script type="module" src="js/reader.js">',
        '<script type="module" src="js/story-actions.js">',
        '<script type="module" src="js/coverage-view.js">',
        '<script type="module" src="js/versions-view.js">',
        '<script type="module" src="js/lean-view.js">',
        '<script type="module" src="js/history/observe.js">',
        '<script type="module" src="js/live-actions.js">',
        '<script type="module" src="js/saved-screen.js">',
        '<script src="js/sw-register.js" defer>', '<script src="js/offline.js">',
    ]  # S11/S18 gates, S27 tabs, S25 reader, S24 story-actions, S14 coverage-view, V1 versions-view, S15 history, S33 live-actions, S26 saved-screen, S18 offline+sw, L1 lean-view


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
    assert all(record == {"hero": [PHOTO["url"], 360, 270, ""], "thumb": PHOTO["url"]} for record in images.values())
    small = {"url": PHOTO["url"], "width": 240, "height": 135}
    assert media_for(None, small) == {"thumb": PHOTO["url"]}
    assert media_for((PHOTO, "Photo via NPR"), None) == {"hero": [PHOTO["url"], 360, 270, "Photo via NPR"]}
    assert media_for(None, {"url": PHOTO["url"], "width": 40, "height": 40}) is None


# D2: the hero box follows the photo's stated shape, clamped to [1:1, 4:3].
BOXES = [
    ((1080, 1080), 360),  # NYT's own square
    ((800, 1200), 360),   # portrait: the NYT square, never taller
    ((1200, 1000), 300),  # 1.2 sits inside the clamp: its own shape, uncropped
    ((1024, 768), 270),   # 4:3 exactly
    ((1024, 683), 270),   # 3:2 is cropped to 4:3
    ((1600, 900), 270),   # 16:9 is cropped to 4:3, never narrower
    ((1200, None), 360),  # height unstated: the NYT square
]


def test_hero_box_follows_the_stated_ratio_within_the_clamp():
    pool = _big_pool()
    hero_id = front_page(pool)["hero"][0].id
    for (width, height), box_height in BOXES:
        image = {"url": PHOTO["url"], "width": width}
        if height:
            image["height"] = height
        assert hero_box(image) == (360, box_height), image
        ratio = 360 / box_height
        assert 1 <= ratio <= 4 / 3
        if height and 1 <= width / height <= 4 / 3:
            assert abs(ratio - width / height) < 0.01  # inside the clamp: the photo's own ratio
        p = copy.deepcopy(pool)
        next(a for a in p["articles"] if a["id"] == hero_id)["image"] = image
        hero = _rows(render(p))[0]
        assert hero["box"] == f"--box: 360 / {box_height}"
        assert (hero["imgs"][0]["width"], hero["imgs"][0]["height"]) == ("360", str(box_height))


OUTLETS = {"reuters": "Reuters", "pbs": "PBS News", "mint": "Mint", "hkfp": "Hong Kong Free Press",
           "axios": "Axios", "wire": "Wire"}


def _cluster_pool(images):
    """The golden hero article fronting a cluster with one article per other outlet, no
    deks on the others so the lead stays the golden hero. `images` maps outlet id to that
    article's image; the lead's own image goes under the key "lead"."""
    pool = copy.deepcopy(_big_pool(2))
    lead_id = front_page(pool)["hero"][0].lead["id"]
    lead = next(a for a in pool["articles"] if a["id"] == lead_id)
    pool["sources"] += [{"id": sid, "name": name, "feed_url": f"https://{sid}.example/rss"}
                        for sid, name in OUTLETS.items()]
    members = []
    for n, sid in enumerate(OUTLETS):
        a = copy.deepcopy(lead)
        a.update(id=f"d2-{n}", source_id=sid, title=f"Other outlet {n} on the same story", dek="")
        a["url"] = f"https://{sid}.example/story"
        members.append(a)
    pool["articles"] += members
    pool["clusters"] = [{"id": "c_d2", "method": "cosine_entity", "article_ids": [lead_id] + [a["id"] for a in members],
                         "near_duplicates": [], "independent_sources": len(members) + 1, "lean_buckets": ["center"]}]
    for a in [lead] + members:
        key = "lead" if a is lead else a["source_id"]
        if key in images:
            a["image"] = images[key]
    return pool, lead_id


CLUSTER_IMAGES = {
    # The lead's own: a 16:9 YouTube frame re-hosted, the S39 failure.
    "lead": {"url": "https://img.example/1600x900/maxresdefault_1790227284392.jpg", "width": 1600, "height": 900},
    "pbs": {"url": "https://img.example/press-1024x683.jpg", "width": 1024, "height": 683},  # 3:2, the answer
    "reuters": {"url": "https://img.example/r-900x600.jpg", "width": 900, "height": 600},  # 3:2, narrower
    "hkfp": {"url": "https://img.example/xi-1024x576.jpg", "width": 1024, "height": 576},  # 16:9, crops 25%
    "axios": {"url": "https://img.example/a.jpg", "width": 1280, "height": 720},  # exact video frame
    "mint": {"url": "https://i.ytimg.com/vi/x/photo.jpg", "width": 3000, "height": 2000},  # video host
    "wire": {"url": "https://img.example/w.jpg", "width": 2400},  # no stated height: shape unknown
}


def test_hero_takes_the_widest_well_shaped_cluster_photo_and_credits_its_outlet():
    pool, lead_id = _cluster_pool(CLUSTER_IMAGES)
    plain = _stripped(pool)
    tiers, plain_tiers = front_page(pool), front_page(plain)
    hero = tiers["hero"][0]
    assert hero.id == "c_d2" and hero.lead["id"] == lead_id
    # Headline and lead unchanged: the same story fronts the page with the same lead,
    # and every row's order, tier and headline match the render with no images at all.
    assert plain_tiers["hero"][0].lead["id"] == lead_id
    rows, plain_rows = _rows(render(pool)), _rows(render(plain))
    assert [(r["sid"], r["tier"], r["headline"]) for r in rows] == \
        [(r["sid"], r["tier"], r["headline"]) for r in plain_rows]
    assert rows[0]["headline"] and "Other outlet" not in rows[0]["headline"]
    # The photo is PBS's 3:2 1024 wide one, boxed at 4:3, credited to PBS by name.
    by_id = {a["id"]: a for a in pool["articles"]}
    assert hero_pick([by_id[i] for i in hero.article_ids], hero.lead)["source_id"] == "pbs"
    assert rows[0]["imgs"][0]["src"] == CLUSTER_IMAGES["pbs"]["url"]
    assert rows[0]["box"] == "--box: 360 / 270" and rows[0]["credit"] == "Photo via PBS News"
    # Take the winner away each time: the narrower 3:2, then the 16:9 photo, then the
    # unknown shape, then the video and graphic stills, the lead's maxresdefault among
    # them, only when nothing else is left.
    order = []
    left = dict(CLUSTER_IMAGES)
    while True:
        p, _ = _cluster_pool(left)
        story = front_page(p)["hero"][0]
        by_id = {a["id"]: a for a in p["articles"]}
        pick = hero_pick([by_id[i] for i in story.article_ids], story.lead)
        if pick is None:
            break
        key = "lead" if pick["id"] == lead_id else pick["source_id"]
        order.append(key)
        left.pop(key)
    assert order == ["pbs", "reuters", "hkfp", "wire", "mint", "lead", "axios"]


def test_hero_keeps_the_leads_own_photo_when_it_is_already_sharp_and_well_shaped():
    own = {"url": "https://img.example/own.jpg", "width": 1200, "height": 800, "credit": "Photo: Jane Doe/AP"}
    wider = {"url": "https://img.example/wide.jpg", "width": 3000, "height": 2000}
    pool, _ = _cluster_pool({"lead": own, "pbs": wider})
    row = _rows(render(pool))[0]
    assert row["imgs"][0]["src"] == own["url"] and row["credit"] == "Photo: Jane Doe/AP"
    # A small own photo gives way to a sharper borrowed one.
    small = dict(own, width=640, height=427)
    pool, _ = _cluster_pool({"lead": small, "pbs": wider})
    row = _rows(render(pool))[0]
    assert row["imgs"][0]["src"] == wider["url"] and row["credit"] == "Photo via PBS News"


def test_borrowed_hero_photo_needs_a_named_outlet():
    lead = {"id": "a", "source_id": "npr", "image": None}
    other = {"id": "b", "source_id": "ghost", "image": {"url": "https://img.example/g.jpg", "width": 1200, "height": 800}}
    assert hero_media([lead, other], lead, {"npr": "NPR"}) is None
    assert hero_media([lead, other], lead, {"npr": "NPR", "ghost": "Ghost News"})[1] == "Photo via Ghost News"


def test_likely_video_or_graphic_reads_stated_size_host_and_path_words_only():
    flagged = [
        {"url": "https://www.livemint.com/lm-img/img/2026/09/24/1600x900/maxresdefault_17902_uyPC.jpg", "width": 1600},
        {"url": "https://i.ytimg.com/vi/abc/hq720.jpg"},
        {"url": "https://img.example/a.jpg", "width": 1280, "height": 720},
        {"url": "https://img.example/news/graphics/2026/map.png", "width": 1200, "height": 800},
        {"url": "https://video.example.com/still.jpg"},
    ]
    clean = [
        {"url": "https://img.example/a.jpg", "width": 1200, "height": 800},
        {"url": "https://img.example/videographer-portrait.jpg"},
        {"url": "https://img.example/a.jpg?type=video"},
        {"url": "http://i.ytimg.com/vi/abc/hq720.jpg"},
    ]
    assert all(likely_video_or_graphic(i) for i in flagged)
    assert not any(likely_video_or_graphic(i) for i in clean)
