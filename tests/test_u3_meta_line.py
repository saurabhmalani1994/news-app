"""U3: the meta line. Every source has its home country (sources.json `country`, ISO
3166-1 alpha-2) and the pool carries it in B3's contract field; an outlet outside the US
left-right scale shows that code as its marker, in rows, the other-side line and the
catalog; and the meta is two lines whose split is fixed by content, never by width, with
the source name always written in full. The rendered widths are checked in the browser
(tests/browser/u3_check.mjs)."""
import copy
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from app import build
from app.build import render
from app.lean import LEAN_SCALE, hit_html, marker_html
from app.source_catalog import catalog
from contract.validate import validate
from fetcher.fanout import _pool_source
from tests.test_frontpage import SOURCES as FIXTURE_IDS, fixture_pool
from tests.test_lean_marker import _source_of
from tests.test_u1_summaries_reader import _pool_with_bodies, _row

ROOT = Path(__file__).resolve().parent.parent
REPO_SOURCES = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))["sources"]
GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "golden_pool.json").read_text(encoding="utf-8"))

# ISO 3166-1 alpha-2, the officially assigned codes (249).
ISO_3166_ALPHA2 = frozenset("""
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ
BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM
DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS
GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ
MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV
SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
VN VU WF WS YE YT ZA ZM ZW
""".split())

# The fixture's twelve synthetic outlets stand in for real ones, long names and non-us
# outlets among them, so leans and countries come from sources.json itself.
REAL = ["business_times_sg", "the_conversation", "washington_examiner", "wsj_world", "independent_sg",
        "dawn_pk", "npr", "al_jazeera", "wapo_politics", "economist_finance", "kyodo_news", "bbc_world"]
BY_ID = {s["id"]: s for s in REPO_SOURCES}


def _real_pool(pool=None):
    pool = copy.deepcopy(pool or fixture_pool())
    swap = dict(zip(FIXTURE_IDS, REAL))
    for article in pool["articles"]:
        article["source_id"] = swap[article["source_id"]]
    pool["sources"] = [{"id": sid, "name": BY_ID[sid]["name"], "feed_url": BY_ID[sid]["feed_url"]} for sid in REAL]
    return pool


def _rows(page):
    return {sid: _row(page, sid) for sid in re.findall(r'<li class="story[^"]*" data-sid="([^"]+)">', page)}


def test_the_iso_list_is_the_full_assigned_set():
    assert len(ISO_3166_ALPHA2) == 249


def test_every_source_has_a_valid_home_country():
    assert len(REPO_SOURCES) == 108  # B4 added the eleven section 3 feeds
    for s in REPO_SOURCES:
        assert s.get("country") in ISO_3166_ALPHA2, (s["id"], s.get("country"))


def test_the_pool_carries_each_sources_country_in_the_b3_field_and_still_validates():
    assert _pool_source(BY_ID["dawn_pk"]) == {"id": "dawn_pk", "name": "Dawn", "feed_url": BY_ID["dawn_pk"]["feed_url"],
                                              "country": "PK", "roster": "core", "paywall": False}
    for bad in ("pk", "PAK", "", None):
        assert "country" not in _pool_source({**BY_ID["dawn_pk"], "country": bad})
    pool = copy.deepcopy(GOLDEN)
    pool["sources"] = [{**s, "country": "US"} for s in pool["sources"]]
    assert validate(pool) == []
    pool["sources"][0]["country"] = "usa"
    assert validate(pool), "the contract still refuses a code of the wrong shape"


def test_a_non_us_row_shows_its_country_code_and_a_tap_target_named_for_it():
    page = render(_real_pool())
    seen = {}
    for sid, row in _rows(page).items():
        source = _source_of(page, sid)
        lean, country = BY_ID[source]["lean"], BY_ID[source]["country"]
        marker = marker_html(lean, country)
        assert marker, source
        assert re.search(r'<span class="meta-source">[^<]*</span>' + re.escape(marker), row), sid
        assert hit_html(source, lean, country) in row
        seen[lean if lean in LEAN_SCALE or lean == "state" else "country"] = True
    assert set(seen) >= {"center", "right", "state", "country"}, seen
    assert '<span class="lean-code">PK</span>' in page and '<span class="lean-code">SG</span>' in page
    data = json.loads(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)
                      .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    assert data["countries"] == {sid: BY_ID[sid]["country"] for sid in sorted(REAL)}


