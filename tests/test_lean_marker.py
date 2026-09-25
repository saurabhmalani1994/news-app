"""L1: the lean marker's build-time markup (app/lean.py), the same bytes as the device's
renderer (js/lean.js, checked under Node), its place in each story row with its tap
target beside the row's link, the catalog's lean_basis map, and R43's "Read here" that
names the outlet whose full text opens when it is not the row's own."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from app.build import READ_HERE, render
from app.lean import LEAN_SCALE, hit_html, marker_html
from app.source_catalog import catalog
from tests.test_frontpage import fixture_pool
from tests.test_u1_summaries_reader import _embedded, _pool_with_bodies, _row

ROOT = Path(__file__).resolve().parent.parent
SOURCES = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))["sources"]
# The fixture pool's synthetic outlets, one per bucket, then state, non-us and none.
FIXTURE_LEANS = {"s00": "left", "s01": "center-left", "s02": "center", "s03": "center-right", "s04": "right",
                 "s05": "state", "s06": "non-us"}


def test_marker_for_each_bucket_state_and_none():
    for lean in LEAN_SCALE:
        html = marker_html(lean)
        assert html == f'<span class="lean lean--{lean}" aria-hidden="true">' + "<i></i>" * 5 + "</span>"
        assert marker_html(lean, "US") == html, "a US-scale source shows its dots, never its country"
    assert marker_html("state") == '<span class="lean lean--state" aria-hidden="true"><span class="lean-state">State</span></span>'
    assert marker_html("state", "QA") == marker_html("state")
    for lean in ("non-us", None, "", "far-left", 7):
        assert marker_html(lean) == ""
        assert hit_html("npr", lean) == ""
    # U3: outside the US scale, the home country's code is the marker; a bad code is none.
    assert marker_html("non-us", "PK") == ('<span class="lean lean--country" aria-hidden="true">'
                                           '<span class="lean-code">PK</span></span>')
    assert 'aria-label="Country: PK"' in hit_html("dawn_pk", "non-us", "PK")
    for bad in ("pk", "PAK", "P", "", None, 7, "<b"):
        assert marker_html("non-us", bad) == "" and hit_html("dawn_pk", "non-us", bad) == ""


def test_hit_target_names_the_lean_and_escapes_the_source_id():
    assert hit_html("npr", "center-left") == ('<button class="lean-hit" type="button" data-lean-source="npr" '
                                              'aria-haspopup="dialog" aria-label="Lean: center-left"></button>')
    assert 'data-lean-source="a&quot;b&lt;c"' in hit_html('a"b<c', "right")
    assert hit_html("", "right") == "" and hit_html(None, "right") == ""


NODE_RENDER = """
import { leanMarker, leanHit } from "./app/static/js/lean.js";
class N {
  constructor(tag) { this.tag = tag; this.attrs = []; this.kids = []; this.className = ""; this.text = ""; }
  setAttribute(k, v) { this.attrs.push([k, String(v)]); }
  append(...n) { this.kids.push(...n); }
  set textContent(v) { this.text = String(v); }
  html() {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const attrs = (this.className ? [["class", this.className]] : []).concat(this.attrs);
    return "<" + this.tag + attrs.map(([k, v]) => " " + k + '="' + esc(v) + '"').join("") + ">"
      + this.text + this.kids.map((k) => k.html()).join("") + "</" + this.tag + ">";
  }
}
const doc = { createElement: (t) => new N(t) };
const out = [];
for (const lean of ["left", "center-left", "center", "center-right", "right", "state", "non-us", ""]) {
  for (const country of [null, "PK", "US", "pk"]) {
    out.push([lean, country, leanMarker(lean, { doc, country })?.html() || "", leanHit("s_1", lean, doc, country)?.html() || "",
      leanHit("s_1", lean, doc, country, "lean-hit--other")?.html() || ""]);
  }
}
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node, as the ranker does")
def test_build_markup_matches_the_device_renderer():
    done = subprocess.run([shutil.which("node"), "--input-type=module", "-e", NODE_RENDER], cwd=ROOT,
                          capture_output=True, text=True, check=True)
    device = json.loads(done.stdout)
    assert len(device) == 32
    for lean, country, marker, hit, other in device:
        assert marker_html(lean, country) == marker, (lean, country)
        assert hit_html("s_1", lean, country) == hit, (lean, country)
        assert hit_html("s_1", lean, country, "lean-hit--other") == other, (lean, country)


