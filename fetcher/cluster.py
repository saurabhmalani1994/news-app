"""S07, B2: near-duplicate detection and story clustering. Standard library only (R30).

Two stages, computed locally from the run's own items, never imported (R8):

1. minhash: syndicated copies of one piece of copy. Word-bigram shingles of the
   headline plus the first words of the dek, a 96-permutation MinHash signature, LSH
   banding (32 bands of 3 rows) for candidate pairs, then the exact Jaccard of the
   shingle sets must reach NEAR_DUP_JACCARD. Feeds often carry one wire story under the
   same headline with a different dek, or none, so a second MinHash index over headline
   bigrams alone also counts, at the stricter TITLE_DUP_JACCARD and only for headlines of
   TITLE_DUP_MIN_WORDS or more. Near-duplicates are kept and marked, never
   dropped, so a later slice can count independent sources (R16).
2. cosine_entity: independently written coverage of one story (B2, DESIGN-bundles
   section 2(a)), scored pair by pair, never against a rolling centroid, so nothing
   drifts and nothing depends on which article came first.
   - Features: a title word counts TITLE_WEIGHT times a dek word (the dek's first
     DEK_WORDS_VEC), adjacent title words also count as a bigram, and entities (words
     the run itself capitalizes, acronyms, numbers of 3+ digits, money amounts) weigh
     ENTITY_WEIGHT times more. Every feature is weighted by its rarity in the run
     (smoothed idf to the power IDF_POWER), so "Tigray" counts far more than "Trump".
     Demonyms fold to their country (geo.json `demonyms`), dotted acronyms join ("U.N."
     is "UN"), a plural s drops, and "197,000" is one number.
   - Pair score: the cosine of two articles' vectors times exp(-hours apart /
     DECAY_HOURS).
   - Blocking: keys are title words, title bigrams and entities. Only pairs inside
     STORY_SPAN_HOURS that share one key found in at most BLOCK_ONE_DF of the run's
     articles, or two found in at most block_df, are scored up front; any other pair
     is scored when its two clusters are compared.
   - Average link: from the near-duplicate units up, the two clusters with the highest
     average link merge while it reaches LINK_MIN, or RARE_LINK_MIN when they share an
     entity rare outside them (RARE_SHARE or more of the run's articles naming it sit
     in the two). The link averages cross-outlet pairs only, so a story needs two
     outlets and one outlet's pieces join only through another outlet's. A merge that
     would stretch a story past STORY_SPAN_HOURS is refused.
   - Merge pass: then clusters that share a headline word of any rarity merge on the
     same rule at MERGE_LINK_MIN, which rejoins a story split because its versions
     share only common words.
   Stories are the parts of S32's events: fetcher.events groups these clusters into
   events, so every story sits inside at most one event.

A near-duplicate group moves as one unit through stage 2, so every article lands in at
most one cluster. A cluster needs articles from two outlets: one outlet's own copies
alone are not a story. Each cluster names the stages that built it in `method`.
"""
import hashlib
import heapq
import json
import math
import random
import re
from datetime import datetime, timezone
from pathlib import Path

NEAR_DUP_JACCARD = 0.5
TITLE_DUP_JACCARD = 0.8
TITLE_DUP_MIN_WORDS = 6
NUM_PERM = 96
BANDS = 32
ROWS = NUM_PERM // BANDS
WINDOW_HOURS = 48
DEK_WORDS_DUP = 30
DEK_WORDS_VEC = 50
TITLE_WEIGHT = 2
PROPER_MIN = 0.8

# B2 story stage (DESIGN-bundles section 2(a)), tuned on tests/fixtures/bundles/.
LINK_MIN = 0.41
MERGE_LINK_MIN = 0.36
RARE_LINK_MIN = 0.27
RARE_SHARE = 0.5
DECAY_HOURS = 24
STORY_SPAN_HOURS = 36
BIGRAM_WEIGHT = 1
ENTITY_WEIGHT = 1.5
BLOCK_DF_SHARE = 0.01
BLOCK_DF_MIN = 25
BLOCK_ONE_DF = 10
NUMBER_MIN_DIGITS = 3
IDF_PLUS = 1.0
IDF_POWER = 0.75
GEO_PATH = Path(__file__).resolve().parent.parent / "geo.json"

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
    return [min(map(m.__xor__, hs)) for m in _PERM_MASKS]


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


def _plural(word):
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def _load_demonyms(path=GEO_PATH):
    """geo.json `demonyms`: {folded word: country} and a pattern for its phrases."""
    block = json.loads(Path(path).read_text(encoding="utf-8")).get("demonyms", {})
    words = {_plural(k.lower()): _plural(v.lower()) for k, v in block.get("map", {}).items()}
    phrases = {k.lower(): v.lower() for k, v in block.get("phrases", {}).items()}
    alts = "|".join(re.escape(k) for k in sorted(phrases, key=lambda k: (-len(k), k)))
    pattern = re.compile(rf"(?<![^\W_])(?:{alts})(?![^\W_])") if phrases else None
    return words, phrases, pattern


