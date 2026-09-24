"""S32: event detection for the Live tab (R22, R16). Standard library only (R30).

Grouping. A cluster's key entities are S07 entity words (fetcher.cluster, capitalized
words), adjacent ones joined into phrases, carried by at least half of its articles and
by at least two. Phrases in more than GENERIC_SHARE of the whole pool (and more than
GENERIC_FLOOR articles) are dropped as too generic to define an event. Clusters are then grouped greedily, entity by entity: the entity
shared by the most clusters (inside a 48h window, R22) forms an event from those
clusters, they leave the pool of candidates, and the next entity goes. Greedy rather
than union-find, so one "Israel" cluster that also names "Iran" cannot chain two
unrelated events into one. An event needs at least MIN_EVENT_CLUSTERS clusters. Its
label is the shared entity as the feeds capitalize it, plain text.

Hype (R22) is distinct clusters times independent outlets over the last 24h: clusters
with at least one article in the window, times distinct syndication groups among
those articles. Eligibility (R16) mirrors app/static/js/ranker.js mustKnowEligible: a
hard-news topic tag, at least two independent sources, and lean buckets spanning at
least two.

Ids. The previous pool's events are matched to this run's by shared article ids (an
article id is a hash of its url, so it outlives the cluster id, which follows the
cluster's earliest member). A current event inherits the id of the previous event it
shares the most articles with; one that matches nothing gets e_<entity>, so the same
key entity maps to the same id even across a run where every article rotated out.

State machine, one Live slot (LIVE_SLOTS), decided here since S31 left it open:
- goes live: eligible, hype >= LIVE_HYPE_MIN, top hype among such events, and the
  slot is free. live_since records the moment, carried forward in the pool.
- holds: an incumbent that is still eligible but no longer tops the field stays live
  with hold_state holding until HOLD_FLOOR_HOURS after live_since (the 12h floor).
  Past the floor it stays live only on merit. Losing eligibility releases at once,
  since live requires eligible.
- released: shown for exactly the one run the incumbent loses the slot, then none.
  A released event re-enters only as a fresh challenger, with a new live_since.
- dissolved: an incumbent whose clusters are all gone has no event to emit (an event
  needs a cluster), so its state ends and the slot is free this same run.
"""
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone

from fetcher.cluster import CASED_WORD_RE, item_entities

WINDOW_HOURS = 48
HYPE_HOURS = 24
HOLD_FLOOR_HOURS = 12
LIVE_SLOTS = 1
LIVE_HYPE_MIN = 6
MIN_EVENT_CLUSTERS = 2
GENERIC_SHARE = 0.08
GENERIC_FLOOR = 12
LABEL_MAX = 200

PREVIOUS_EVENTS_STATUSES = ("ok", "absent", "old_schema")
_TS = "%Y-%m-%dT%H:%M:%SZ"
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")


def _epoch(ts):
    return datetime.strptime(ts, _TS).replace(tzinfo=timezone.utc).timestamp()


def _utc(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime(_TS)


def parse_previous_events(data):
    """Read the event state a previous pool carries: its generated_at, its events,
    and each of its clusters' article ids (for id matching). Never raises: missing
    bytes are absent, and anything unparseable or pre-S32 is old_schema, a clean start."""
    if not data:
        return None, "absent"
    try:
        doc = json.loads(data)
        generated = _epoch(doc["generated_at"])
        clusters = {c["id"]: set(c["article_ids"]) for c in doc["clusters"]}
        events = []
        for e in doc["events"]:
            live_since = e.get("live_since")
            events.append({
                "id": str(e["id"]),
                "cluster_ids": list(e["cluster_ids"]),
                "live": e["live"] is True,
                "live_since": _epoch(live_since) if live_since else None,
            })
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeDecodeError):
        return None, "old_schema"
    return {"generated_at": generated, "events": events, "clusters": clusters}, "ok"


