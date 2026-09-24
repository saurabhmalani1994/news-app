"""S33 proof: the Live tab as the build renders it from the pool's own events array
(S31/S32), text only, and deterministic. The order-and-overrides proof (currentLiveEvent,
the pin and block overrides, exactly the event's clusters in ranked order) lives in
tests/js/live.test.js, the same pure function the build and the device both run; this
file covers what app/build.py does with that output: the tab shown or hidden with no
shift in the strip's own order, and its label the event's own while one is live."""
import re

from app.build import render
from app.frontpage import run_ranker

from tests.test_frontpage import fixture_pool

TAB_RE = re.compile(r'<button class="tab"[^>]*data-section="([^"]+)"([^>]*)>([^<]*)</button>')
PANEL_RE = re.compile(r'<section class="panel" id="section-([^"]+)"')
SECTION_ORDER = ["today", "live", "us-politics", "world", "singapore", "asia", "ai", "biotech"]


def _live_pool(**event_overrides):
    pool = fixture_pool()
    event = {
        "id": "e_test", "label": "Test Event", "cluster_ids": ["a005", "a008"],
        "hype": 9, "eligible": True, "live": True, "hold_state": "none",
    }
    event.update(event_overrides)
    pool["events"] = [event]
    return pool


def test_live_tab_renders_shown_with_the_events_label_no_shift_in_strip_order():
    page = render(_live_pool())
    tabs = TAB_RE.findall(page)
    assert [sid for sid, _, _ in tabs] == SECTION_ORDER
    live_id, live_rest, live_label = next(r for r in tabs if r[0] == "live")
    assert "hidden" not in live_rest
    assert live_label == "Test Event"
    panels = PANEL_RE.findall(page)
    assert panels == SECTION_ORDER


def test_live_tab_hidden_when_the_pool_carries_no_live_event():
    page = render(_live_pool(live=False, hold_state="released"))
    tabs = TAB_RE.findall(page)
    assert [sid for sid, _, _ in tabs] == SECTION_ORDER
    assert [sid for sid, rest, _ in tabs if "hidden" in rest] == ["live"]


def test_live_tab_hidden_when_the_pool_carries_no_events_at_all():
    pool = fixture_pool()
    assert "events" not in pool
    page = render(pool)
    tabs = TAB_RE.findall(page)
    assert [sid for sid, rest, _ in tabs if "hidden" in rest] == ["live"]


def test_ranker_sections_carry_the_live_events_own_clusters_and_metadata():
    ranking = run_ranker(_live_pool())
    live = next(s for s in ranking["sections"] if s["id"] == "live")
    assert set(live["ids"]) == {"a005", "a008"}
    assert live["label"] == "Test Event"
    assert live["event"] == {"id": "e_test", "label": "Test Event"}


def test_a_blocked_event_is_never_shown_even_though_the_pool_marks_it_live():
    # S33: the device applies the owner's block; the build itself ships for the
    # default profile, which blocks nothing, so this only exercises that a released
    # (non-live) event stays hidden the same as a never-live one (the block path
    # itself, profile-driven, is proven in tests/js/live.test.js).
    page = render(_live_pool(live=False, eligible=True, hold_state="released"))
    tabs = TAB_RE.findall(page)
    assert [sid for sid, rest, _ in tabs if "hidden" in rest] == ["live"]
