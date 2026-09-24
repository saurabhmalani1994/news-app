"""S07: near-duplicate detection and story clustering. Standard library only (R30).

Two stages, computed locally from the run's own items, never imported (R8):

1. minhash: syndicated copies of one piece of copy. Word-bigram shingles of the
   headline plus the first words of the dek, a 96-permutation MinHash signature, LSH
   banding (32 bands of 3 rows) for candidate pairs, then the exact Jaccard of the
   shingle sets must reach NEAR_DUP_JACCARD. Feeds often carry one wire story under the
   same headline with a different dek, or none, so a second MinHash index over headline
   bigrams alone also counts, at the stricter TITLE_DUP_JACCARD and only for headlines of
   TITLE_DUP_MIN_WORDS or more. Near-duplicates are kept and marked, never
   dropped, so a later slice can count independent sources (R16).
2. cosine_entity: independently written coverage of the same event. TF-IDF vectors of
   headline and dek; a unit joins the cluster whose rolling centroid is most similar
   when cosine >= COSINE_MIN AND they share at least one key entity AND the unit is
   within WINDOW_HOURS of the cluster. Cosine alone false-merges; entity plus time alone
   merges unrelated stories about the same person, so both are required
   (research/ranking-and-clustering.md section 4).

A near-duplicate group moves as one unit through stage 2, so every article lands in at
most one cluster. Each cluster names the stages that built it in `method`.
"""
import hashlib
import math
import random
import re
from datetime import datetime, timezone

NEAR_DUP_JACCARD = 0.5
TITLE_DUP_JACCARD = 0.8
TITLE_DUP_MIN_WORDS = 6
NUM_PERM = 96
BANDS = 32
ROWS = NUM_PERM // BANDS
COSINE_MIN = 0.35
WINDOW_HOURS = 48
DEK_WORDS_DUP = 30
DEK_WORDS_VEC = 50
TITLE_WEIGHT = 2
PROPER_MIN = 0.8

METHODS = ("minhash", "cosine_entity", "minhash+cosine_entity")

WORD_RE = re.compile(r"[^\W_]+")
CASED_WORD_RE = re.compile(r"[^\W\d_][^\W_]*")
SUFFIX_RE = re.compile(r"\s+[-|\u2013\u2014:]\s+[^-|\u2013\u2014:]{1,40}$")
STOPWORDS = frozenset("""
a about after again against all also am an and any are as at be because been before
being between both but by can could did do does doing down during each few for from
further had has have having he her here hers him his how i if in into is it its itself
just me more most my no nor not now of off on once only or other our out over own s
same she should so some such than that the their them then there these they this those
through to too under until up very was we were what when where which while who whom why
will with would you your yours t ll ve re d m
says said say new news live latest update updates watch video report reports year years
day days week first last one two three get gets make makes back time amid
""".split())

_MASK64 = (1 << 64) - 1
_rng = random.Random(20260924)  # fixed seed: the same pool always clusters the same way
_PERM_MASKS = [_rng.getrandbits(64) for _ in range(NUM_PERM)]


def _epoch(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def _strip_suffix(title):
    # "Headline - Reuters" and "Headline | BBC" are the same copy as "Headline".
    return SUFFIX_RE.sub("", title)


def _bigrams(words):
    if len(words) < 2:
        return set(words)
    return {f"{a} {b}" for a, b in zip(words, words[1:])}


def _title_words(title):
    return WORD_RE.findall(_strip_suffix(title).lower())


def _h64(s):
    return int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "big")


def _signature(shingles):
    # XOR with a random 64-bit mask permutes the hash space; min under each mask is one
    # MinHash coordinate.
    hs = [_h64(s) for s in shingles] or [0]
    return [min([h ^ m for h in hs]) for m in _PERM_MASKS]


def _content_tokens(text, limit=None):
    toks = [t for t in WORD_RE.findall(text.lower()) if len(t) > 1 and t not in STOPWORDS]
    return toks[:limit] if limit else toks


class _UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def _lsh_candidates(shingle_sets, candidates):
    buckets = {}
    for i, sh in enumerate(shingle_sets):
        if not sh:
            continue
        sig = _signature(sh)
        for b in range(BANDS):
            buckets.setdefault((b, tuple(sig[b * ROWS:(b + 1) * ROWS])), []).append(i)
    for members in buckets.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                candidates.add((members[x], members[y]))


def _jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def near_duplicate_pairs(items, times):
    """Return sorted (i, j) index pairs that are copies of one piece of copy."""
    titles = [_title_words(it["title"]) for it in items]
    full = [_bigrams(t + WORD_RE.findall(it.get("dek", "").lower())[:DEK_WORDS_DUP])
            for t, it in zip(titles, items)]
    heads = [_bigrams(t) if len(t) >= TITLE_DUP_MIN_WORDS else set() for t in titles]
    candidates = set()
    _lsh_candidates(full, candidates)
    _lsh_candidates(heads, candidates)
    window = WINDOW_HOURS * 3600
    pairs = []
    for i, j in sorted(candidates):
        if abs(times[i] - times[j]) > window:
            continue
        if (_jaccard(full[i], full[j]) >= NEAR_DUP_JACCARD
                or _jaccard(heads[i], heads[j]) >= TITLE_DUP_JACCARD):
            pairs.append((i, j))
    return pairs


