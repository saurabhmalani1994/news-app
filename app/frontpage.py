"""Front page model (S04): the pool as stories, one per cluster, in tiers.

A story is either a cluster (S07) or an article no cluster holds. A cluster shows once,
as its lead article, never as repeated rows. Pure and deterministic: the same pool
gives the same stories and the same tiers whatever order its arrays arrive in.

Order comes from the one ranker, app/static/js/ranker.js (S11, DESIGN section 4), run
here under Node with the shipped default profile at the pool's generated_at. The device
runs the same module again only when its stored profile differs (rank-gate.js).
"""
import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.dek import ELLIPSIS, fit_dek, strip_wire_junk
from app.typography import fold_quotes

RANK_CLI = Path(__file__).resolve().parent / "rank_cli.mjs"

# Dek line limits per tier (style.css clamps at the same counts). A dek ends on the last
# whole sentence inside the limit; CHARS_PER_LINE is a conservative fill of a 320px
# measure at the dek's 16.5px Newsreader, so a fitted dek never meets the clamp.
DEK_LINES = {"hero": 4, "secondary": 3}
CHARS_PER_LINE = 38

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


def _needs_ellipsis(dek, lines):
    return fit_dek(dek, lines * CHARS_PER_LINE).endswith(ELLIPSIS)


def _lead(members):
    """The member that fronts the story: one with a dek (hero and lead blocks show it),
    then (D1) one whose dek fits a lead block's three lines without an ellipsis, then
    the hero's four, then the newest, then the lowest id so ties never depend on input
    order. The fit is judged at every dek tier rather than the story's own, so the lead
    never depends on rank and a device re-rank can promote a row without a new lead."""
    def key(a):
        dek = clean_dek(a)
        return (dek == "", bool(dek) and _needs_ellipsis(dek, DEK_LINES["secondary"]),
                bool(dek) and _needs_ellipsis(dek, DEK_LINES["hero"]), -_epoch(a["published_at"]), a["id"])
    return min(members, key=key)


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


RANK_ARTICLE_FIELDS = ("id", "source_id", "title", "published_at", "topics")
RANK_CLUSTER_FIELDS = ("id", "article_ids", "near_duplicates", "independent_sources", "lean_buckets")


def rank_input(pool):
    """The compact pool the ranker reads: only the fields it scores on, sorted by id.
    The build ranks exactly this, and the page embeds exactly this for the device, so
    both sides rank byte-identical input."""
    def pick(item, fields):
        return {k: item[k] for k in fields if k in item}
    return {
        "generated_at": pool.get("generated_at"),
        "articles": sorted((pick(a, RANK_ARTICLE_FIELDS) for a in pool["articles"]), key=lambda a: a["id"]),
        "clusters": sorted((pick(c, RANK_CLUSTER_FIELDS) for c in pool.get("clusters", [])), key=lambda c: c["id"]),
    }


def run_ranker(pool):
    """{key, ranked}: the default profile's ranking-field key and every story, best
    first, with its score and explanation (app/static/js/ranker.js under Node)."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("the S11 ranker needs Node on PATH (preinstalled on GitHub's Ubuntu runners)")
    payload = json.dumps({"pool": rank_input(pool), "now": pool.get("generated_at")})
    done = subprocess.run([node, str(RANK_CLI)], input=payload.encode("utf-8"), capture_output=True, check=False)
    if done.returncode:
        raise RuntimeError("ranker failed: " + done.stderr.decode("utf-8", "replace")[-2000:])
    return json.loads(done.stdout.decode("utf-8"))


def ranked_stories(pool, ranking=None):
    """Stories in the ranker's order. The ranker groups the pool the same way
    build_stories does; a mismatch is a bug, so it fails loudly."""
    ranking = ranking or run_ranker(pool)
    stories = {s.id: s for s in build_stories(pool)}
    order = [r["id"] for r in ranking["ranked"]]
    if sorted(order) != sorted(stories):
        raise RuntimeError("ranker and build_stories disagree on the story set")
    return [stories[i] for i in order]


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


def front_page(pool, ranking=None):
    return assign_tiers(ranked_stories(pool, ranking))
