"""U1: summaries on every row (and the "top" setting), the reader opening any cluster
member with full text (lead first, then trust, then length) and its credit line, and
every scroller ending clear of the bottom nav."""
import json
import re

from app.build import READ_HERE, best_member, body_chars, render
from app.dek import ELLIPSIS
from app.frontpage import dek_budget
from tests.test_frontpage import fixture_pool
from tests.test_render import _parse
from tests.test_tokens import STYLE_CSS

ROOT_JS = "app/static/js"


def _embedded(page):
    raw = re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
    return json.loads(raw.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))


def _pool_with_bodies():
    pool = fixture_pool()
    by_id = {a["id"]: a for a in pool["articles"]}
    # a005's cluster: its lead has no body, two other outlets do.
    for aid in ("a006", "a007"):
        by_id[aid]["has_body"] = True
    # a008's cluster: the lead itself has a body, so it wins whatever else does.
    for aid in ("a008", "a009"):
        by_id[aid]["has_body"] = True
    return pool


def _row(page, sid):
    return re.search(r'<li class="story[^"]*" data-sid="%s">.*?</li>' % re.escape(sid), page, re.S).group(0)


def test_rows_carry_a_fitted_two_line_dek():
    long = ("The council voted seven to two after a long hearing on the transit budget. "
            "Opponents said fares would rise. A final vote is due next month.")
    pool = fixture_pool()
    for article in pool["articles"]:
        article["dek"] = long
    parsed = _parse(render(pool))
    rows = [(d, t) for d, t in zip(parsed.deks, parsed.tiers) if t in ("river", "text-only")]
    assert rows and all(d for d, _ in rows)
    for dek, tier in rows:
        assert len(dek) <= dek_budget(tier.replace("-", "_")) == 64
        assert dek.endswith(".") or dek.endswith(ELLIPSIS)
        assert "Opponents" not in dek  # two lines hold the first sentence only


def test_top_setting_hides_row_deks_before_first_paint():
    gate = open(f"{ROOT_JS}/rank-gate.js", encoding="utf-8").read()
    assert 'p.display.summaries === "top"' in gate and 'classList.add("summaries-top")' in gate
    # The class is set before the early return, so it applies with the default ranking too.
    assert gate.index("summaries-top") < gate.index("if (sameProfile && !hasHistory) return;")
    css = STYLE_CSS
    rule = re.search(r"\.summaries-top \.story--river \.dek,\s*\.summaries-top \.story--text-only \.dek \{([^}]*)\}", css)
    assert rule and "display: none" in rule.group(1)
    # The lead blocks and hero keep theirs: no rule hides them.
    assert not re.search(r"\.summaries-top [^{]*\.story--(hero|secondary) \.dek", css)


def test_display_summaries_in_schema_and_default_profile():
    schema = json.load(open("app/static/profile.schema.json", encoding="utf-8"))
    display = schema["properties"]["display"]
    assert display["properties"]["summaries"]["enum"] == ["all", "top"]  # U2 landed the field; U1 reads it
    assert display["additionalProperties"] is False
    assert "display" not in schema["required"]  # optional: older stored profiles stay valid
    default = open(f"{ROOT_JS}/profile/default-profile.js", encoding="utf-8").read()
    assert 'STARTER_DISPLAY = Object.freeze({ summaries: "all" })' in default


def test_best_member_lead_then_trust_then_length():
    cands = [["a1", "npr", 900, "https://x/1"], ["a2", "axios", 3000, "https://x/2"], ["a3", "bbc", 5000, "https://x/3"]]
    assert best_member(cands, "a1") == "a1"  # the lead has a body: it wins
    assert best_member(cands, "a9") == "a3"  # no trust set: the longest body
    assert best_member(cands, "a9", {"axios": 1.6}) == "a2"  # trusted outlet beats length
    assert best_member(cands, "a9", {"bbc": 0.5}) == "a2"
    tie = [["b2", "s", 100, "u"], ["b1", "t", 100, "u"]]
    assert best_member(tie, "zz") == "b1"  # lowest id breaks a full tie
    assert best_member([], "a1") is None


def test_any_member_with_full_text_opens_the_reader(tmp_path):
    pool = _pool_with_bodies()
    lead = next(c["lead"] for c in _embedded(render(pool))["pool"]["clusters"] if c["id"] == "a008")
    other = ({"a008", "a009"} - {lead}).pop()
    chars = {"a006": 1200, "a007": 4800, lead: 100, other: 9000}
    page = render(pool, chars=chars)
    # a005's lead has no body: the longest member opens, and the row says so.
    row = _row(page, "a005")
    assert 'data-body="a007"' in row and READ_HERE in row
    # a008's lead has a body: the lead opens even though the other body is longer.
    assert f'data-body="{lead}"' in _row(page, "a008")
    # A story with no full text anywhere links out and carries no mark.
    plain = _row(page, "a000")
    assert "data-body" not in plain and READ_HERE not in plain
    data = _embedded(page)
    assert [c[0] for c in data["bodies"]["a005"]] == ["a006", "a007"]
    assert data["bodies"]["a005"][1][2] == 4800 and data["bodies"]["a005"][1][3].startswith("https://")
    assert "a000" not in data["bodies"]


def test_body_chars_reads_the_run_bodies(tmp_path):
    (tmp_path / "x1.json").write_text(json.dumps({"article_id": "x1", "body_html": "<p>One  two</p><p>three</p>"}), encoding="utf-8")
    (tmp_path / "bad.json").write_text("{", encoding="utf-8")
    assert body_chars(tmp_path) == {"x1": len("One two three")}
    assert body_chars(tmp_path / "missing") == {}


def test_reader_credit_line_and_member_title():
    reader = open(f"{ROOT_JS}/reader.js", encoding="utf-8").read()
    assert 'el("p", "reader-via", facts.credit)' in reader
    assert "smartQuotes(record.title" in reader  # another outlet's own headline
    assert "memberFor(" in reader and "storedTrust()" in reader
    assert re.search(r"\.reader-via \{[^}]*color: var\(--color-meta-tertiary\)", STYLE_CSS)


def test_every_scroller_ends_clear_of_the_bottom_nav():
    css = STYLE_CSS
    end = re.search(r"--scroll-end: calc\(([^;]*)\);", css).group(1)
    assert "var(--chrome-bottom-nav)" in end and "env(safe-area-inset-bottom)" in end and "24px" in end
    nav = re.search(r"\n\.bottom-nav \{([^}]*)\}", css).group(1)
    assert "position: fixed" in nav and "bottom: 0" in nav and "env(safe-area-inset-bottom)" in nav
    panel = re.search(r"\n\.panel \{([^}]*)\}", css).group(1)
    view = re.search(r"\n\.view \{([^}]*)\}", css).group(1)
    assert "padding-bottom: var(--scroll-end)" in panel
    assert "var(--scroll-end)" in view
    app = re.search(r"\n\.app \{([^}]*)\}", css).group(1)
    assert "height: 100dvh" in app
    page = render(fixture_pool())
    assert "viewport-fit=cover" in page

