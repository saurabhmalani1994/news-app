"""B10: the biotech tag is industrial biotech (microbial fermentation, biomanufacturing,
fermentation-derived food and dairy proteins), set from an article's own title and dek
only, never from its source bucket. Pharma, clinical and mammalian cell work stays off
the Biotech tab. See fetcher/topics.py and topics.json biotech_rules."""
import json
import re
import subprocess
from pathlib import Path

import pytest

from fetcher.topics import TopicsError, biotech_match, load_topics, tag_article

ROOT = Path(__file__).resolve().parent.parent
TOPICS = load_topics()
SOURCES = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))["sources"]


def is_biotech(title, dek=""):
    return biotech_match(title, dek, TOPICS)


@pytest.mark.parametrize("title", [
    "Every company needs a fermentation strategy, analysts say",  # strong term, not the name
])
def test_a_strong_term_tags_whatever_else_the_headline_says(title):
    assert is_biotech(title)


@pytest.mark.parametrize("title, want", [
    # "Every" is a common word: only the company's own capitals, or EVERY plus context
    ("Why every company is rethinking its supply chain", False),
    ("Why Every Company Needs an AI Plan", False),
    ("Everyday savings on groceries this week", False),
    ("The EVERY Company raises $55m for egg proteins", True),
    ("EVERY Co. opens a new plant in Belgium", True),
    ("EVERY signs a supply deal for animal-free egg white", True),
    ("EVERY one of these stocks fell today", False),
    # "Ferm" and "Cauldron" alone are not the company
    ("Ferm Living opens a flagship store", False),
    ("Physicists trap fermions in a new lattice", False),
    ("Cauldron Ferm opens its Australian plant", True),
    ("Cauldron raises money for continuous fermentation", True),
    ("Witches brew in the cauldron at the harvest fair", False),
    # "Perfect Day" is an everyday phrase
    ("A Perfect Day in Paris: where to eat", False),
    ("Perfect Day expands animal-free whey output", True),
    # names match whole words only
    ("Formosa Plastics posts a quarterly loss", False),
    ("Formo raises a Series B", True),
    ("Yeasty notes lift the new sourdough", False),
])
def test_short_name_and_word_boundary_traps(title, want):
    assert is_biotech(title) is want


@pytest.mark.parametrize("title", [
    "Ajinomoto expands amino acid capacity in Brazil",
    "Evonik opens a biosurfactant plant",
    "Pow.bio signs its first continuous fermentation customer",
    "Enduro Genetics raises seed round",
    "David Protein buys an egg white supplier",
    "Vivici gets US approval for its beta-lactoglobulin",
    "Fonterra lifts its milk price forecast",
    "dsm-firmenich sells its animal nutrition arm",
    "Nature’s Fynd cuts staff",  # a curly apostrophe matches the straight one
    "Solar Foods starts Factory 01 production",
    "Liberation Labs finishes its Richmond plant",
    "Onego Bio moves into packaged waffles",
])
def test_the_owners_named_companies_and_their_peers_tag(title):
    assert is_biotech(title)


@pytest.mark.parametrize("title, dek", [
    ("FDA approves CAR-T therapy for lymphoma", ""),
    ("Phase 3 trial of an anti-PD-1 antibody meets its endpoint", ""),
    ("AstraZeneca's pipeline strategy: building the next wave of growth", ""),
    ("What can GLP-1s do beside treat diabetes and obesity?", ""),
    ("Cultivated meat startup wins Singapore approval", ""),
    ("New gene therapy for sickle cell disease", ""),
    ("Stroke remodels tumor microenvironment to promote glioma growth", ""),
])
def test_pharma_clinical_and_mammalian_stories_stay_off(title, dek):
    assert not is_biotech(title, dek)


def test_a_weak_term_is_kept_off_by_a_negative_but_a_strong_term_is_not():
    assert is_biotech("Helogen partners with UCL for space biomanufacturing")
    assert not is_biotech("Biomanufacturing of monoclonal antibodies scales up in Ireland")
    assert is_biotech("Engineered yeasts cut the cost of vanillin")  # plural of a weak term
    assert not is_biotech("New antifungal drug clears resistant yeast infection")
    # a strong industrial term wins over a negative one
    assert is_biotech("Hybrid cultivated meat uses precision fermentation fat")


def test_no_source_bucket_gives_biotech_and_pharma_outlets_keep_science():
    for bucket in {s["bucket"] for s in SOURCES}:
        assert "biotech" not in tag_article(bucket, "A headline with no matched keywords at all", "", TOPICS)
    tags = tag_article("biotech", "Navigating major inflection points from IND to approval", "", TOPICS)
    assert tags == ["science"]
    tags = tag_article("biotech", "Formo scales precision-fermented casein", "", TOPICS)
    assert "biotech" in tags and "science" in tags
    # any outlet, not only the biotech bucket, can carry it from its own text
    assert "biotech" in tag_article("general", "Precision fermentation plant opens in Minnesota", "", TOPICS)
    assert "biotech" in tag_article(None, "Biomass fermentation startup raises $20m", "", TOPICS)


def test_topics_json_rejects_biotech_from_a_bucket_or_a_plain_keyword_list(tmp_path):
    doc = json.loads((ROOT / "topics.json").read_text(encoding="utf-8"))
    bad = json.loads(json.dumps(doc))
    bad["bucket_topics"]["biotech"].append("biotech")
    (tmp_path / "a.json").write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(TopicsError):
        load_topics(tmp_path / "a.json")
    bad = json.loads(json.dumps(doc))
    bad["keyword_topics"]["biotech"] = ["crispr"]
    (tmp_path / "b.json").write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(TopicsError):
        load_topics(tmp_path / "b.json")


def test_rule_lists_are_non_empty_lowercase_where_case_does_not_matter_and_unique():
    rules = TOPICS["biotech_rules"]
    for key in ("strong", "weak", "names", "names_exact_case", "names_with_context", "context", "negative"):
        terms = rules[key]
        assert terms and all(isinstance(t, str) and t.strip() == t and t for t in terms), key
        assert len(set(terms)) == len(terms), key
    for key in ("strong", "weak", "context", "negative"):
        assert all(t == t.lower() for t in rules[key]), key
    assert not re.search("—", json.dumps(rules, ensure_ascii=False))


def test_b10_sources_are_in_with_their_buckets_and_one_syndication_group_each():
    by_id = {s["id"]: s for s in SOURCES}
    assert by_id["agfundernews_biomanufacturing"]["bucket"] == "biotech"
    assert by_id["agfundernews_alt_protein"]["bucket"] == "climate_food"
    assert by_id["foodnavigator"]["bucket"] == "climate_food"
    assert by_id["dairyreporter"]["bucket"] == "climate_food"
    assert {by_id[i]["syndication_group"] for i in ("agfundernews", "agfundernews_biomanufacturing",
                                                     "agfundernews_alt_protein")} == {"agfundernews"}
    assert by_id["foodnavigator"]["syndication_group"] == by_id["dairyreporter"]["syndication_group"]


def test_the_biotech_tab_is_the_tag_alone_not_the_bucket():
    out = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import { SECTIONS } from './app/static/js/sections.js';"
         "console.log(JSON.stringify(SECTIONS.find((s) => s.id === 'biotech')));"],
        cwd=ROOT, capture_output=True, text=True, check=True)
    section = json.loads(out.stdout)
    assert section["tags"] == ["biotech"] and not section.get("buckets")
