"""B8: the best version's fact terms (DESIGN-bundles section 4a, R40). Standard library only.

For every published story with 2 or more outlets, each version (article) gets `bv`, a
fixed-order array of integers, one per fact term below. The device adds the ninth term,
trust, from the owner's profile and picks the face (B5); the carousel orders versions by
the same sum (app/static/js/versions.js orderVersions).

| term     | points                                                                    |
|----------|---------------------------------------------------------------------------|
| original | 20, or 0 for a syndicated copy                                            |
| complete | 15 full text, 7 dek, 0 headline only                                      |
| depth    | 1 per 600 body characters, at most 10                                     |
| headline | headline_rules.json: entities and numbers up, teasers down, floor -10     |
| locality | 15 local, 8 intermediate, 0 overseas or unlabeled                         |
| first    | 10 for the story's first report, falling linearly to 0 at 12 h later     |
| health   | 0, or -5 when the source had 3+ consecutive failed runs (S06)             |
| paywall  | -15 when the source is paywalled and the version has no full text        |

Settled here, where the design is silent:
- A syndicated copy is a version whose source's S08 `syndication_group` is a wire's group
  (WIRE_GROUPS) while the source is not that wire's own feed (PBS NewsHour's group is
  ap_wire), or whose dek or body carries a wire credit (a dateline "(AP)", "Associated
  Press writers ... contributed", a "Copyright ... Reuters" line; CREDIT_RE). A mention
  of a wire in running text ("told Reuters") is not a credit.
- Full text means the version publishes a body (has_body), and depth counts that body's
  plain-text characters; a teaser dek, however long, adds no depth.
- A failed run is S06's error state. A source that published this run just fetched, so
  its current error streak is 0; the term reads the streak the run started with (the
  previous pool's consecutive_error), so a feed that just came back from 3+ failed runs
  still carries -5 this run, and an unhealthy source's current streak counts too.
- first is rounded half up to an integer: 10 at 0 h, 5 at 6 h, 0 from 12 h.
- Named entities in a headline: runs of capitalized words the run's own text treats as
  proper nouns (fetcher.cluster's rule, at least 80% capitalized mid-sentence), plus
  acronyms of 2 to 6 capitals. A run of such words is one entity ("Donald Trump").

Lean and provenance are never inputs: the terms read a source's id, syndication_group
and paywall only, and tests/test_best_version.py changes only a source's lean and its
provenance field (section 3) across the gold fixtures and asserts no term moves.

Review: `python -m fetcher.best_version review tests/fixtures/bundles/gold_2026-09-24.json`
prints, for up to 20 of the fixture's multi-outlet stories, the lead and the runner-up
with their terms, for the owner to judge (section 7: reported, not gated).
"""
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

from fetcher.cluster import CASED_WORD_RE, PROPER_MIN, STOPWORDS, _proper_ratios, _strip_suffix
from fetcher.fetch import _plain

RULES_PATH = Path(__file__).resolve().parent.parent / "headline_rules.json"
TERMS = ("original", "complete", "depth", "headline", "locality", "first", "health", "paywall")

ORIGINAL = 20
COMPLETE_FULL, COMPLETE_DEK = 15, 7
DEPTH_CHARS, DEPTH_MAX = 600, 10
LOCALITY = {"local": 15, "intermediate": 8}
FIRST_MAX, FIRST_HOURS = 10, 12
HEALTH_FAILED_RUNS, HEALTH_PENALTY = 3, -5
PAYWALL_PENALTY = -15

# A wire's S08 group and the source id of the wire's own feed, when sources.json has one.
WIRE_GROUPS = {"ap_wire": "ap", "reuters_wire": "reuters", "afp_wire": "afp"}
_WIRE = r"(?:AP|Reuters|AFP)"
_WIRE_NAME = r"(?:(?:the\s+)?Associated\s+Press|Reuters|AFP|Agence\s+France[- ]Presse)"
CREDIT_RE = re.compile(
    rf"\({_WIRE}\)"                                                    # WASHINGTON (AP) --
    rf"|\b{_WIRE_NAME}\s+(?:writers?|reporters?|correspondents?)\b"   # Associated Press writer X contributed
    rf"|(?:copyright|\u00a9)\s*(?:\d{{4}}\s*)?{_WIRE_NAME}"             # Copyright 2026 The Associated Press
    rf"|^\s*(?:by\s+)?{_WIRE_NAME}\s*$",                               # a byline that is the wire
    re.IGNORECASE | re.MULTILINE)

_NUMBER_RE = re.compile(
    r"(?:US\$|S\$|HK\$|A\$|C\$|NZ\$|[$\u20ac\u00a3\u00a5\u20b9]|\bRs\.?\s?)\s?\d[\d,.]*"
    r"(?:\s?(?:million|billion|trillion|bn|mn|tn|m|k)\b)?"
    r"|\b\d[\d,.]*\s?(?:million|billion|trillion|bn|tn)\b"
    r"|\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b",
    re.IGNORECASE)
_WORD_RE = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*")


