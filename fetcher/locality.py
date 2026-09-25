"""B4: local, intermediate and overseas (DESIGN-bundles section 4). Standard library only.

Two facts meet here. The outlet's home country is sources.json `country` (hand-entered,
U3), plus `exile_of` for an exile newsroom (R42). The story's countries come from its
versions' own text: each article's `countries` (fetcher/geo.py tag_countries), never
the outlet.

Story countries are those named by at least half of the story's outlets, at most 2
(bilateral stories such as US and CN). An outlet with several pieces in the story counts
once, with every country any of its pieces names, so one outlet's three articles never
outvote two others. A story with no country, or more than 2, gets no label. A lone
article is a story of one outlet: its own countries, under the same cap.

Each version's tier against the story countries: local when the outlet's country is one
of them; intermediate when (outlet country, story country) is a geo.json `intermediate`
pair (HK or MO on CN, MY and SG on each other) or the story country is the outlet's
`exile_of`; overseas otherwise, Taiwan on China included (R42). With two story countries
the nearer tier wins. An outlet with no country (the watch searches' Google News source)
gets no tier.

Pure and deterministic: tiers are facts computed in the cron, so a pool replays them.
"""
from collections import Counter

from fetcher.geo import load_geo

TIERS = ("local", "intermediate", "overseas")  # nearest first
MAX_STORY_COUNTRIES = 2


def story_countries(members):
    """The story countries of a story's member articles, most-named first, then by code;
    None when no country qualifies or more than MAX_STORY_COUNTRIES do."""
    by_outlet = {}
    for article in members:
        by_outlet.setdefault(article["source_id"], set()).update(article.get("countries") or ())
    if not by_outlet:
        return None
    named = Counter(code for codes in by_outlet.values() for code in codes)
    qualify = [code for code, n in named.items() if 2 * n >= len(by_outlet)]
    if not qualify or len(qualify) > MAX_STORY_COUNTRIES:
        return None
    return sorted(qualify, key=lambda code: (-named[code], code))


def tier_for(source, countries, pairs):
    """One version's tier against the story countries, or None when the outlet has no
    country or the story none."""
    outlet = (source or {}).get("country")
    if not outlet or not countries:
        return None
    exile = source.get("exile_of")
    best = len(TIERS) - 1
    for code in countries:
        if outlet == code:
            best = 0
        elif (outlet, code) in pairs or exile == code:
            best = min(best, 1)
    return TIERS[best]


def annotate(articles, clusters, sources, geo=None):
    """Write cluster `story_countries` and article `locality` in place, on the published
    articles and clusters. Returns the Counter of tiers written."""
    geo = geo or load_geo()
    pairs = geo["intermediate"]
    by_id = {a["id"]: a for a in articles}
    source_by_id = {s["id"]: s for s in sources}
    tiers = Counter()

    def label(members, countries):
        for article in members:
            tier = tier_for(source_by_id.get(article["source_id"]), countries, pairs)
            if tier:
                article["locality"] = tier
                tiers[tier] += 1

    clustered = set()
    for cluster in clusters:
        members = [by_id[i] for i in cluster["article_ids"] if i in by_id]
        clustered.update(a["id"] for a in members)
        countries = story_countries(members)
        if countries:
            cluster["story_countries"] = countries
            label(members, countries)
    for article in articles:
        if article["id"] not in clustered:
            countries = story_countries([article])
            if countries:
                label([article], countries)
    return tiers
