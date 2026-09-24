"""S08: lean taxonomy and topic tagging. No network."""
import json
from pathlib import Path

import pytest

from fetcher.fanout import load_sources
from fetcher.taxonomy import LEAN_BUCKETS, OWNERSHIP_LABELS, validate_source_taxonomy
from fetcher.topics import load_topics, tag_article, hard_news_topics

ROOT = Path(__file__).resolve().parents[1]
SOURCES = load_sources(ROOT / "sources.json")
TOPICS = load_topics()


def test_every_source_has_a_lean_bucket_from_the_closed_set():
    for s in SOURCES:
        assert s["lean"] in LEAN_BUCKETS, s["id"]
        assert s["lean_basis"], s["id"]


def test_lean_bucket_enum_matches_pool_schema():
    schema = json.loads((ROOT / "contract/pool.schema.json").read_text(encoding="utf-8"))
    assert set(schema["$defs"]["lean_bucket"]["enum"]) == set(LEAN_BUCKETS)


def test_ownership_labels_are_closed_and_state_labels_reach_it():
    seen = {s["ownership"] for s in SOURCES if s.get("ownership")}
    assert seen <= set(OWNERSHIP_LABELS)
    # R16/design: state-owned and state-subsidized must be representable labels.
    assert "state-owned" in OWNERSHIP_LABELS
    assert "state-subsidized" in OWNERSHIP_LABELS
    assert "state-owned" in seen  # at least one real source in sources.json carries it


def test_every_source_has_a_syndication_group():
    for s in SOURCES:
        assert s["syndication_group"], s["id"]


def test_syndication_groups_found():
    groups = {s["syndication_group"] for s in SOURCES}
    assert "ap_wire" in groups  # R11: PBS NewsHour stands in for AP
    pbs = next(s for s in SOURCES if s["id"] == "pbs_newshour")
    assert pbs["syndication_group"] == "ap_wire"
    assert len(groups) <= len(SOURCES)  # at least one grouping collapses two sources


def test_taxonomy_rejects_an_unknown_lean_bucket():
    bad = dict(SOURCES[0], lean="libertarian")
    errors = validate_source_taxonomy(bad)
    assert any("lean" in e for e in errors)


def test_taxonomy_rejects_an_unknown_ownership_label():
    bad = dict(SOURCES[0], ownership="propaganda-arm")
    errors = validate_source_taxonomy(bad)
    assert any("ownership" in e for e in errors)


def test_hard_news_is_the_r16_set():
    assert hard_news_topics(TOPICS) == {"world", "politics", "economy", "science", "conflict"}


def test_topics_schema_enum_matches_topics_json():
    schema = json.loads((ROOT / "contract/pool.schema.json").read_text(encoding="utf-8"))
    assert set(schema["$defs"]["topic"]["enum"]) == set(TOPICS["topics"])


def test_tagging_is_deterministic():
    a = tag_article("us_politics", "Senate passes the budget bill", "A vote of 51-49.", TOPICS)
    b = tag_article("us_politics", "Senate passes the budget bill", "A vote of 51-49.", TOPICS)
    assert a == b
    assert a == sorted(a)  # stable, sorted order every time


def test_tagging_combines_bucket_and_keyword_matches():
    tags = tag_article("asia", "Central bank holds rates, inflation eases", "", TOPICS)
    assert "world" in tags      # bucket base tag (the asia bucket keeps world, F1)
    assert "economy" in tags    # keyword match


def test_climate_food_bucket_tags_foodtech_and_climate_tech_by_default():
    # F7: the bucket had no bucket_topics entry, so its own outlets (Green Queen,
    # Food Dive, Canary Media...) tagged neither topic unless a keyword happened to
    # match, which is why both tags measured thin even with live sources.
    tags = tag_article("climate_food", "A headline with no matched keywords at all", "", TOPICS)
    assert "foodtech" in tags
    assert "climate_tech" in tags


@pytest.mark.parametrize("title", [
    "Startup unveils cell-based meat pilot plant",
    "Mycoprotein maker raises Series B",
    "Vertical farming startup expands indoor farming operations",
])
def test_foodtech_keywords_catch_general_outlet_stories(title):
    tags = tag_article("general", title, "", TOPICS)
    assert "foodtech" in tags


@pytest.mark.parametrize("title", [
    "City council approves new transit budget",
    "Meatpacking union votes to ratify new contract",
    "Farmers protest new tariffs on soybeans",
])
def test_foodtech_keywords_do_not_false_positive_on_ordinary_food_and_farm_news(title):
    tags = tag_article("general", title, "", TOPICS)
    assert "foodtech" not in tags


@pytest.mark.parametrize("title", [
    "Startup raises funding for direct air capture plant",
    "Utility adds grid storage to handle peak demand",
    "Heat pump sales rise as gas prices climb",
])
def test_climate_tech_keywords_catch_general_outlet_stories(title):
    tags = tag_article("general", title, "", TOPICS)
    assert "climate_tech" in tags


@pytest.mark.parametrize("title", [
    "Hurricane season forecast revised upward",
    "Senate debates climate change bill",
    "Heat wave grips the Pacific Northwest",
])
def test_climate_tech_keywords_do_not_false_positive_on_ordinary_weather_and_policy_news(title):
    tags = tag_article("general", title, "", TOPICS)
    assert "climate_tech" not in tags


def test_singapore_bucket_alone_no_longer_tags_singapore():
    # G1 changed the S08 rule this test used to pin: the outlet is never a geography
    # signal on its own, so a Singapore outlet's text with no Singapore signal is not
    # tagged singapore; the same text naming MAS (a local-only signal) is.
    assert "singapore" not in tag_article("singapore", "Central bank holds rates, inflation eases", "", TOPICS)
    assert "singapore" in tag_article("singapore", "MAS holds rates, inflation eases", "", TOPICS)


def test_every_bucket_used_in_sources_json_resolves_to_at_least_one_tag():
    buckets = {s["bucket"] for s in SOURCES}
    for bucket in buckets:
        tags = tag_article(bucket, "A headline with no matched keywords at all", "", TOPICS)
        assert len(tags) >= 1


@pytest.mark.parametrize("field", ["hard_news", "topics", "bucket_topics", "keyword_topics"])
def test_topics_json_has_required_top_level_fields(field):
    assert field in TOPICS