def load_rules(path=RULES_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fold(text):
    return (text.replace("\u2019", "'").replace("\u2018", "'")
            .replace("\u201c", '"').replace("\u201d", '"').lower())


def _phrase_re(phrases):
    if not phrases:
        return None
    alts = "|".join(re.escape(_fold(p)) for p in sorted(phrases, key=lambda p: (-len(p), p)))
    return re.compile(rf"(?<![\w'])(?:{alts})(?![\w'])")


def headline_parts(title, rules, proper=None):
    """{entities, numbers, question, breaking, all_caps, clickbait, points} for one
    headline. `proper` is fetcher.cluster's proper-noun ratios for the run's text."""
    proper = proper or {}
    pts = rules["points"]
    text = _strip_suffix(title or "").strip()
    folded = _fold(text)
    breaking_words = [w.upper() for w in rules.get("breaking_words", ())]
    acronyms = {a.upper() for a in rules.get("acronyms", ())}
    min_caps = rules.get("all_caps_min_letters", 5)

    entities, run = 0, False
    for w in CASED_WORD_RE.findall(text):
        k = w.lower()
        is_entity = (k not in STOPWORDS and len(k) >= 2 and w.upper() not in breaking_words
                     and ((w.isupper() and 2 <= len(w) <= 6)
                          or (w[0].isupper() and proper.get(k, 0) >= PROPER_MIN)))
        if is_entity and not run:
            entities += 1
        run = is_entity
    numbers = len(_NUMBER_RE.findall(text))

    question = any(q in text for q in rules.get("question_marks", ("?",)))
    # A breaking word in capitals anywhere, or in any case as the headline's label
    # ("Breaking: ...").
    breaking = any(re.search(rf"(?<![A-Za-z]){re.escape(b)}(?![A-Za-z])", text)
                   or re.match(rf"\s*{re.escape(b)}\s*[:|\-\u2013\u2014]", text, re.IGNORECASE)
                   for b in breaking_words)
    breaking_parts = {part for b in breaking_words for part in b.split()}
    all_caps = any(
        w.isupper() and sum(c.isalpha() for c in w) >= min_caps
        and w not in acronyms and w not in breaking_parts
        for w in _WORD_RE.findall(text))
    bait = _phrase_re(rules.get("clickbait_phrases"))
    clickbait = bool(bait and bait.search(folded))

    points = (min(pts["entity_max"], pts["entity"] * entities)
              + min(pts["number_max"], pts["number"] * numbers)
              - pts["penalty"] * (question + breaking + all_caps + clickbait))
    return {"entities": entities, "numbers": numbers, "question": question, "breaking": breaking,
            "all_caps": all_caps, "clickbait": clickbait, "points": max(pts["floor"], points)}


def is_syndicated_copy(article, source, body_text=""):
    """A wire rewrite (section 4a original = 0): see the module docstring."""
    source = source or {}
    group = source.get("syndication_group")
    if group in WIRE_GROUPS and source.get("id") != WIRE_GROUPS[group]:
        return True
    if source.get("id") in WIRE_GROUPS.values():
        return False  # the wire's own feed is the original
    return bool(CREDIT_RE.search(article.get("dek") or "") or CREDIT_RE.search(body_text or ""))


def _epoch(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def first_points(published_at, story_first):
    hours = max(0.0, (_epoch(published_at) - _epoch(story_first)) / 3600)
    return max(0, math.floor(FIRST_MAX * (1 - hours / FIRST_HOURS) + 0.5))


def failed_runs(source_id, source_health=None, previous_health=None):
    """The source's longest S06 error streak this run: the previous pool's (the streak it
    came into the run with) or the current one."""
    now = ((source_health or {}).get(source_id) or {}).get("consecutive_error", 0)
    before = ((previous_health or {}).get(source_id) or {}).get("consecutive_error", 0)
    return max(now or 0, before or 0)


def version_terms(article, source, *, story_first, body_text="", rules, proper=None,
                  source_health=None, previous_health=None):
    """The eight fact terms of one version, in TERMS order. `source` is the article's
    sources.json record (only id, syndication_group and paywall are read)."""
    source = source or {}
    full = bool(article.get("has_body")) and bool(body_text)
    original = 0 if is_syndicated_copy(article, source, body_text) else ORIGINAL
    complete = COMPLETE_FULL if full else COMPLETE_DEK if (article.get("dek") or "").strip() else 0
    depth = min(DEPTH_MAX, len(body_text) // DEPTH_CHARS) if full else 0
    headline = headline_parts(article.get("title", ""), rules, proper)["points"]
    locality = LOCALITY.get(article.get("locality"), 0)
    first = first_points(article["published_at"], story_first)
    health = (HEALTH_PENALTY if failed_runs(source.get("id", article["source_id"]), source_health,
                                            previous_health) >= HEALTH_FAILED_RUNS else 0)
    paywall = PAYWALL_PENALTY if source.get("paywall") is True and not full else 0
    return [original, complete, depth, headline, locality, first, health, paywall]


def _body_text(record):
    return _plain((record or {}).get("body_html") or "")


def annotate(articles, clusters, sources, bodies=None, source_health=None, previous_health=None,
             rules=None):
    """Write `bv` in place on every published article of a story with 2+ outlets, an
    outlet being an S08 syndication group, as the cluster's independent_sources counts.
    `bodies` is {article_id: body record} (fetcher.bodies.collect_bodies). Returns the
    number of articles scored. Pure: no network, no clock."""
    rules = rules or load_rules()
    by_id = {a["id"]: a for a in articles}
    source_by_id = {s["id"]: s for s in sources}
    bodies = bodies or {}
    proper = _proper_ratios(articles)
    scored = 0
    for cluster in clusters:
        members = [by_id[i] for i in cluster["article_ids"] if i in by_id]
        outlets = {(source_by_id.get(a["source_id"]) or {}).get("syndication_group") or a["source_id"]
                   for a in members}
        if len(outlets) < 2:  # one outlet (S08 group), however many pieces: no bundle
            continue
        story_first = min((a["published_at"] for a in members), key=_epoch)
        for article in members:
            article["bv"] = version_terms(
                article, source_by_id.get(article["source_id"]), story_first=story_first,
                body_text=_body_text(bodies.get(article["id"])), rules=rules, proper=proper,
                source_health=source_health, previous_health=previous_health)
            scored += 1
    return scored


def lead_of(members):
    """The best version among scored members by section 4a's order without trust: the
    higher sum, then the earlier report, then source id, then article id."""
    return min(members, key=lambda a: (-sum(a["bv"]), _epoch(a["published_at"]), a["source_id"], a["id"]))


# --- Gold fixtures and the owner's review list (section 7) -----------------------------

def score_fixture(fixture, sources, rules=None):
    """Score a gold fixture (tests/fixtures/bundles) as the cron would: each labeled story
    is a cluster, countries and tiers come from the articles' own text (fetcher.geo,
    fetcher.locality). The fixtures carry no bodies and no run history, so complete and
    depth read the dek only, every paywalled source takes the paywall term, and health
    is 0. Returns (articles, clusters) with `bv` written on the scored articles."""
    from fetcher import locality
    from fetcher.geo import tag_countries

    articles = []
    for a in fixture["articles"]:
        record = {k: a[k] for k in ("id", "source_id", "title", "published_at") if k in a}
        if a.get("dek"):
            record["dek"] = a["dek"]
        countries = tag_countries(a["title"], a.get("dek", ""))
        if countries:
            record["countries"] = countries
        record["_story"] = a["story"]
        articles.append(record)
    stories = {}
    for a in articles:
        stories.setdefault(a.pop("_story"), []).append(a["id"])
    clusters = [{"id": sid, "article_ids": ids} for sid, ids in sorted(stories.items()) if len(ids) > 1]
    locality.annotate(articles, clusters, sources)
    annotate(articles, clusters, sources, rules=rules)
    return articles, clusters


def _terms_line(article):
    return ", ".join(f"{t} {v}" for t, v in zip(TERMS, article["bv"]))


def review_list(fixture, sources, limit=20):
    """Markdown: the lead and the runner-up of up to `limit` multi-outlet stories, the
    stories with the most outlets first, then by id. Returns (text, stories scored)."""
    articles, clusters = score_fixture(fixture, sources)
    by_id = {a["id"]: a for a in articles}
    names = {s["id"]: s["name"] for s in sources}
    scored = []
    for cl in clusters:
        members = [by_id[i] for i in cl["article_ids"] if "bv" in by_id[i]]
        if members:
            scored.append((cl["id"], members))
    scored.sort(key=lambda x: (-len({a["source_id"] for a in x[1]}), x[0]))
    lines = []
    for n, (sid, members) in enumerate(scored[:limit], 1):
        ranked = sorted(members, key=lambda a: (-sum(a["bv"]), _epoch(a["published_at"]), a["source_id"], a["id"]))
        outlets = len({a["source_id"] for a in members})
        lines.append(f"## {n}. {sid} ({len(members)} versions, {outlets} outlets)")
        lines.append("")
        # The runner-up is the best version from another outlet: an outlet's other
        # pieces sit under its own slide ("More from this outlet"), not beside it.
        runner = next(a for a in ranked if a["source_id"] != ranked[0]["source_id"])
        for label, a in (("Lead", ranked[0]), ("Runner-up", runner)):
            lines.append(f"- **{label}, {sum(a['bv'])}**: {names.get(a['source_id'], a['source_id'])}, "
                         f"\"{a['title']}\" ({a['published_at']})")
            lines.append(f"  - {_terms_line(a)}")
        lines.append("- Owner's pick: ")
        lines.append("")
    return "\n".join(lines), len(scored)


def main(argv=None):
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="B8 best-version tools")
    ap.add_argument("command", choices=["review"])
    ap.add_argument("fixture")
    ap.add_argument("--sources", default=str(RULES_PATH.parent / "sources.json"))
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args(argv)
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    sources = json.loads(Path(args.sources).read_text(encoding="utf-8"))["sources"]
    text, total = review_list(fixture, sources, args.limit)
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    print(f"({min(args.limit, total)} of {total} multi-outlet stories)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
