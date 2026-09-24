"""The page renders the pool's titles as text (R26). Since S04 the page is tiered and
ordered (app.frontpage), so the S01 title proof compares against the front page order,
and on the quote-folded form: typographic quotes are a display-layer transform
(app.typography), tested on its own in test_frontpage.py."""
import copy
import json
import re
from html.parser import HTMLParser
from pathlib import Path

from app.build import main as build_main, render
from app.frontpage import front_page
from app.typography import fold_quotes, smart_quotes

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))


class _Items(HTMLParser):
    """Collects each story's headline text (items), dek, meta line, link href and tier,
    and every tag seen. Spans nest inside the meta since S04, so depth is tracked."""

    FIELDS = ("headline", "dek", "meta")

    def __init__(self):
        super().__init__()
        self.items, self.deks, self.metas, self.hrefs, self.tags, self.tiers = [], [], [], [], [], []
        self._in, self._depth = None, 0

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "li":
            self.hrefs.append(None)
            self.deks.append(None)
            self.tiers.append(next((c[len("story--"):] for c in classes if c.startswith("story--")), None))
        elif tag == "a" and self.hrefs:
            self.hrefs[-1] = attrs.get("href")
        if self._in:
            if tag == "span":
                self._depth += 1
            return
        for field in self.FIELDS:
            if field in classes:
                self._in, self._depth = field, 1
                if field == "headline":
                    self.items.append("")
                elif field == "dek":
                    self.deks[-1] = ""
                else:
                    self.metas.append("")

    def handle_endtag(self, tag):
        if self._in and tag == "span":
            self._depth -= 1
            if self._depth == 0:
                self._in = None

    def handle_data(self, data):
        if self._in == "headline":
            self.items[-1] += data
        elif self._in == "dek":
            self.deks[-1] += data
        elif self._in == "meta":
            self.metas[-1] += data


def _parse(page):
    p = _Items()
    p.feed(page)
    return p


def _page_order(pool):
    """Lead articles in rendered order: hero, secondary, river, text-only."""
    tiers = front_page(pool)
    return [story.lead for name in ("hero", "secondary", "river", "text_only") for story in tiers[name]]


def _row_of(parsed, title):
    return parsed.items.index(smart_quotes(title))


def test_rendered_titles_equal_fixture_titles_in_order():
    items = _parse(render(GOLDEN)).items
    leads = _page_order(GOLDEN)
    # Exactly the display transform of each title, in front page order...
    assert items == [smart_quotes(a["title"]) for a in leads]
    # ...which, folded, is the pool's own title, byte for byte.
    assert [fold_quotes(t) for t in items] == [fold_quotes(a["title"]) for a in leads]
    # The golden pool has no clusters, so every article renders exactly once.
    assert sorted(fold_quotes(t) for t in items) == sorted(fold_quotes(a["title"]) for a in GOLDEN["articles"])


def test_hostile_title_renders_as_text_only():
    pool = copy.deepcopy(GOLDEN)
    evil = '<script>alert(1)</script><img src=x onerror="alert(2)">'
    pool["articles"][0]["title"] = evil
    parsed = _parse(render(pool))
    rendered = parsed.items[_row_of(parsed, evil)]
    assert rendered == smart_quotes(evil) and fold_quotes(rendered) == evil
    assert parsed.tags.count("script") == 9 and "img" not in parsed.tags  # S11/S18 gates, S27 tabs.js, S25 reader.js, S18 offline+sw, S24 story-actions.js, S14 coverage-view.js, S15 history/observe.js


def test_page_has_no_images_or_scripts():
    # R26 bans feed content from ever becoming a tag or attribute; img, script and
    # iframe are the injection vectors that matter. It does not ban the app's own
    # stylesheet link, added in S03 to apply the design tokens: that CSS carries no
    # feed data and is not user input.
    # S11: the one script is the app's own external head gate (rank-gate.js), which
    # carries no feed data; no other script tag, inline or not, may appear.
    # S18 adds three more of the app's own external scripts: offline-gate.js and
    # offline.js (the offline line) and sw-register.js (the service worker).
    page = render(GOLDEN)
    tags = set(_parse(page).tags)
    assert not tags & {"img", "iframe"}
    assert re.findall(r"<script\b[^>]*>", page) == [
        '<script src="js/offline-gate.js">', '<script src="js/rank-gate.js">',
        '<script type="module" src="js/tabs.js">', '<script type="module" src="js/reader.js">',
        '<script type="module" src="js/story-actions.js">',
        '<script type="module" src="js/coverage-view.js">',
        '<script type="module" src="js/history/observe.js">',
        '<script src="js/sw-register.js" defer>', '<script src="js/offline.js">',
    ]  # S11/S18 gates, S27 tabs, S25 reader, S24 story-actions, S14 coverage-view, S15 history, S18 offline+sw


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
    assert _parse(page).items == [smart_quotes(a["title"]) for a in _page_order(GOLDEN)]
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
    metas = [parsed.metas[_row_of(parsed, a["title"])] for a in pool["articles"][:4]]
    assert metas == ["NPR" + dot + "12m ago", "NPR" + dot + "3h ago", "NPR" + dot + "3d ago", "NPR"]


def test_story_link_is_emitted_only_for_http_urls():
    pool = copy.deepcopy(GOLDEN)
    pool["articles"][0]["url"] = "javascript:alert(1)"
    pool["articles"][1]["url"] = "data:text/html,<script>alert(1)</script>"
    pool["articles"][2]["url"] = 'https://example.org/a"onmouseover="alert(1)'
    page = render(pool)
    parsed = _parse(page)
    href = {a["id"]: parsed.hrefs[_row_of(parsed, a["title"])] for a in pool["articles"]}
    assert href[pool["articles"][0]["id"]] is None and href[pool["articles"][1]["id"]] is None
    assert href[pool["articles"][2]["id"]] == pool["articles"][2]["url"]  # quoted, stays one attribute
    assert "javascript:" not in page and "data:text" not in page
    assert 'onmouseover="' not in page
    assert parsed.items == [smart_quotes(a["title"]) for a in _page_order(pool)]


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
