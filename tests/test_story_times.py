"""J22: each card says when its article was written and when Almanac first pulled the
story, as ISO times the phone writes out in its own time zone (js/story-times.js)."""
import re
import shutil
import subprocess
from pathlib import Path

from app.build import TIMES, _times

ROOT = Path(__file__).resolve().parents[1]


class Story:
    article_ids = ["a", "b"]


def test_the_row_carries_written_and_the_earliest_pulled_time():
    by_id = {"a": {"published_at": "2026-09-30T01:40:00Z", "fetched_at": "2026-09-30T02:17:00Z"},
             "b": {"published_at": "2026-09-30T00:10:00Z", "fetched_at": "2026-09-30T01:17:00Z"}}
    html = _times(Story(), by_id["a"], by_id)
    assert html == TIMES.format(written="2026-09-30T01:40:00Z", pulled="2026-09-30T01:17:00Z")
    assert _times(Story(), {"published_at": "not a time"}, by_id) == ""
    assert 'data-pulled=""' in _times(Story(), by_id["a"], {"a": {}, "b": {}}), "an old pool has no pulled time"


def test_the_phone_writes_the_times_in_its_own_zone():
    node = shutil.which("node")
    if node is None:
        return
    script = (ROOT / "app/static/js/story-times.js").read_text()
    harness = """
const lines = [];
const make = (w, p) => { const a = { "data-written": w, "data-pulled": p }; const l = { getAttribute: (k) => a[k], textContent: "" }; lines.push(l); };
make(new Date().toISOString(), new Date().toISOString());
make(new Date(Date.now() - 3 * 86400000).toISOString(), "");
globalThis.window = {};
globalThis.document = { querySelectorAll: () => lines };
""" + script + "\nconsole.log(JSON.stringify(lines.map((l) => l.textContent)));"
    out = subprocess.run([node, "-e", harness], capture_output=True, text=True, check=True).stdout
    today, older = __import__("json").loads(out)
    assert re.fullmatch(r"Written \d{1,2}:\d\d [ap]\.m\. · Pulled \d{1,2}:\d\d [ap]\.m\.", today)
    assert re.fullmatch(r"Written [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [ap]\.m\.", older), "no pulled time, no pulled part"