def article_phrases(articles, source_names=()):
    """Each article's entity phrases, {id: set}. S07 entity words (item_entities) that
    sit next to each other in a title or dek join into one phrase, so "South Korea"
    and "North Korea" stay apart instead of both keying on "korea". A phrase that is a
    source's own name ("Politico", "Korea Herald") is never a key: feeds put them in their
    own copy, which would tie unrelated stories from one outlet together."""
    words = item_entities(articles)
    outlet = {" ".join(w.lower() for w in CASED_WORD_RE.findall(name)) for name in source_names}
    outlet |= {o[4:] for o in outlet if o.startswith("the ")}
    out = {}
    for a in articles:
        ents = words[a["id"]]
        phrases = set()
        for text in (a["title"], a.get("dek", "")[:600]):
            run, end = [], None
            for m in CASED_WORD_RE.finditer(text):
                k = m.group().lower()
                if k in ents and run and text[end:m.start()] == " ":
                    run.append(k)
                elif k == "new" and m.group() == "New":
                    if run:
                        phrases.add(" ".join(run))
                    run = ["new"]  # "New York", "New Delhi": a stopword, but kept as a prefix
                elif k in ents:
                    if run:
                        phrases.add(" ".join(run))
                    run = [k]
                else:
                    if run:
                        phrases.add(" ".join(run))
                    run = []
                end = m.end()
            if run:
                phrases.add(" ".join(run))
        phrases.discard("new")
        out[a["id"]] = phrases - outlet
    return out


def _key_entities(clusters, ents, article_count):
    df = Counter(e for s in ents.values() for e in s)
    limit = max(GENERIC_SHARE * article_count, GENERIC_FLOOR)
    generic = {e for e, n in df.items() if n > limit}
    keys = {}
    for cl in clusters:
        n = len(cl["article_ids"])
        need = max(2, math.ceil(n / 2))
        counts = Counter(e for aid in cl["article_ids"] for e in ents.get(aid, ()))
        keys[cl["id"]] = {e for e, c in counts.items() if c >= need and e not in generic}
    return keys


def group_clusters(clusters, articles, source_names=()):
    """Group published clusters into [(entity, [cluster ids])]. Pure and deterministic."""
    by_id = {a["id"]: a for a in articles}
    ents = article_phrases(articles, source_names)
    keys = _key_entities(clusters, ents, len(articles))
    newest = {cl["id"]: max(_epoch(by_id[a]["published_at"]) for a in cl["article_ids"])
              for cl in clusters}
    size = {cl["id"]: len(cl["article_ids"]) for cl in clusters}
    remaining = {cid for cid, k in keys.items() if k}
    window = WINDOW_HOURS * 3600
    groups = []
    while True:
        index = {}
        for cid in remaining:
            for e in keys[cid]:
                index.setdefault(e, []).append(cid)
        best = None
        for ent, cids in index.items():
            anchor = max(newest[c] for c in cids)
            kept = sorted(c for c in cids if anchor - newest[c] <= window)
            if len(kept) < MIN_EVENT_CLUSTERS:
                continue
            rank = (-len(kept), -sum(size[c] for c in kept), ent)
            if best is None or rank < best[0]:
                best = (rank, ent, kept)
        if best is None:
            return groups
        groups.append((best[1], best[2]))
        remaining -= set(best[2])


def _label(entity, article_list):
    """The phrase as the feeds capitalize it, most common form first. Plain text only."""
    pattern = re.compile(r"(?<![^\W_])" + r" ".join(re.escape(w) for w in entity.split(" "))
                         + r"(?![^\W_])", re.IGNORECASE)
    forms = Counter(m.group() for a in article_list for text in (a["title"], a.get("dek", ""))
                    for m in pattern.finditer(text))
    if not forms:
        return entity[:LABEL_MAX]
    return max(forms.items(), key=lambda kv: (kv[1], kv[0]))[0][:LABEL_MAX]


def _base_id(entity):
    slug = entity.replace(" ", "-")
    if _SLUG_RE.fullmatch(slug):
        return f"e_{slug}"
    return "e_" + hashlib.sha256(entity.encode("utf-8")).hexdigest()[:12]