DEMONYMS, PHRASES, PHRASE_RE = _load_demonyms()
PHRASE_HEADS = frozenset(k.split()[0] for k in PHRASES)
# Words that say when or how a piece is packaged, not what happened: every same-day
# article shares them. The story stage drops them; S32 keeps reading STOPWORDS alone.
STORY_STOPWORDS = STOPWORDS | frozenset("""
monday tuesday wednesday thursday friday saturday sunday today tonight yesterday tomorrow
morning evening weekend know thing things key highlight highlights explained explainer
analysis opinion column editorial podcast newsletter briefing wrap roundup here what's
""".split())

DOTTED_RE = re.compile(r"(?<![^\W\d_])((?:[A-Za-z]\.){2,})")
THOUSANDS_RE = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")
MONEY_RE = re.compile(
    r"(?<![^\W_])(?:[A-Z]{1,2})?[$\u00a3\u20ac\u00a5\u20b9]\s?(\d+(?:\.\d+)?)"
    r"(?:\s?(?i:(trillion|tn|billion|bn|million|mn|m|b|thousand|k)))?(?![^\W_])")
SCALED_RE = re.compile(r"(?<![^\W_])(\d+(?:\.\d+)?)\s(?i:(trillion|billion|million))(?![^\W_])")
CURRENCY_MARKS = "$\u00a3\u20ac\u00a5\u20b9"
SCALES = {"trillion": 1e12, "tn": 1e12, "billion": 1e9, "bn": 1e9, "b": 1e9, "million": 1e6,
          "mn": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}
OUTLET_NAME = r"[A-Z0-9][\w.&'\u2019]*"
OUTLET_WORD = rf"(?:{OUTLET_NAME}|of|the|and|for|on|in)"
OUTLET_SUFFIX_RE = re.compile(
    rf"\s+[-|\u2013\u2014]\s+({OUTLET_NAME}(?:\s+{OUTLET_WORD}){{0,5}})\s*$")


def _prep(text):
    """Join dotted acronyms and thousands separators, so "U.N." is one word and
    "197,000" one number."""
    text = text or ""
    if "." in text:
        text = DOTTED_RE.sub(lambda m: m.group(1).replace(".", ""), text)
    return THOUSANDS_RE.sub("", text) if "," in text else text


def _amounts(text):
    """Money amounts and scaled numbers as tokens, and the text with them taken out."""
    found = []

    def money(m):
        value = float(m.group(1)) * SCALES.get((m.group(2) or "").lower(), 1)
        found.append(f"${value:.3g}")
        return " "

    def scaled(m):
        found.append(f"#{float(m.group(1)) * SCALES[m.group(2).lower()]:.3g}")
        return " "

    if any(c in text for c in CURRENCY_MARKS):
        text = MONEY_RE.sub(money, text)
    if "illion" in text:
        text = SCALED_RE.sub(scaled, text)
    return found, text


_FOLDED = {}


def _fold(word):
    got = _FOLDED.get(word)
    if got is None:
        got = _plural(word)
        got = _FOLDED[word] = DEMONYMS.get(got, got)
    return got


def _words(text):
    """Content words, folded; numbers only with NUMBER_MIN_DIGITS or more digits."""
    text = text.lower()
    if PHRASE_RE is not None and any(h in text for h in PHRASE_HEADS):
        text = PHRASE_RE.sub(lambda m: PHRASES[m.group()], text)
    out = []
    for w in WORD_RE.findall(text):
        if w.isdigit():
            if len(w) >= NUMBER_MIN_DIGITS:
                out.append(w)
            continue
        if len(w) < 2 or w in STORY_STOPWORDS:
            continue
        f = _fold(w)
        if f not in STORY_STOPWORDS:
            out.append(f)
    return out


def _strip_outlet(title):
    """"Headline - The Indian Express" is the headline; a lower-case tail is kept."""
    return OUTLET_SUFFIX_RE.sub("", title)