def test_the_source_name_is_written_in_full_and_the_split_follows_content_only():
    page = render(_real_pool(_pool_with_bodies()))
    rows = _rows(page)
    assert rows
    lines2 = 0
    for sid, row in rows.items():
        source = _source_of(page, sid)
        meta = re.search(r'<span class="meta"><span class="meta-line">(.*?)</span>'
                         r'<span class="meta-line meta-line--2"([^>]*)>(.*?)</span></span></span></a>', row)
        line1, attrs, line2 = meta.group(1, 2, 3)
        name = re.search(r'<span class="meta-source">([^<]*)</span>', line1).group(1)
        assert name == BY_ID[source]["name"].replace("&", "&amp;"), (sid, name)
        # Line 1: who and when. The age is on it, and line 2 carries it as data-age.
        age = re.search(r'<span class="meta-age">([^<]*)</span>', line1).group(1)
        assert attrs == f' data-age="{age}"'
        # Line 2: what the row offers, and only that; empty when there is nothing.
        multi = 'class="meta-count"' in line2
        read = 'class="meta-read"' in line2
        assert bool(line2) == (multi or read), sid
        assert "meta-source" not in line2 and "meta-age" not in line2 and "lean" not in line2
        lines2 += bool(line2)
    assert 0 < lines2 < len(rows)


def test_line_two_leads_with_the_count_then_read_here_then_the_other_outlet():
    pool = _real_pool(_pool_with_bodies())
    next(a for a in pool["articles"] if a["id"] == "a007")["has_body"] = False
    row = _row(render(pool), "a005")
    sep = '<span class="meta-sep"> · </span>'
    assert (sep + '<span class="meta-count">3 sources</span>' + sep
            + '<span class="meta-read"><span class="meta-read-label">Read here</span></span>'
            + '<span class="meta-read-source">NPR</span></span>') in row


def test_the_other_side_line_uses_the_row_marker_never_the_lean_in_words():
    record = {"article_id": "x1", "source_id": "dawn_pk", "lean": "non-us"}
    links = {"x1": ["https://example.org/x1", "A title"]}
    html = build._other_side(record, links, {"dawn_pk": "Dawn"}, {"dawn_pk": "non-us"}, {"dawn_pk": "PK"})
    assert '<span class="other-side-source">Dawn</span>' + marker_html("non-us", "PK") in html
    assert "non-us" not in html.split("</a>")[0].replace("lean--country", "")
    assert html.endswith(hit_html("dawn_pk", "non-us", "PK", "lean-hit--other"))
    assert "lean-hit--other" in html.split("</a>", 1)[1], "the target is the link's sibling, never inside it"


def test_the_catalog_carries_every_sources_country():
    pool = {"generated_at": "2026-09-24T00:00:00Z",
            "sources": [{"id": s["id"], "name": s["name"]} for s in REPO_SOURCES]}
    rows = catalog(pool)["sources"]
    assert {r["id"]: r["country"] for r in rows} == {s["id"]: s["country"] for s in REPO_SOURCES}
    assert set(catalog(pool)["lean_basis"]) == {s["id"] for s in REPO_SOURCES}, "every source has a marker"


NODE_OTHER = """
import { placeOtherSide } from "./app/static/js/tiers.js";
class N {
  constructor(tag) { this.tag = tag; this.attrs = []; this.kids = []; this.className = ""; this.text = ""; this.dataset = {}; }
  setAttribute(k, v) { this.attrs.push([k, String(v)]); }
  append(...n) { this.kids.push(...n); }
  set textContent(v) { this.text = String(v); }
  querySelector() { return null; }
  html() {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const text = this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const data = Object.entries(this.dataset).map(([k, v]) => ["data-" + k, v]);
    const attrs = (this.className ? [["class", this.className]] : []).concat(data, this.attrs);
    return "<" + this.tag + attrs.map(([k, v]) => " " + k + '="' + esc(v) + '"').join("") + ">"
      + text + this.kids.map((k) => k.html()).join("") + "</" + this.tag + ">";
  }
}
globalThis.document = { createElement: (t) => new N(t) };
const out = [];
for (const [sid, lean, country] of [["dawn_pk", "non-us", "PK"], ["fox_politics", "right", "US"], ["al_jazeera", "state", "QA"], ["x", "", ""]]) {
  const li = new N("li");
  placeOtherSide(li, { article_id: "x1", source_id: sid, lean }, {
    links: { x1: ["https://example.org/x1", "A <b>title</b>"] }, names: { [sid]: "Name & Co" }, countries: { [sid]: country } });
  out.push([sid, lean, country, li.kids.map((k) => k.html()).join("")]);
}
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node, as the ranker does")
def test_the_device_draws_the_other_side_line_byte_for_byte_as_the_build_does():
    done = subprocess.run([shutil.which("node"), "--input-type=module", "-e", NODE_OTHER], cwd=ROOT,
                          capture_output=True, text=True, check=True, encoding="utf-8")
    links = {"x1": ["https://example.org/x1", "A <b>title</b>"]}
    for sid, lean, country, device in json.loads(done.stdout):
        record = {"article_id": "x1", "source_id": sid, "lean": lean}
        built = build._other_side(record, links, {sid: "Name & Co"}, {sid: lean}, {sid: country})
        assert built == device, sid
