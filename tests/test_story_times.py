"""J22, J29: each card says when its own article was published and when Almanac first
added it, with dates, in the phone's own time zone (js/story-times.js)."""
import re
import shutil
import subprocess
from pathlib import Path

from app.build import TIMES, _marks, _times, jev_marks

ROOT = Path(__file__).resolve().parents[1]


class Story:
    article_ids = ["a", "b"]


def test_the_row_carries_its_own_articles_published_and_added_times():
    by_id = {"a": {"published_at": "2026-09-30T01:40:00Z", "fetched_at": "2026-09-30T02:17:00Z"},
             "b": {"published_at": "2026-09-30T00:10:00Z", "fetched_at": "2026-09-30T01:17:00Z"}}
    html = _times(Story(), by_id["a"], by_id)
    assert html == TIMES.format(written="2026-09-30T01:40:00Z", pulled="2026-09-30T02:17:00Z"), "never another version's"
    assert _times(Story(), {"published_at": "not a time"}, by_id) == ""
    assert 'data-pulled=""' in _times(Story(), {"published_at": "2026-09-30T01:40:00Z"}, by_id), "an old pool has no added time"


def test_the_phone_writes_the_times_in_its_own_zone():
    node = shutil.which("node")
    if node is None:
        return
    script = (ROOT / "app/static/js/story-times.js").read_text()
    harness = """
const lines = [];
const make = (w, p) => { const a = { "data-written": w, "data-pulled": p }; const l = { getAttribute: (k) => a[k], textContent: "", closest: () => null }; lines.push(l); };
const iso = (ms) => new Date(ms).toISOString();
make(iso(Date.now() - 3600e3), iso(Date.now() - 1800e3));
make(iso(Date.now() - 3 * 86400000), "");
make(iso(Date.now() - 3600e3), iso(Date.now() - 7200e3));
globalThis.window = {};
globalThis.document = { querySelectorAll: () => lines };
""" + script + "\nconsole.log(JSON.stringify(lines.map((l) => l.textContent)));"
    out = subprocess.run([node, "-e", harness], capture_output=True, text=True, check=True).stdout
    both, older, backwards = __import__("json").loads(out)
    clock = r"\d{1,2}:\d\d [ap]\.m\."
    stamp = r"[A-Z][a-z]{2} \d{1,2}, " + clock
    # J31: the added time drops its date on the published day.
    assert re.fullmatch(f"Published {stamp} · Added (?:{stamp}|{clock})", both), both
    assert re.fullmatch(f"Published {stamp}", older), "no added time, no added part"
    assert re.fullmatch(f"Published {stamp}", backwards), "an added time before publishing is left out"


def test_a_card_says_what_jev_changed_and_says_nothing_otherwise():
    """J37: an AI tag Jev added and versions Jev joined, in words on the card."""
    by_id = {"a": {"jev": {"tags": ["ai"], "hard": 0.2}}, "b": {"jev": {"joined": True}}}
    assert jev_marks(Story(), by_id["a"], by_id) == ["AI tag by Jev", "Joined by Jev"]
    assert _marks(Story(), by_id["a"], by_id) == '<span class="story-marks">AI tag by Jev \u00b7 Joined by Jev</span>'
    plain = {"a": {"jev": {"hard": 0.9, "same": 0.8}}, "b": {}}
    assert jev_marks(Story(), plain["a"], plain) == [] and _marks(Story(), plain["a"], plain) == ""
    assert jev_marks(Story(), {"jev": {"tags": ["climate_tech"]}}, {}) == ["Climate tech tag by Jev"]