def _features(items):
    """Per item: (tf dict, entity set, blocking keys, headline words). Titles and deks
    go through the same normalizer, so a word folds the same way wherever it appears."""
    prepped = [{"title": _prep(_strip_outlet(it["title"])), "dek": _prep(it.get("dek", "")[:600])}
               for it in items]
    proper = _proper_ratios(prepped)
    out = []
    for it in prepped:
        t_money, title = _amounts(it["title"])
        d_money, dek = _amounts(it["dek"])
        t_words = _words(title)
        d_words = _words(dek)[:DEK_WORDS_VEC]
        tf = {}
        for w in t_words + t_money:
            tf[w] = tf.get(w, 0) + TITLE_WEIGHT
        bigrams = [f"{a} {b}" for a, b in zip(t_words, t_words[1:])]
        for b in bigrams:
            tf[b] = tf.get(b, 0) + BIGRAM_WEIGHT
        for w in d_words + d_money:
            tf[w] = tf.get(w, 0) + 1
        ents = {_fold(e) for e in _entities(it, proper)} | set(PHRASES.values())
        ents |= {w for w in t_words + d_words if w.isdigit()} | set(t_money) | set(d_money)
        ents &= set(tf)
        keys = set(t_words) | set(bigrams) | set(t_money) | ents
        out.append((tf, ents, keys, set(t_words)))
    return out


def _vectors(feats, n):
    df = {}
    for tf, _, _, _ in feats:
        for t in tf:
            df[t] = df.get(t, 0) + 1
    # Smoothed idf (the sklearn default), damped by IDF_POWER: every term keeps some
    # weight, a term's weight grows with its rarity in this run, and one big event's
    # names ("Xi", "Netanyahu") are not discounted to nothing on a busy day.
    idf = {t: (math.log((1 + n) / (1 + d)) + IDF_PLUS) ** IDF_POWER for t, d in df.items()}
    vecs = []
    for tf, ents, _, _ in feats:
        vec = {t: c * idf[t] * (ENTITY_WEIGHT if t in ents else 1) for t, c in tf.items()}
        norm = math.sqrt(sum(v * v for v in vec.values()))
        vecs.append({t: v / norm for t, v in vec.items()} if norm else {})
    return vecs, df


class _Stories:
    """Average-link agglomeration over article pairs, cross-outlet pairs only."""

    def __init__(self, vecs, times, sources, ents, df):
        self.vecs, self.times, self.sources, self.ents, self.df = vecs, times, sources, ents, df
        self.cache = {}
        self.span = STORY_SPAN_HOURS * 3600

    def score(self, i, j):
        if i > j:
            i, j = j, i
        got = self.cache.get((i, j))
        if got is None:
            dt = abs(self.times[i] - self.times[j])
            got = 0.0
            if dt <= self.span:
                a, b = self.vecs[i], self.vecs[j]
                if len(a) > len(b):
                    a, b = b, a
                # Summed in a's own term order, never a set's, so every process adds the
                # same floats in the same order and a tie never flips between runs.
                dot = sum(v * b[t] for t, v in a.items() if t in b)
                got = dot * math.exp(-dt / (DECAY_HOURS * 3600))
            self.cache[(i, j)] = got
        return got

    def link(self, xs, ys):
        total, count = 0.0, 0
        src = self.sources
        for x in xs:
            for y in ys:
                if src[x] != src[y]:
                    total += self.score(x, y)
                    count += 1
        return total / count if count else 0.0

    def agglomerate(self, members, neighbors, threshold, rare_threshold):
        """members: {cluster id: [article index]}; neighbors: {id: set of ids}. Merges in
        place, best average link first, while it reaches threshold, or rare_threshold
        for two clusters that share an entity rare outside them: at least RARE_SHARE of
        the run's articles naming it sit in the two."""
        times, df = self.times, self.df
        tmin = {c: min(times[i] for i in m) for c, m in members.items()}
        tmax = {c: max(times[i] for i in m) for c, m in members.items()}
        ecount = {}
        for c, m in members.items():
            cnt = ecount[c] = {}
            for i in m:
                for e in self.ents[i]:
                    cnt[e] = cnt.get(e, 0) + 1
        version = {c: 0 for c in members}
        heap = []

        def push(a, b):
            if a > b:
                a, b = b, a
            if max(tmax[a], tmax[b]) - min(tmin[a], tmin[b]) > self.span:
                return
            s = self.link(members[a], members[b])
            if s < rare_threshold:
                return
            ca, cb = ecount[a], ecount[b]
            if len(ca) > len(cb):
                ca, cb = cb, ca
            if s >= threshold or any(e in cb and ca[e] + cb[e] >= RARE_SHARE * df[e] for e in ca):
                heapq.heappush(heap, (-s, a, b, version[a], version[b]))

        for a in sorted(neighbors):
            for b in sorted(neighbors[a]):
                if a < b:
                    push(a, b)
        while heap:
            _, a, b, va, vb = heapq.heappop(heap)
            if a not in members or b not in members or version[a] != va or version[b] != vb:
                continue
            members[a] = members[a] + members.pop(b)
            tmin[a], tmax[a] = min(tmin[a], tmin.pop(b)), max(tmax[a], tmax.pop(b))
            ca = ecount[a]
            for e, k in ecount.pop(b).items():
                ca[e] = ca.get(e, 0) + k
            version[a] += 1
            del version[b]
            joined = (neighbors.get(a, set()) | neighbors.pop(b, set())) - {a, b}
            neighbors[a] = joined
            for c in joined:
                neighbors[c].discard(b)
                neighbors[c].add(a)
            for c in sorted(joined):
                push(a, c)
        return members