def _proper_ratios(items):
    """For each lowercased word, how often it is capitalized when it is not the first word
    of a sentence-case text. Title Case headlines are skipped: every word is capped there."""
    cap, low = {}, {}
    for it in items:
        for text in (it["title"], it.get("dek", "")):
            words = CASED_WORD_RE.findall(text)
            if len(words) < 3:
                continue
            content = [w for w in words if w.lower() not in STOPWORDS]
            if content and sum(w[0].isupper() for w in content) / len(content) >= 0.6:
                continue
            for w in words[1:]:
                k = w.lower()
                if w[0].isupper():
                    cap[k] = cap.get(k, 0) + 1
                else:
                    low[k] = low.get(k, 0) + 1
    return {k: c / (c + low.get(k, 0)) for k, c in cap.items()}


def _entities(item, proper):
    ents = set()
    for text in (item["title"], item.get("dek", "")[:600]):
        for w in CASED_WORD_RE.findall(text):
            k = w.lower()
            if k in STOPWORDS or len(k) < 2:
                continue
            if (w.isupper() and 2 <= len(w) <= 6) or (w[0].isupper() and proper.get(k, 0) >= PROPER_MIN):
                ents.add(k)
    return ents


def item_entities(items):
    """S32: each item's key entities, {id: set}, by the same rule clustering uses, so
    event grouping (fetcher.events) and clustering agree on what an entity is."""
    proper = _proper_ratios(items)
    return {it["id"]: _entities(it, proper) for it in items}


def _unit_vector(tf, idf):
    vec = {t: c * idf[t] for t, c in tf.items() if idf.get(t, 0) > 0}
    norm = math.sqrt(sum(v * v for v in vec.values()))
    return {t: v / norm for t, v in vec.items()} if norm else {}


def cluster_items(items):
    """Cluster article dicts (id, source_id, title, published_at, optional dek).

    Returns a list of clusters with 2+ articles, each {"article_ids", "method",
    "near_duplicates"}, where near_duplicates lists the minhash groups (2+ ids each).
    Pure and deterministic: the same items in the same order give the same clusters.
    """
    n = len(items)
    if n == 0:
        return []
    times = [_epoch(it["published_at"]) for it in items]

    uf = _UnionFind(n)
    for i, j in near_duplicate_pairs(items, times):
        uf.union(i, j)
    groups = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)

    tfs, df = [], {}
    for it in items:
        tf = {}
        for t in _content_tokens(_strip_suffix(it["title"])):
            tf[t] = tf.get(t, 0) + TITLE_WEIGHT
        for t in _content_tokens(it.get("dek", ""), DEK_WORDS_VEC):
            tf[t] = tf.get(t, 0) + 1
        tfs.append(tf)
        for t in tf:
            df[t] = df.get(t, 0) + 1
    # Smoothed idf, the sklearn default: every term keeps some weight, so a small run does
    # not let one-off words drown the words a story shares.
    idf = {t: math.log((1 + n) / (1 + d)) + 1 for t, d in df.items()}
    vecs = [_unit_vector(tf, idf) for tf in tfs]
    proper = _proper_ratios(items)
    ents = [_entities(it, proper) for it in items]

    units = sorted(groups.values(), key=lambda g: (min(times[i] for i in g), g[0]))
    window = WINDOW_HOURS * 3600
    clusters = []       # each: {"units": [...], "centroid": {}, "norm": f, "ents": set, "tmin", "tmax", "cos": bool}
    postings = {}       # token -> {cluster index: centroid weight}
    for members in units:
        uvec = {}
        for i in members:
            for t, v in vecs[i].items():
                uvec[t] = uvec.get(t, 0.0) + v
        unorm = math.sqrt(sum(v * v for v in uvec.values())) or 1.0
        uents = set().union(*(ents[i] for i in members))
        utime = min(times[i] for i in members)

        dots = {}
        for t, v in uvec.items():
            for c, w in postings.get(t, {}).items():
                dots[c] = dots.get(c, 0.0) + v * w
        best, best_cos = None, COSINE_MIN
        for c, dot in dots.items():
            cl = clusters[c]
            cos = dot / (unorm * cl["norm"])
            if cos < best_cos:
                continue
            if abs(utime - cl["tmax"]) > window and abs(utime - cl["tmin"]) > window:
                continue
            if not (uents & cl["ents"]):
                continue
            best, best_cos = c, cos

        if best is None:
            best = len(clusters)
            clusters.append({"units": [], "centroid": {}, "norm": 1.0, "ents": set(),
                             "tmin": utime, "tmax": utime})
        cl = clusters[best]
        cl["units"].append(members)
        for t, v in uvec.items():
            nv = cl["centroid"].get(t, 0.0) + v / unorm
            cl["centroid"][t] = nv
            postings.setdefault(t, {})[best] = nv
        cl["norm"] = math.sqrt(sum(v * v for v in cl["centroid"].values())) or 1.0
        cl["ents"] |= uents
        cl["tmin"] = min(cl["tmin"], utime)
        cl["tmax"] = max(cl["tmax"], max(times[i] for i in members))

    out = []
    for cl in clusters:
        idx = sorted(i for u in cl["units"] for i in u)
        if len(idx) < 2:
            continue
        dups = sorted(sorted(u) for u in cl["units"] if len(u) > 1)
        out.append({
            "article_ids": [items[i]["id"] for i in idx],
            "method": method_for(len(cl["units"]), bool(dups)),
            "near_duplicates": [[items[i]["id"] for i in u] for u in dups],
        })
    return out


def method_for(unit_count, has_near_dups):
    """Units inside one cluster are only ever joined by cosine_entity; articles inside one
    unit only by minhash. So the method follows from the cluster's shape."""
    if unit_count > 1 and has_near_dups:
        return "minhash+cosine_entity"
    return "cosine_entity" if unit_count > 1 else "minhash"
