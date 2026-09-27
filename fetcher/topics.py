"""S08: deterministic topic tagging. Standard library only (R30).

Every published article is tagged from its source's interest bucket (sources.json)
plus keyword matches against its own title and dek, using the closed tag set and
keyword lists in topics.json. Pure and deterministic: the same bucket, title and dek
always produce the same sorted tag list, in the same run and in every later one.

R16: must-know eligibility needs a hard-news topic tag. hard_news in topics.json is
that closed subset (world, politics, economy, science, conflict); this module keeps
it validated against the full topic set so a typo can never silently drop a topic out
of eligibility checking.

**us_politics (review fix).** `politics` covers politics anywhere (a UK election is
politics too); the app previously read `politics` to apply the owner's US-politics
interest weight, which meant a UK or Brazilian election story got that weight as well.
`us_politics` is the narrower, additional tag: the us_politics source bucket, plus US
government keywords (Congress, Senate, the White House, the Supreme Court) and, for
articles from any other bucket, a state name paired with an election-context word in
the same title+dek (topics.json's `us_election_signals`). Whenever us_politics fires,
politics fires too, since a US-politics story is still a politics story; `politics`
alone is never narrowed.

**world (review fix).** `world` used to be an automatic tag for every general-bucket
article (roughly half of which are literally US-outlet sections, the other half
US-focused outlets covering everything), which made R16 must-know eligibility and R22
event eligibility loose. The rule now: `world` is a signal, not a bucket default. It is
tagged only when the text names a non-US place or country, an international body (the
UN, NATO, the EU, the WHO, the World Bank...), or a conflict keyword (war coverage is
international even when the outlet is domestic), or when the source's own bucket is
already non-US (asia, israel_gaza, sudan carry world in bucket_topics, unchanged). A
general-bucket article with none of those signals gets no world tag; that is
intentional; it can still carry politics, economy, science or us_politics from its own
keyword matches, and shows in Today regardless of topic tags.

**singapore and asia (G1).** These two follow the article's own geography, never its
outlet: `singapore` is set exactly when fetcher.geo gives the article `sg`, and `asia`
exactly when it gives `asia` (topics.json `geo_topics`). The singapore and asia buckets
no longer add them, so a Singapore outlet's piece on the White House is not a Singapore
story for ranking affinity, R16 or the tabs. The asia bucket still adds `world` (F1).

**no bucket, no default (W4).** A watch item (fetcher/watch.py) from an outlet outside
sources.json carries no source bucket at all (`bucket=None`), not the general bucket.
W3 found that such an item still fell back to `world` through the "no tags at all"
default below, so a purely local watch match (say, a city council story from a small
outlet) showed up in the World tab and its affinity term. The bucket default now only
fires for a real, configured bucket; `bucket=None` gets no default and is tagged from
its own text and G1 geo tags alone, same as any other article, and can end up with no
topics at all. Its own watch tag is what surfaces it regardless.

**climate_food bucket fix (F7).** The climate_food bucket (Green Queen, Food Dive,
Canary Media, CTVC, Biofuels Digest and the rest of sources.json's food tech/climate
tech outlets) had no bucket_topics entry, so its own articles carried neither the
foodtech nor the climate_tech tag unless the keyword lists happened to match, which
is why both tags measured thin before this fix even though the sources were live.
bucket_topics now gives the bucket both tags directly, the same pattern biotech
already used for its own bucket. The foodtech and climate_tech keyword lists were
also widened (cell-based meat, mycoprotein, direct air capture, heat pump and more)
so a relevant story from a general outlet still gets tagged.

**biotech is industrial biotech, from the text only (B10).** The owner's Biotech tab
and his Industrial Biotech interest mean microbial fermentation and biomanufacturing
(precision and biomass fermentation, strain engineering, fermentation-derived food and
dairy proteins, enzymes, cultures, specialty ingredients), not drug pipelines, clinical
trials, antibodies, cell and gene therapy or cultivated meat. The biotech bucket
(Labiotech, GEN, Fierce Biotech, BioProcess International...) used to give every one of
its articles the biotech tag, and a measured pool showed 1 of 27 Biotech tab stories
was industrial. Now no bucket gives biotech; topics.json `biotech_rules` decides it from
the article's own title and dek, matched on word boundaries (never inside a word, so
"Ferm" or "Every" alone never fire): a strong term always tags, a weak term only when
no negative (drug, clinical, mammalian cell) term is present, a company name tags, and
names that are everyday words ("EVERY", "Perfect Day") need their exact capitals plus
a context word. The bucket keeps its science tag, so pharma pieces still reach the
science interest as before.
"""
import functools
import json
import re
from pathlib import Path

from fetcher.geo import tag_geo

TOPICS_PATH = Path(__file__).resolve().parent.parent / "topics.json"


class TopicsError(Exception):
    """topics.json is missing a field or names a tag outside its own closed set."""