def _headline_words(members, title_words):
    """Words in at least half of a cluster's headlines: its merge-pass keys."""
    counts = {}
    for i in members:
        for w in title_words[i]:
            counts[w] = counts.get(w, 0) + 1
    need = len(members) / 2
    return {w for w, c in counts.items() if c >= need}


def cluster_items(items):
    """Cluster article dicts (id, source_id, title, published_at, optional dek).

    Returns a list of clusters with articles from 2+ outlets, each {"article_ids",
    "method", "near_duplicates"}, where near_duplicates lists the minhash groups (2+ ids
    each). Pure and deterministic, and the input order never matters: articles are
    taken in (published_at, id) order.
    """
    if not items:
        return []
    items = sorted(items, key=lambda it: (it["published_at"], it["id"]))
    n = len(items)
    times = [_epoch(it["published_at"]) for it in items]
    sources = [it["source_id"] for it in items]

    uf = _UnionFind(n)
    for i, j in near_duplicate_pairs(items, times):
        uf.union(i, j)
    units = {}
    for i in range(n):
        units.setdefault(uf.find(i), []).append(i)
    unit_of = {i: u for u, m in units.items() for i in m}

    feats = _features(items)
    vecs, df = _vectors(feats, n)
    stories = _Stories(vecs, times, sources, [f[1] for f in feats], df)
    span = STORY_SPAN_HOURS * 3600

    # Blocking: pairs inside the span that share one very rare key (df <= BLOCK_ONE_DF)
    # or two rare ones (df <= block_df).
    block_df = max(BLOCK_DF_MIN, int(BLOCK_DF_SHARE * n))
    postings = {}
    for i, (_, _, keys, _) in enumerate(feats):
        for k in keys:
            if df[k] <= block_df:
                postings.setdefault(k, []).append(i)
    pairs, seen = set(), set()
    for k, idx in postings.items():
        one = df[k] <= BLOCK_ONE_DF
        for x, i in enumerate(idx):
            for j in idx[x + 1:]:
                if times[j] - times[i] > span:
                    break
                if sources[i] == sources[j] or unit_of[i] == unit_of[j]:
                    continue
                if one or (i, j) in seen:
                    pairs.add((i, j))
                else:
                    seen.add((i, j))
    neighbors = {u: set() for u in units}
    for i, j in sorted(pairs):
        if stories.score(i, j) >= min(LINK_MIN, RARE_LINK_MIN):
            a, b = unit_of[i], unit_of[j]
            neighbors[a].add(b)
            neighbors[b].add(a)
    members = stories.agglomerate(dict(units), neighbors, LINK_MIN, RARE_LINK_MIN)

    # Merge pass: clusters of 2+ articles sharing a headline word of any rarity.
    title_words = [f[3] for f in feats]
    multi = sorted(c for c, m in members.items() if len(m) > 1)
    by_word = {}
    for c in multi:
        for w in _headline_words(members[c], title_words):
            by_word.setdefault(w, []).append(c)
    neighbors = {c: set() for c in multi}
    for cs in by_word.values():
        for x, a in enumerate(cs):
            for b in cs[x + 1:]:
                neighbors[a].add(b)
                neighbors[b].add(a)
    merged = stories.agglomerate({c: members[c] for c in multi}, neighbors, MERGE_LINK_MIN,
                                 min(MERGE_LINK_MIN, RARE_LINK_MIN))

    out = []
    for c in sorted(merged, key=lambda c: min(merged[c])):
        idx = sorted(merged[c])
        if len({sources[i] for i in idx}) < 2:
            continue
        cluster_units = sorted({unit_of[i] for i in idx})
        dups = sorted(sorted(units[u]) for u in cluster_units if len(units[u]) > 1)
        out.append({
            "article_ids": [items[i]["id"] for i in idx],
            "method": method_for(len(cluster_units), bool(dups)),
            "near_duplicates": [[items[i]["id"] for i in u] for u in dups],
        })
    return out


def method_for(unit_count, has_near_dups):
    """Units inside one cluster are only ever joined by cosine_entity; articles inside one
    unit only by minhash. So the method follows from the cluster's shape."""
    if unit_count > 1 and has_near_dups:
        return "minhash+cosine_entity"
    return "cosine_entity" if unit_count > 1 else "minhash"