def _source_of(page, sid):
    data = _embedded(page)
    lead = next((c["lead"] for c in data["pool"]["clusters"] if c["id"] == sid), sid)
    return next(a["source_id"] for a in data["pool"]["articles"] if a["id"] == lead)


def test_each_row_carries_its_sources_marker_after_the_name_and_a_tap_target_beside_its_link(monkeypatch):
    import app.build as build
    from app.frontpage import pass_input
    monkeypatch.setattr(build, "pass_input", lambda p: {**pass_input(p), "leans": FIXTURE_LEANS})
    pool = fixture_pool()
    page = render(pool)
    sids = re.findall(r'<li class="story[^"]*" data-sid="([^"]+)">', page)
    assert sids
    seen = set()
    for sid in sids:
        row = _row(page, sid)
        lean = FIXTURE_LEANS.get(_source_of(page, sid))
        marker = marker_html(lean)
        if marker:
            seen.add(lean)
            assert re.search(r'<span class="meta-source">[^<]*</span>' + re.escape(marker), row), sid
            link_end = row.index("</a>") if "</a>" in row else row.index("</span></span>")
            hit = row.index('<button class="lean-hit"')
            assert hit > link_end, "the tap target is the link's sibling, never inside it"
            assert row.index('<button class="story-overflow"') > hit
        else:
            assert 'class="lean' not in row, sid
    assert seen == set(LEAN_SCALE) | {"state"}, seen


def test_a_source_without_a_lean_gets_nothing():
    page = render(fixture_pool())  # its synthetic outlets are in no sources.json
    assert 'class="lean' not in page and "lean-hit" not in page


def _pool_other_outlet():
    """U1's fixture with the a005 story's lead (a007, outlet s07) left without a body, so
    the row opens a006's full text, from outlet s06."""
    pool = _pool_with_bodies()
    next(a for a in pool["articles"] if a["id"] == "a007")["has_body"] = False
    return pool


def test_read_here_names_another_outlet_only_when_its_text_opens():
    page = render(_pool_other_outlet())
    row = _row(page, "a005")
    assert _source_of(page, "a005") == "s07"
    assert 'data-body="a006"' in row
    assert ('<span class="meta-read-label">Read here</span></span><span class="meta-read-source">Outlet s06</span></span>'
            in row), "the other outlet is named right after the mark, last on the line"
    # The lead's own text opens: "Read here" alone, the row's source already names it.
    own = _row(render(_pool_with_bodies()), "a005")
    assert 'data-body="a007"' in own and READ_HERE in own and "meta-read-source" not in own


def test_read_here_other_outlet_name_is_escaped_text():
    pool = _pool_other_outlet()
    evil = '<img src=x onerror="alert(1)">'
    next(s for s in pool["sources"] if s["id"] == "s06")["name"] = evil
    page = render(pool)
    assert "<img src=x" not in page
    assert '<span class="meta-read-source">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>' in _row(page, "a005")


def test_catalog_carries_lean_basis_only_for_sources_with_a_marker():
    pool = {"generated_at": "2026-09-24T00:00:00Z",
            "sources": [{"id": "npr", "name": "NPR"}, {"id": "al_jazeera", "name": "Al Jazeera"},
                        {"id": "kyodo_news", "name": "Kyodo News"}, {"id": "not_in_repo", "name": "X"}]}
    data = catalog(pool)
    # U3: a non-us outlet shows its country as its marker, so its sheet has a basis too.
    assert set(data["lean_basis"]) == {"npr", "al_jazeera", "kyodo_news"}
    rows = {r["id"]: r for r in data["sources"]}
    assert rows["kyodo_news"]["country"] == "JP" and "country" not in rows["not_in_repo"]
    assert data["lean_basis"]["npr"].startswith("research/")
    assert all("lean_basis" not in row for row in data["sources"]), "rows keep the picker's compact shape"


def test_every_source_with_a_marker_has_a_basis_to_show():
    for s in SOURCES:
        if marker_html(s.get("lean"), s.get("country")):
            assert isinstance(s.get("lean_basis"), str) and s["lean_basis"].strip(), s["id"]
