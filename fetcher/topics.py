"""S08: deterministic topic tagging. Standard library only (R30).

Every published article is tagged from its source's interest bucket (sources.json)
plus keyword matches against its own title and dek, using the closed tag set and
keyword lists in topics.json. Pure and deterministic: the same bucket, title and dek
always produce the same sorted tag list, in the same run and in every later one.

R16: must-know eligibility needs a hard-news topic tag. hard_news in topics.json is
that closed subset (world, politics, economy, science, conflict); this module keeps
it validated against the full topic set so a typo can never silently drop a topic out
of eligibility checking.
"""
import json
import re
from pathlib import Path

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
    return doc


def tag_article(bucket, title, dek, topics_doc):
    """Return a sorted, deduplicated list of topic tags for one article.

    Pure function of (bucket, title, dek, topics_doc): no clock, no network, no
    randomness, so the same inputs always give the same tags.
    """
    tags = set(topics_doc["bucket_topics"].get(bucket, ()))
    text = f"{title} {dek or ''}".lower()
    for tag, keywords in topics_doc["keyword_topics"].items():
        if any(kw in text for kw in keywords):
            tags.add(tag)
    if not tags:
        tags.add("world")
    return sorted(tags)


def hard_news_topics(topics_doc):
    return frozenset(topics_doc["hard_news"])
