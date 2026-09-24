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
# S27: source buckets are facts about a source (R10), repo owned in sources.json; the
# pool's own source records do not carry them, so the build reads them from here.
SOURCES_JSON = Path(__file__).resolve().parent.parent / "sources.json"

# Dek line limits per tier (style.css clamps at the same counts). A dek ends on the last
# whole sentence inside the limit; CHARS_PER_LINE is a conservative fill of a 320px
# measure at the dek's 16.5px Newsreader, so a fitted dek never meets the clamp.
DEK_LINES = {"hero": 4, "secondary": 3}
CHARS_PER_LINE = 38
# U1: river and text-only rows carry a two-line summary too (the owner's "none of the
# news shows texts"), unless the profile's display.summaries is "top". Their measure is
# 280px beside the overflow gutter (320px under a thumbnail), about 34 characters a line
# at 360dp; 32 leaves room for capitals and long words, so a fitted row dek does not
# meet the 2-line clamp (tests/browser/u1_check.mjs counts clamped deks on the live pool).
ROW_DEK_LINES = {"river": 2, "text_only": 2}
ROW_CHARS_PER_LINE = 32


def dek_budget(tier):
    """The dek's character budget for a tier: its line limit times its measure's fill."""
    if tier in DEK_LINES:
        return DEK_LINES[tier] * CHARS_PER_LINE
    return ROW_DEK_LINES[tier] * ROW_CHARS_PER_LINE


# Tier sizes, by position in the order. Hero is the single top story; secondary are
# lead blocks with a longer dek; river rows show a thumbnail and a two-line dek; every
# story after that is a compact text-only row with the same two-line dek.
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


RANK_ARTICLE_FIELDS = ("id", "source_id", "title", "published_at", "topics", "geo")
RANK_CLUSTER_FIELDS = ("id", "article_ids", "near_duplicates", "independent_sources", "lean_buckets")


def rank_input(pool):
    """The compact pool the ranker reads: only the fields it scores on, sorted by id.
    The build ranks exactly this, and the page embeds exactly this for the device, so
    both sides rank byte-identical input. S13: each cluster also names its `lead`, the
    article its card shows (the lead rule never depends on rank, D1), because the lean
    quota and the other-side slot read the lean of the outlet a card shows."""
    def pick(item, fields):
        return {k: item[k] for k in fields if k in item}
    leads = {s.id: s.lead["id"] for s in build_stories(pool)}
    clusters = []
    for cluster in pool.get("clusters", []):
        record = pick(cluster, RANK_CLUSTER_FIELDS)
        if cluster["id"] in leads:
            record["lead"] = leads[cluster["id"]]
        clusters.append(record)
    return {
        "generated_at": pool.get("generated_at"),
        "articles": sorted((pick(a, RANK_ARTICLE_FIELDS) for a in pool["articles"]), key=lambda a: a["id"]),
        "clusters": sorted(clusters, key=lambda c: c["id"]),
    }


def _source_field(pool, field, sources_path):
    try:
        sources = json.loads(Path(sources_path).read_text(encoding="utf-8")).get("sources", [])
    except (OSError, ValueError):
        return {}
    present = {s.get("id") for s in pool.get("sources", [])} | {a.get("source_id") for a in pool["articles"]}
    return {s["id"]: s[field] for s in sorted(sources, key=lambda s: str(s.get("id")))
            if s.get("id") in present and isinstance(s.get(field), str)}


def source_buckets(pool, sources_path=SOURCES_JSON):
    """{source_id: bucket} for the pool's sources, from sources.json (S27 section tabs).
    Sorted by id so the page embeds it byte for byte the same whatever the input order;
    an absent or unreadable file leaves every section to its topic tags alone."""
    return _source_field(pool, "bucket", sources_path)


def source_leans(pool, sources_path=SOURCES_JSON):
    """{source_id: lean bucket} for the pool's sources, from sources.json (S13 lean quota
    and other-side slot; lean is repo owned, R10). Absent file: no lean, no quota."""
    return _source_field(pool, "lean", sources_path)


def source_ownership(pool, sources_path=SOURCES_JSON):
    """{source_id: ownership label} for the pool's sources that carry one (S14 coverage
    view): state-owned, state-funded and so on (fetcher/taxonomy.py OWNERSHIP_LABELS).
    Ownership is a separate, optional fact from lean (R10); most sources have none, and
    those are simply absent here."""
    return _source_field(pool, "ownership", sources_path)


def source_names(pool):
    """{source_id: name} from the pool's own source records, sorted by id, so a pass can
    name an outlet in a story's explanation."""
    return {s["id"]: s.get("name", "") for s in sorted(pool.get("sources", []), key=lambda s: str(s.get("id")))
            if s.get("id")}


def failing_sources(pool):
    """{source_id: {state, runs}} for each source the pool's S06 source_health marks
    unhealthy, sorted by id: what S28's silence alarm reads to tell "no coverage" apart
    from "its sources are failing". runs is the current unbroken run of errors (or of
    empties). An older pool without source_health has none."""
    health = pool.get("source_health") or {}
    out = {}
    for sid in sorted(health):
        entry = health[sid]
        if isinstance(entry, dict) and entry.get("unhealthy"):
            runs = max(int(entry.get("consecutive_error") or 0), int(entry.get("consecutive_empty") or 0))
            out[sid] = {"state": str(entry.get("state", "")), "runs": runs}
    return out


def pass_input(pool):
    """What the S13 passes read beside the compact pool: buckets, leans and names,
    S28's failing sources for the silence alarm, and S33's events array for the Live
    tab (the pool's own field, carried through unchanged; empty when the pool predates
    S32 or the fetcher found no event this run)."""
    return {"buckets": source_buckets(pool), "leans": source_leans(pool), "names": source_names(pool),
            "health": failing_sources(pool), "events": pool.get("events", [])}


def run_ranker(pool):
    """{key, ranked, removed, sections}: the default profile's ranking-field key; Today's
    stories in page order after the S13 passes, each with its score, explanation, pass
    entries and any other-side link (app/static/js/passes.js under Node); what mute and
    dedup removed; and S27's section tabs, each its ids after its own passes."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("the S11 ranker needs Node on PATH (preinstalled on GitHub's Ubuntu runners)")
    payload = json.dumps({"pool": rank_input(pool), "now": pool.get("generated_at"), **pass_input(pool)})
    done = subprocess.run([node, str(RANK_CLI)], input=payload.encode("utf-8"), capture_output=True, check=False)
    if done.returncode:
        raise RuntimeError("ranker failed: " + done.stderr.decode("utf-8", "replace")[-2000:])
    return json.loads(done.stdout.decode("utf-8"))


def ranked_stories(pool, ranking=None):
    """Stories in the ranker's page order. The ranker groups the pool the same way
    build_stories does, and every story is either on the page or named as removed by a
    pass (S13); anything else is a bug, so it fails loudly."""
    ranking = ranking or run_ranker(pool)
    stories = {s.id: s for s in build_stories(pool)}
    order = [r["id"] for r in ranking["ranked"]]
    removed = [r["id"] for r in ranking.get("removed", [])]
    if len(set(order)) != len(order) or sorted(order + removed) != sorted(stories):
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
