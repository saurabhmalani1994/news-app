"""G1 proof: geography tags come from an article's own text, never its outlet, and the
singapore and asia topic tags follow them. Fixtures only; no network, no clock."""
import json
from pathlib import Path

import pytest

from app.frontpage import rank_input
from fetcher.geo import GeoError, geo_signals, load_geo, tag_geo
from fetcher.topics import load_topics, tag_article

ROOT = Path(__file__).resolve().parent.parent
TOPICS = load_topics()


def tags(bucket, title, dek=""):
    geo = tag_geo(bucket, title, dek)
    return geo, tag_article(bucket, title, dek, TOPICS, geo=geo)


def test_mothership_white_house_ban_is_not_singapore():
    geo, topics = tags("singapore", "US judge orders Trump to lift White House ban against CNN, MS NOW & Politico",
                       "The judge issued the order following a lawsuit filed by the three media outlets.")
    assert geo == ["us"]
    assert "singapore" not in topics and "asia" not in topics


def test_straits_times_hdb_prices_without_the_word_singapore_is_sg():
    geo, topics = tags("singapore", "HDB resale prices rise for 21st straight quarter",
                       "Flats in Queenstown and Bishan led the gains, while million-dollar deals hit a record.")
    assert "Singapore" not in "HDB resale prices rise for 21st straight quarter"
    assert geo == ["asia", "sg", "world"]
    assert "singapore" in topics and "asia" in topics


def test_xi_trump_summit_is_asia_us_and_world():
    geo, topics = tags("general", "Trump and Xi meet at summit as trade truce holds",
                       "The Chinese leader's first White House visit in a decade.")
    assert geo == ["asia", "us", "world"]
    assert {"asia", "world"} <= set(topics)
    assert "singapore" not in topics


@pytest.mark.parametrize("bucket,title", [
    ("general", "Israeli strikes hit Beirut as Iran warns of a wider war"),
    ("singapore", "Saudi civil defence issues brief danger warning for Mecca city"),
    ("asia", "Qatar and the UAE broker a Gaza ceasefire proposal"),
])
def test_middle_east_story_is_world_not_asia(bucket, title):
    geo, topics = tags(bucket, title)
    assert "world" in geo
    assert "asia" not in geo and "sg" not in geo and "asia" not in topics


def test_weak_signal_counts_only_for_a_regional_outlet_and_never_the_bucket_alone():
    title = "MRT disruption on North-South line delays morning commute"
    assert "sg" in tag_geo("singapore", title, "")          # local outlet, local-only signal
    assert "sg" not in tag_geo("general", title, "")        # MRT alone elsewhere: not enough
    assert tag_geo("singapore", "Man wins lawsuit over unpaid loan", "") == []  # bucket alone: nothing
    assert geo_signals("singapore", title, "") == {"sg": "weak:MRT"}


def test_officeholders_towns_and_acronyms_catch_local_stories():
    assert "sg" in tag_geo("general", "Lawrence Wong unveils budget support for seniors", "")
    assert "sg" in tag_geo("general", "Fire breaks out at Tampines flat", "")
    assert "sg" in tag_geo("general", "CPF interest rates unchanged for next quarter", "")
    assert "sg" in tag_geo("general", "Changi Airport posts record passenger traffic", "")


@pytest.mark.parametrize("bucket,title,absent", [
    ("general", "Asian American voters shift in Georgia runoff", "asia"),
    ("general", "Indiana lawmakers pass new tax bill", "asia"),
    ("general", "New Mexico wildfire forces evacuations", "world"),
    ("general", "Savers pour money into IRAs before deadline", "sg"),
    ("singapore", "Diet soda linked to headaches, study finds", "asia"),
    ("asia", "Opposition Congress walks out of Lok Sabha", "us"),
    ("singapore", "Thai teen wins America's Got Talent", "us"),
])
def test_near_misses_do_not_tag(bucket, title, absent):
    assert absent not in tag_geo(bucket, title, "")


def test_passing_mention_deep_in_a_body_length_dek_does_not_count():
    dek = "A district court judge ruled the White House violated the rights of three outlets. " * 5
    dek += "The ruling comes ahead of a meeting with Chinese President Xi Jinping."
    assert "asia" not in tag_geo("general", "White House ordered to restore access to news outlets", dek)
    assert "asia" in tag_geo("general", "White House ordered to restore access to news outlets",
                             "It comes ahead of a meeting with Chinese President Xi Jinping.")


def test_tagging_is_deterministic_and_sorted():
    args = ("singapore", "S'pore man fined S$5,000 over HDB flat dispute in Bukit Batok", "Court heard.")
    first = tag_geo(*args)
    assert all(tag_geo(*args) == first for _ in range(20))
    assert first == sorted(first) == ["asia", "sg", "world"]
    assert load_geo() is load_geo()


def test_topics_follow_geo_exactly():
    for bucket, title in [("singapore", "Qualcomm and Apple extend a licensing deal"),
                          ("asia", "Seoul stocks rally on chip rebound"),
                          ("general", "Tharman opens the new Punggol hospital"),
                          ("singapore", "Jakarta floods displace thousands")]:
        geo, topics = tags(bucket, title)
        assert ("sg" in geo) == ("singapore" in topics), title
        assert ("asia" in geo) == ("asia" in topics), title


def test_geo_json_contract():
    doc = json.loads((ROOT / "geo.json").read_text(encoding="utf-8"))
    schema = json.loads((ROOT / "contract/pool.schema.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["article"]["properties"]["geo"]["items"]["enum"] == sorted(doc["geo_tags"])
    topics = json.loads((ROOT / "topics.json").read_text(encoding="utf-8"))
    assert {k for k in topics["geo_topics"] if k != "note"} <= set(doc["geo_tags"])
    for bucket_tags in topics["bucket_topics"].values():
        assert "singapore" not in bucket_tags and "asia" not in bucket_tags


def test_bad_geo_json_is_refused(tmp_path):
    bad = json.loads((ROOT / "geo.json").read_text(encoding="utf-8"))
    bad["implies"]["sg"] = ["europe"]
    path = tmp_path / "geo.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(GeoError):
        load_geo(path)


def test_rank_input_carries_geo_for_build_and_device():
    pool = {"articles": [{"id": "a1", "source_id": "mothership", "title": "t", "published_at": "2026-09-24T00:00:00Z",
                          "topics": ["world"], "geo": ["us"], "dek": "not ranked"}], "clusters": []}
    assert rank_input(pool)["articles"] == [{"id": "a1", "source_id": "mothership", "title": "t",
                                             "published_at": "2026-09-24T00:00:00Z", "topics": ["world"], "geo": ["us"]}]