def _assign_ids(events, previous):
    """Inherit the previous event id with the largest article overlap, else e_<entity>."""
    prev_articles = {}
    if previous:
        for pe in previous["events"]:
            prev_articles[pe["id"]] = set().union(
                *(previous["clusters"].get(c, set()) for c in pe["cluster_ids"]))
    pairs = sorted(
        (-len(e["_articles"] & arts), e["_entity"], pid)
        for e in events for pid, arts in prev_articles.items() if e["_articles"] & arts
    )
    taken, by_entity = set(), {e["_entity"]: e for e in events}
    for _, ent, pid in pairs:
        e = by_entity[ent]
        if "id" in e or pid in taken:
            continue
        e["id"] = pid
        taken.add(pid)
    for e in sorted(events, key=lambda e: e["_entity"]):
        if "id" in e:
            continue
        eid = _base_id(e["_entity"])
        if eid in taken:
            digest = hashlib.sha256("|".join(sorted(e["_cluster_ids"])).encode()).hexdigest()[:6]
            eid = f"{eid[:57]}-{digest}"
        e["id"] = eid
        taken.add(eid)


def _apply_hold(events, previous, now):
    """The Live slot state machine; see the module docstring."""
    prev = {pe["id"]: pe for pe in (previous or {}).get("events", ())}
    prev_generated = (previous or {}).get("generated_at", now)
    floor = HOLD_FLOOR_HOURS * 3600
    merit = sorted((e for e in events if e["eligible"] and e["hype"] >= LIVE_HYPE_MIN),
                   key=lambda e: (-e["hype"], e["id"]))
    on_merit = {e["id"] for e in merit[:LIVE_SLOTS]}
    for e in events:
        e["live"], e["hold_state"], e["_since"] = False, "none", None
    free = LIVE_SLOTS
    released = set()
    incumbents = sorted((e for e in events if prev.get(e["id"], {}).get("live")),
                        key=lambda e: (-e["hype"], e["id"]))
    for e in incumbents:
        since = prev[e["id"]]["live_since"] or prev_generated
        if free and e["eligible"] and e["id"] in on_merit:
            e["live"], e["_since"] = True, since
        elif free and e["eligible"] and now - since < floor:
            e["live"], e["hold_state"], e["_since"] = True, "holding", since
        else:
            e["hold_state"] = "released"
            released.add(e["id"])
            continue
        free -= 1
    for e in merit:
        if free and not e["live"] and e["id"] not in released:
            e["live"], e["_since"] = True, now
            free -= 1


def build_events(articles, clusters, sources, now, hard_news, previous=None):
    """This run's events list for pool.json. Pure: no network, no clock.

    previous is parse_previous_events' state (or None for a clean start); now is a
    datetime. Returns events sorted live first, then by hype, then by id."""
    now_s = now.timestamp()
    by_id = {a["id"]: a for a in articles}
    lean = {s["id"]: s["lean"] for s in sources if s.get("lean")}
    syndication = {s["id"]: s.get("syndication_group") or s["id"] for s in sources}
    cluster_by_id = {cl["id"]: cl for cl in clusters}
    cutoff = now_s - HYPE_HOURS * 3600
    events = []
    for entity, cids in group_clusters(clusters, articles, [s["name"] for s in sources]):
        members = [by_id[a] for c in cids for a in cluster_by_id[c]["article_ids"]]
        recent = [a for a in members if _epoch(a["published_at"]) >= cutoff]
        recent_ids = {a["id"] for a in recent}
        recent_clusters = sum(1 for c in cids if recent_ids & set(cluster_by_id[c]["article_ids"]))
        outlets = {syndication.get(a["source_id"], a["source_id"]) for a in recent}
        topics = {t for a in members for t in a.get("topics", ())}
        groups = {syndication.get(a["source_id"], a["source_id"]) for a in members}
        leans = {lean[a["source_id"]] for a in members if a["source_id"] in lean}
        events.append({
            "_entity": entity,
            "_cluster_ids": cids,
            "_articles": {a["id"] for a in members},
            "label": _label(entity, members),
            "cluster_ids": cids,
            "hype": recent_clusters * len(outlets),
            "eligible": bool(topics & set(hard_news)) and len(groups) >= 2 and len(leans) >= 2,
        })
    _assign_ids(events, previous)
    _apply_hold(events, previous, now_s)
    out = []
    for e in sorted(events, key=lambda e: (not e["live"], -e["hype"], e["id"])):
        entry = {
            "id": e["id"],
            "label": e["label"],
            "cluster_ids": e["cluster_ids"],
            "hype": e["hype"],
            "eligible": e["eligible"],
            "live": e["live"],
            "hold_state": e["hold_state"],
        }
        if e["live"]:
            entry["live_since"] = _utc(e["_since"])
        out.append(entry)
    return out
