"""Review fixes (F1): us_politics tag, signal-based world tag, stronger event
labels. Fixtures prove each fix in isolation; no network, no clock beyond the
fixed `now` values below."""
from datetime import datetime, timezone

from fetcher import events as ev
from fetcher.events import build_events, group_clusters
from fetcher.topics import load_topics, tag_article

TOPICS = load_topics()
NOW = datetime(2026, 9, 24, 5, 0, 0, tzinfo=timezone.utc)

SOURCES = [
    {"id": "a", "name": "Outlet A", "lean": "left", "syndication_group": "a"},
    {"id": "b", "name": "Outlet B", "lean": "right", "syndication_group": "b"},
]
SOURCE_NAMES = [s["name"] for s in SOURCES]


def _article(aid, sid, title, dek=""):
    return {"id": aid, "source_id": sid, "title": title, "dek": dek,
            "published_at": "2026-09-24T04:00:00Z", "topics": ["world"]}


# ---------------------------------------------------------------------------
# 1. us_politics tag (problem 1)
# ---------------------------------------------------------------------------

def test_uk_politics_story_gets_politics_but_not_us_politics():
    tags = tag_article("general", "UK election: Labour wins by-election in Manchester", "", TOPICS)
    assert "politics" in tags
    assert "us_politics" not in tags


def test_senate_vote_story_gets_both_politics_and_us_politics():
    tags = tag_article("us_politics", "Senate passes budget bill in narrow vote",
                        "The 51-49 tally sends it to the House", TOPICS)
    assert "politics" in tags
    assert "us_politics" in tags


def test_state_election_signal_adds_us_politics_from_a_general_source():
    # A general-bucket outlet (not the us_politics bucket) covering a state race:
    # the compound state-name + election-context signal should still fire.
    tags = tag_article("general", "Ohio governor's race tightens as early voting begins", "", TOPICS)
    assert "us_politics" in tags
    assert "politics" in tags


# ---------------------------------------------------------------------------
# 2. world tag only on international signals (problem 2)
# ---------------------------------------------------------------------------

def test_us_domestic_crime_story_from_general_source_does_not_get_world():
    tags = tag_article(
        "general",
        "Former lawmaker sentenced to prison after bribery and fraud conviction, prosecutors say",
        "", TOPICS)
    assert "world" not in tags


def test_general_bucket_story_naming_a_foreign_country_gets_world():
    tags = tag_article("general", "China unveils new export controls on rare earth metals", "", TOPICS)
    assert "world" in tags


def test_asia_bucket_still_carries_world_unchanged():
    # Non-US source buckets keep their existing bucket-level world tag (S08).
    tags = tag_article("asia", "Factory output rises across the region", "", TOPICS)
    assert "world" in tags and "asia" in tags


# ---------------------------------------------------------------------------
# 3. event labels (problem 3)
# ---------------------------------------------------------------------------

def test_event_label_prefers_un_general_assembly_over_bare_un():
    articles = [
        _article("a1", "a", "UN warns of rising tensions in the region"),
        _article("a2", "b", "UN calls emergency meeting after latest strikes"),
        _article("a3", "a", "UN General Assembly opens amid global tensions"),
        _article("a4", "b", "Debate at UN General Assembly turns tense over resolution"),
        _article("a5", "a", "UN urges restraint as talks continue"),
        _article("a6", "b", "UN peacekeepers deployed to buffer zone"),
    ]
    clusters = [
        {"id": "c1", "article_ids": ["a1", "a2", "a3", "a4"]},
        {"id": "c2", "article_ids": ["a5", "a6"]},
    ]
    assert group_clusters(clusters, articles, SOURCE_NAMES) == [("un", ["c1", "c2"])]
    events = build_events(articles, clusters, SOURCES, NOW, frozenset({"world"}))
    assert len(events) == 1
    assert events[0]["label"] == "UN General Assembly"
    assert events[0]["id"] == "e_un"  # id still keys off the raw entity, not the label


def test_chinese_demonym_maps_to_china():
    articles = [
        _article("a1", "a", "Trade talks with Chinese officials resume in Geneva"),
        _article("a2", "b", "New tariffs hit Chinese exporters hard"),
        _article("a3", "a", "Envoys meet Chinese counterparts in Geneva talks"),
        _article("a4", "b", "Markets react as Chinese policy shifts emerge"),
    ]
    clusters = [
        {"id": "c1", "article_ids": ["a1", "a2"]},
        {"id": "c2", "article_ids": ["a3", "a4"]},
    ]
    events = build_events(articles, clusters, SOURCES, NOW, frozenset({"world"}))
    assert len(events) == 1
    assert events[0]["label"] == "China"