def load_topics(path=TOPICS_PATH):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    tags = set(doc["topics"])
    for tag in doc["hard_news"]:
        if tag not in tags:
            raise TopicsError(f"hard_news names unknown tag {tag!r}")
    for bucket, bucket_tags in doc["bucket_topics"].items():
        for tag in bucket_tags:
            if tag not in tags:
                raise TopicsError(f"bucket_topics[{bucket!r}] names unknown tag {tag!r}")
    for tag in doc["keyword_topics"]:
        if tag not in tags:
            raise TopicsError(f"keyword_topics names unknown tag {tag!r}")
    for bucket, bucket_tags in doc["bucket_topics"].items():
        if "biotech" in bucket_tags:
            raise TopicsError(f"bucket_topics[{bucket!r}] adds 'biotech', which only biotech_rules may set (B10)")
    if "biotech" in doc["keyword_topics"]:
        raise TopicsError("keyword_topics adds 'biotech', which only biotech_rules may set (B10)")
    for geo_tag, tag in _geo_topics(doc).items():
        if tag not in tags:
            raise TopicsError(f"geo_topics[{geo_tag!r}] names unknown tag {tag!r}")
        for bucket, bucket_tags in doc["bucket_topics"].items():
            if tag in bucket_tags:
                raise TopicsError(f"bucket_topics[{bucket!r}] adds {tag!r}, which only the text may set")
        if tag in doc["keyword_topics"]:
            raise TopicsError(f"keyword_topics adds {tag!r}, which only geo_topics may set")
    return doc


def _geo_topics(doc):
    return {k: v for k, v in doc.get("geo_topics", {}).items() if k != "note"}


def _keyword_hit(text, keywords):
    return any(kw in text for kw in keywords)


_APOSTROPHES = str.maketrans({"’": "'", "‘": "'"})


@functools.lru_cache(maxsize=64)
def _term_re(terms, exact_case=False, plural=False):
    """One regex matching any of terms as whole words: never preceded or followed by
    a letter or digit, so "ferm" does not fire inside "fermions" or "Every" inside
    "Everyday". plural lets a trailing s or es through ("yeasts", "enzymes")."""
    if not terms:
        return None
    alts = sorted((re.escape(t.translate(_APOSTROPHES)) for t in terms), key=len, reverse=True)
    tail = "(?:e?s)?" if plural else ""
    flags = 0 if exact_case else re.IGNORECASE
    return re.compile(r"(?<![0-9A-Za-z])(?:" + "|".join(alts) + ")" + tail + r"(?![0-9A-Za-z])", flags)


def _rule_hit(text, rules, key, exact_case=False, plural=False):
    pattern = _term_re(tuple(rules.get(key, ())), exact_case, plural)
    return bool(pattern and pattern.search(text))


def biotech_match(title, dek, topics_doc):
    """Whether an article's own title and dek make it industrial biotech (B10, see
    the module note and topics.json biotech_rules)."""
    rules = topics_doc.get("biotech_rules")
    if not rules:
        return False
    text = f"{title} {dek or ''}".translate(_APOSTROPHES)
    if _rule_hit(text, rules, "strong", plural=True):
        return True
    if (_rule_hit(text, rules, "names") or _rule_hit(text, rules, "names_exact_case", exact_case=True)
            or (_rule_hit(text, rules, "names_with_context", exact_case=True)
                and _rule_hit(text, rules, "context", plural=True))):
        return True
    return (_rule_hit(text, rules, "weak", plural=True)
            and not _rule_hit(text, rules, "negative", plural=True))


def _us_election_signal(text, topics_doc):
    """A US state name and an election-context word both present in title+dek
    (order and adjacency do not matter): "Georgia" alone is ambiguous with the
    country, so it is deliberately left out of the states list in topics.json."""
    signals = topics_doc.get("us_election_signals")
    if not signals:
        return False
    return (_keyword_hit(text, signals.get("states", ()))
            and _keyword_hit(text, signals.get("context_words", ())))


def tag_article(bucket, title, dek, topics_doc, geo=None):
    """Return a sorted, deduplicated list of topic tags for one article.

    Pure function of (bucket, title, dek, topics_doc): no clock, no network, no
    randomness, so the same inputs always give the same tags. geo is the article's
    fetcher.geo tags when the caller already has them; computed here otherwise.
    """
    if geo is None:
        geo = tag_geo(bucket, title, dek)
    tags = set(topics_doc["bucket_topics"].get(bucket, ()))
    for geo_tag, tag in _geo_topics(topics_doc).items():
        if geo_tag in geo:
            tags.add(tag)
    text = f"{title} {dek or ''}".lower()
    for tag, keywords in topics_doc["keyword_topics"].items():
        if _keyword_hit(text, keywords):
            tags.add(tag)
    if biotech_match(title, dek, topics_doc):
        tags.add("biotech")
    if _us_election_signal(text, topics_doc):
        tags.add("us_politics")
    if "us_politics" in tags:
        tags.add("politics")
    if "conflict" in tags:
        tags.add("world")  # conflict keywords are war coverage, always international
    if not tags and bucket is not None:
        tags.add("world")  # a bucket default; an article with no bucket at all (a
        # watch item from an outlet outside sources.json, W4) gets no such default
    return sorted(tags)


def hard_news_topics(topics_doc):
    return frozenset(topics_doc["hard_news"])
