"""S32: event detection across runs (R22, R16). No network: feeds are fixture bytes
and each run's previous pool is the last run's own output, serialized and read back
through fetcher.events.parse_previous_events, the same path main() uses."""
import copy
import json
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

import jsonschema

from contract.validate import load_schema, validate
from fetcher import events as ev
from fetcher.fanout import build_pool_fanout, fetch_all
from fetcher.fetch import dumps

ROOT = Path(__file__).resolve().parents[1]
JS = jsonschema.Draft202012Validator(load_schema())
T0 = datetime(2026, 9, 24, 4, 0, 0, tzinfo=timezone.utc)

SOURCES = [
    {"id": sid, "name": name, "feed_url": f"https://{sid}.example/feed.xml", "bucket": "general",
     "lean": lean, "lean_basis": "test fixture", "syndication_group": sid}
    for sid, name, lean in (("lft", "Lefty Daily", "left"), ("rgt", "Righty Post", "right"),
                            ("ctr", "Middle Wire", "center"))
]

IRAN_TALKS = "Talks with Iran resume in Geneva as envoys meet"
IRAN_SPEECH = "President of Iran gives defiant wartime speech to parliament"
SUDAN_TALKS = "Ceasefire talks for Sudan open in Jeddah with mediators"
SUDAN_ARMY = "Army in Sudan retakes Khartoum airport from militia"
SUDAN_FAMINE = "Famine in Sudan spreads to Darfur camps as aid runs short"


def _feed(sid, stories):
    items = "".join(
        f"<item><title>{title}</title>"
        f"<link>https://{sid}.example/{zlib.crc32(title.encode())}-{int(when.timestamp())}</link>"
        f"<pubDate>{format_datetime(when)}</pubDate></item>"
        for title, when in stories
    )
    return f'<rss version="2.0"><channel>{items}</channel></rss>'.encode("utf-8")


def _run(now, stories, previous_pool=None, sources=SOURCES):
    """One fanout run. stories: [(title, published_at)] carried by every source.
    Returns the pool, already checked by both validators."""
    feeds = {s["feed_url"]: _feed(s["id"], stories) for s in sources}
    results = fetch_all(sources, fetch_fn=lambda url, timeout=None: feeds[url], timeout=1, retries=0)
    prev_bytes = dumps(previous_pool).encode("utf-8") if previous_pool is not None else None
    previous, _ = ev.parse_previous_events(prev_bytes)
    pool = build_pool_fanout(sources, results, now, previous_events=previous)
    JS.validate(pool)
    assert validate(pool) == []
    return pool


def _by_label(pool, label):
    matches = [e for e in pool["events"] if e["label"] == label]
    assert len(matches) == 1, [e["label"] for e in pool["events"]]
    return matches[0]


def _cluster_titles(pool, cluster_ids):
    arts = {a["id"]: a for a in pool["articles"]}
    cls = {c["id"]: c for c in pool["clusters"]}
    return {arts[cls[c]["article_ids"][0]]["title"] for c in cluster_ids}


IRAN = [(IRAN_TALKS, T0 - timedelta(hours=1)), (IRAN_SPEECH, T0 - timedelta(hours=1))]
SUDAN = [(t, T0 + timedelta(hours=1)) for t in (SUDAN_TALKS, SUDAN_ARMY, SUDAN_FAMINE)]


def test_two_clusters_sharing_an_entity_form_one_event_and_an_unrelated_cluster_does_not_join():
    pool = _run(T0, IRAN + [(SUDAN_TALKS, T0 - timedelta(hours=1))])
    assert len(pool["clusters"]) == 3
    assert len(pool["events"]) == 1
    iran = pool["events"][0]
    assert iran["label"] == "Iran" and iran["id"] == "e_iran"
    assert _cluster_titles(pool, iran["cluster_ids"]) == {IRAN_TALKS, IRAN_SPEECH}
    # hype: 2 clusters in the last 24h times 3 independent outlets.
    assert iran["hype"] == 6 and iran["eligible"] is True
    assert iran["live"] is True and iran["hold_state"] == "none"
    assert iran["live_since"] == "2026-09-24T04:00:00Z"
    sudan_cluster = [c["id"] for c in pool["clusters"] if c["id"] not in iran["cluster_ids"]]
    assert _cluster_titles(pool, sudan_cluster) == {SUDAN_TALKS}