def test_ambiguous_two_letter_token_is_dropped_for_a_better_phrase():
    # "MS" is not a known acronym (unlike "UN"/"US"/"UK"/"EU"/"AI"); with the
    # fuller phrase "MS Society" available (itself never split apart, since the
    # two-letter check only vetoes a token standing alone), the label should
    # prefer it over bare "MS".
    article_list = [
        {"id": "a1", "source_id": "a", "title": "MS Society funds new research into treatment", "dek": ""},
        {"id": "a2", "source_id": "b", "title": "Grant from MS Society funds new research", "dek": ""},
        {"id": "a3", "source_id": "a", "title": "Patients welcome MS Society research funding", "dek": ""},
    ]
    label = ev._label("ms", article_list, SOURCE_NAMES)
    assert label != "MS"
    assert label == "MS Society"


def test_label_never_settles_on_a_bare_generic_role_word():
    # "City" only reaches entity status once it is seen capitalized outside the
    # first-word position (S07's proper-ratio rule), so a couple of headlines are
    # phrased with the council named mid-sentence; from then on "City Council" is
    # recognized as one phrase everywhere, including the headlines where "City"
    # leads. The bare, generic "Council" should never win the label over it.
    article_list = [
        {"id": "a1", "source_id": "a", "title": "City Council votes to approve downtown budget plan", "dek": ""},
        {"id": "a2", "source_id": "b", "title": "Debate over City Council budget plan turns heated", "dek": ""},
        {"id": "a3", "source_id": "a", "title": "Residents pack City Council meeting over budget fight", "dek": ""},
        {"id": "a4", "source_id": "b", "title": "City Council votes to approve downtown budget plan", "dek": ""},
    ]
    label = ev._label("council", article_list, SOURCE_NAMES)
    assert label.lower() != "council"
    assert label == "City Council"


# ---------------------------------------------------------------------------
# 6. ids are unchanged by relabeling across two fixture runs
# ---------------------------------------------------------------------------

def test_event_id_is_unchanged_by_relabeling_across_two_runs():
    run1_articles = [
        _article("a1", "a", "UN warns of rising tensions in the region"),
        _article("a2", "b", "UN calls emergency meeting after latest strikes"),
        _article("a5", "a", "UN urges restraint as talks continue"),
        _article("a6", "b", "UN peacekeepers deployed to buffer zone"),
    ]
    run1_clusters = [
        {"id": "c1", "article_ids": ["a1", "a2"]},
        {"id": "c2", "article_ids": ["a5", "a6"]},
    ]
    run1 = build_events(run1_articles, run1_clusters, SOURCES, NOW, frozenset({"world"}))
    assert len(run1) == 1
    run1_event = run1[0]
    assert run1_event["label"] == "UN"  # no multiword phrase reached the threshold yet

    previous = {
        "generated_at": NOW.timestamp(),
        "events": [{"id": run1_event["id"], "cluster_ids": run1_event["cluster_ids"],
                    "live": run1_event["live"], "live_since": None}],
        "clusters": {c["id"]: set(c["article_ids"]) for c in run1_clusters},
    }

    # Run 2: the same four stories plus two new ones that finally supply the
    # multiword phrase, so the label changes even though the underlying story
    # (and most of its articles) is the same one.
    run2_articles = run1_articles + [
        _article("a3", "a", "UN General Assembly opens amid global tensions"),
        _article("a4", "b", "Debate at UN General Assembly turns tense over resolution"),
    ]
    run2_clusters = [
        {"id": "c1", "article_ids": ["a1", "a2", "a3", "a4"]},
        {"id": "c2", "article_ids": ["a5", "a6"]},
    ]
    run2 = build_events(run2_articles, run2_clusters, SOURCES, NOW, frozenset({"world"}), previous)
    assert len(run2) == 1
    run2_event = run2[0]

    assert run2_event["label"] == "UN General Assembly"
    assert run2_event["label"] != run1_event["label"]  # relabeling did happen
    assert run2_event["id"] == run1_event["id"]  # but the id held steady
