"""Front page model (S04): the pool as stories, one per cluster, in tiers.

A story is either a cluster (S07) or an article no cluster holds. A cluster shows once,
as its lead article, never as repeated rows. Pure and deterministic: the same pool
gives the same stories and the same tiers whatever order its arrays arrive in.

Ordering here is INTERIM. The ranker is S11 (DESIGN section 4); until it lands,
`interim_order` stands in with an order the design allows: independent source count,
then recency. S11 replaces `interim_order` and nothing else in this module.
"""
from dataclasses import dataclass
from datetime import datetime

from app.dek import strip_wire_junk
from app.typography import fold_quotes

# Tier sizes, by position in the order. Hero is the single top story; secondary are
# lead blocks that keep their dek; river rows carry no dek (nyt-measured, row 5);
# every story after that is a compact text-only row.
HERO_COUNT = 1
SECONDARY_COUNT = 2
RIVER_COUNT = 12
TIERS = ("hero", "secondary", "river", "text_only")


@dataclass(frozen=True)
class Story:
    id: str
    lead: dict
    article_ids: tuple
    independent_sources: int
    latest: str


def _epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return 0.0


def clean_dek(article):
    """The dek to show, or '' when there is none worth showing: blank once its wire
    dateline and CMS trailer are gone (app.dek), or a repeat of the headline (some
    feeds send the title again as the description)."""
    dek = strip_wire_junk(article.get("dek"))
    title = " ".join(article.get("title", "").split())
    if not dek or fold_quotes(dek).lower().startswith(fold_quotes(title).lower()):
        return ""
    return dek


def independent_source_count(members, near_duplicates):
    """Outlets that wrote their own copy. A near-duplicate group (syndicated copies of
    one piece) counts once, and one outlet counts once however many pieces it ran."""
    group_of = {}
    for index, group in enumerate(near_duplicates):
        for article_id in group:
            group_of[article_id] = index
    units = set()
    for article in members:
        group = group_of.get(article["id"])
        units.add(("group", group) if group is not None else ("source", article["source_id"]))
    return len(units)


def _lead(members):
    """The member that fronts the story: one with a dek (hero and lead blocks show it),
    then the newest, then the lowest id so ties never depend on input order."""
    return min(members, key=lambda a: (clean_dek(a) == "", -_epoch(a["published_at"]), a["id"]))


def build_stories(pool):
    by_id = {a["id"]: a for a in pool["articles"]}
    clustered = set()
    stories = []
    for cluster in pool.get("clusters", []):
        members = [by_id[i] for i in cluster["article_ids"] if i in by_id and i not in clustered]
        if not members:
            continue
        clustered.update(a["id"] for a in members)
        stories.append(Story(
            id=cluster["id"],
            lead=_lead(members),
            article_ids=tuple(sorted(a["id"] for a in members)),
            independent_sources=independent_source_count(members, cluster.get("near_duplicates", [])),
            latest=max((a["published_at"] for a in members), key=_epoch),
        ))
    for article in pool["articles"]:
        if article["id"] in clustered:
            continue
        stories.append(Story(
            id=article["id"],
            lead=article,
            article_ids=(article["id"],),
            independent_sources=1,
            latest=article["published_at"],
        ))
    return stories


def interim_order(stories):
    """INTERIM, replaced by the S11 ranker. More independent sources first, then the
    story's newest article, then id as a stable tiebreak."""
    return sorted(stories, key=lambda s: (-s.independent_sources, -_epoch(s.latest), s.id))


def assign_tiers(ordered):
    """Positional tiers over an ordered story list: {tier: [stories]}."""
    cut1 = HERO_COUNT
    cut2 = cut1 + SECONDARY_COUNT
    cut3 = cut2 + RIVER_COUNT
    return {
        "hero": ordered[:cut1],
        "secondary": ordered[cut1:cut2],
        "river": ordered[cut2:cut3],
        "text_only": ordered[cut3:],
    }


def front_page(pool):
    return assign_tiers(interim_order(build_stories(pool)))