def test_an_incumbent_that_stops_topping_the_field_holds_through_the_floor_then_releases():
    run1 = _run(T0, IRAN)
    assert _by_label(run1, "Iran")["live"] is True

    # A bigger challenger arrives: Sudan, 3 clusters x 3 outlets = 9 against Iran's 6.
    run2 = _run(T0 + timedelta(hours=2), IRAN + SUDAN, run1)
    iran, sudan = _by_label(run2, "Iran"), _by_label(run2, "Sudan")
    assert (sudan["hype"], iran["hype"]) == (9, 6) and sudan["eligible"]
    assert iran["live"] is True and iran["hold_state"] == "holding"
    assert iran["live_since"] == "2026-09-24T04:00:00Z"
    assert sudan["live"] is False and sudan["hold_state"] == "none"

    run3 = _run(T0 + timedelta(hours=11, minutes=59), IRAN + SUDAN, run2)
    assert _by_label(run3, "Iran")["hold_state"] == "holding"
    assert _by_label(run3, "Iran")["live"] is True and _by_label(run3, "Sudan")["live"] is False

    # Past the 12h floor: released for this one run, and the challenger takes the slot.
    run4 = _run(T0 + timedelta(hours=12, minutes=30), IRAN + SUDAN, run3)
    iran, sudan = _by_label(run4, "Iran"), _by_label(run4, "Sudan")
    assert iran["live"] is False and iran["hold_state"] == "released" and "live_since" not in iran
    assert sudan["live"] is True and sudan["hold_state"] == "none"
    assert sudan["live_since"] == "2026-09-24T16:30:00Z"
    assert sum(e["live"] for e in run4["events"]) == 1

    run5 = _run(T0 + timedelta(hours=13), IRAN + SUDAN, run4)
    iran = _by_label(run5, "Iran")
    assert iran["live"] is False and iran["hold_state"] == "none"
    assert _by_label(run5, "Sudan")["live_since"] == "2026-09-24T16:30:00Z"


def test_an_incumbent_whose_hype_ages_out_of_24h_holds_then_releases():
    old = [(t, T0 - timedelta(hours=20)) for t, _ in IRAN]
    run1 = _run(T0, old)
    assert _by_label(run1, "Iran")["live"] is True and _by_label(run1, "Iran")["hype"] == 6
    run2 = _run(T0 + timedelta(hours=5), old, run1)
    iran = _by_label(run2, "Iran")
    assert iran["hype"] == 0 and iran["live"] is True and iran["hold_state"] == "holding"
    run3 = _run(T0 + timedelta(hours=12), old, run2)
    assert _by_label(run3, "Iran")["hold_state"] == "released"
    assert not any(e["live"] for e in run3["events"])


def test_losing_eligibility_releases_at_once_inside_the_floor():
    run1 = _run(T0, IRAN)
    one_lean = [dict(s, lean="left") for s in SOURCES]
    run2 = _run(T0 + timedelta(hours=1), IRAN, run1, sources=one_lean)
    iran = _by_label(run2, "Iran")
    assert iran["eligible"] is False and iran["live"] is False and iran["hold_state"] == "released"


def test_a_stable_id_survives_a_run_where_its_cluster_ids_change():
    run1 = _run(T0, IRAN)
    iran1 = _by_label(run1, "Iran")
    # An earlier copy of the Geneva story turns up, so that cluster's id (its earliest
    # member's) changes; the event keeps its id and its live_since.
    earlier = [(IRAN_TALKS + " again", T0 - timedelta(hours=3))]
    run2 = _run(T0 + timedelta(hours=1), IRAN + earlier, run1)
    iran2 = _by_label(run2, "Iran")
    assert set(iran2["cluster_ids"]) != set(iran1["cluster_ids"])
    assert iran2["id"] == iran1["id"]
    assert iran2["live"] is True and iran2["live_since"] == iran1["live_since"]


def test_the_id_follows_shared_articles_not_the_entity_name():
    run1 = _run(T0, IRAN)
    renamed = copy.deepcopy(run1)
    _by_label(renamed, "Iran")["id"] = "e_standoff"
    assert validate(renamed) == []
    run2 = _run(T0 + timedelta(hours=1), IRAN + SUDAN, renamed)
    iran = _by_label(run2, "Iran")
    assert iran["id"] == "e_standoff"
    assert iran["hold_state"] == "holding" and iran["live_since"] == "2026-09-24T04:00:00Z"


def test_a_dissolved_incumbent_frees_the_slot_the_same_run():
    run1 = _run(T0, IRAN)
    run2 = _run(T0 + timedelta(hours=2), SUDAN, run1)
    assert [e["label"] for e in run2["events"]] == ["Sudan"]
    sudan = run2["events"][0]
    assert sudan["live"] is True and sudan["live_since"] == "2026-09-24T06:00:00Z"


def test_previous_pool_missing_or_old_schema_starts_cleanly():
    golden = json.loads((ROOT / "tests/fixtures/golden_pool_events.json").read_text(encoding="utf-8"))
    pre_s31 = {k: v for k, v in golden.items() if k != "events"}
    assert ev.parse_previous_events(None) == (None, "absent")
    assert ev.parse_previous_events(b"") == (None, "absent")
    assert ev.parse_previous_events(b"{not json") == (None, "old_schema")
    assert ev.parse_previous_events(json.dumps(pre_s31).encode()) == (None, "old_schema")
    assert ev.parse_previous_events(json.dumps([1, 2]).encode()) == (None, "old_schema")
    state, status = ev.parse_previous_events(json.dumps(golden).encode())
    assert status == "ok" and state["events"][0]["live_since"] is None

    clean = _run(T0, IRAN)
    from_old = _run(T0, IRAN, pre_s31)
    assert from_old["events"] == clean["events"]
    iran = _by_label(from_old, "Iran")
    assert iran["live"] is True and iran["hold_state"] == "none"


def test_labels_are_plain_text_from_the_shared_entity():
    pool = _run(T0, IRAN + SUDAN)
    assert sorted(e["label"] for e in pool["events"]) == ["Iran", "Sudan"]
    for e in pool["events"]:
        assert "<" not in e["label"] and "&" not in e["label"]
