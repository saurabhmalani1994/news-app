"""B11: the work watch, the pipeline side of the owner's private tiered keyword rules
(app/static/js/work-watch.js on the phone). Standard library only (R30).

The phone keeps each rule, {id, label, tier 1 to 4, terms, pair_any, exclude, exact},
in its profile and sends it, without its label, inside the same Workers KV value its
phrase searches use (W1): {"v":2,"queries":[...],"work":[{id, tag, tier, terms,
pair_any, exclude, exact}]}. Every hourly run:

1. union_rules keeps each well formed rule whose tag is "w:" plus the first 10 hex of
   SHA-256 of "work:<id>" (fetcher.watch.tag_for), deduplicated by tag, capped.
2. rule_queries turns a rule into Google News searches: its terms quoted and joined
   with OR, split so no query passes MAX_Q_CHARS, with its pair_any terms as one
   required group and its excludes as -"x" where they fit. Tier 1 and 2 rules search
   every run; tier 3 and 4 (market news, patents and papers, which move on a scale of
   days) only when the run's UTC hour is a multiple of SLOW_EVERY, so eight times a
   day. Every search asks for the last 3 days, so a 3 hour gap loses nothing, and the
   slow tiers cost a third of the requests. At most MAX_QUERIES searches a run.
3. fetcher.fanout keeps a result only when rule_matches passes on its own headline and
   dek (Google matches article bodies and stems words, so its hits are checked here),
   and tags every other candidate in the pool that passes too: the same test the
   phone runs (R2 parity, tests/fixtures/work_watch_parity.json). Work items publish
   inside their own byte budget, BUDGET_BYTES, apart from the phrase watches' 60 KB.

Privacy (the repo and its Actions logs and artifacts are public): a rule's terms leave
this module only inside the Google News request URL. The pool carries only the rule's
hashed tag; the log line and counts carry numbers only; no exception text is printed.
"""
import re
import unicodedata
from collections import Counter

from fetcher.watch import TAG_RE, fetch_searches, tag_for

MAX_RULES = 60
MAX_RULES_PER_VALUE = 40
MAX_TERMS = 30
MAX_PAIR = 20
MAX_EXCLUDE = 20
MAX_TERM_CHARS = 60
MAX_Q_CHARS = 240
MAX_SUFFIX_CHARS = 120
MAX_QUERIES = 40
SLOW_EVERY = 3
TIERS = (1, 2, 3, 4)
BUDGET_BYTES = 40_000
ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")

RULE_DROP_KEYS = ("bad_rule", "bad_tag", "over_value_cap", "duplicate", "over_cap")

_POSSESSIVE = re.compile(r"['’]s(?![^\W_])")
_POSSESSIVE_ANY_CASE = re.compile(r"['’][sS](?![^\W_])")
_APOSTROPHE = re.compile(r"['’]")
_WORD = re.compile(r"[^\W_]+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


# --- matching (work-watch.js's twin) ------------------------------------------------

def _plain(text):
    return "".join(ch for ch in unicodedata.normalize("NFKD", str(text or ""))
                   if not unicodedata.category(ch).startswith("M"))


def fold_word(word):
    """phrase.js foldWord: a plural s dropped (not ss), then a final ie read as y."""
    one = word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word
    return one[:-2] + "y" if len(one) > 3 and one.endswith("ie") else one


def text_words(text):
    """phrase.js textWords: accents stripped, lowercased, "'s" dropped, apostrophes
    joined, every other non-letter, non-digit run a boundary, plurals folded."""
    plain = _APOSTROPHE.sub("", _POSSESSIVE.sub("", _plain(text).lower()))
    return [fold_word(w) for w in _WORD.findall(plain)]


def exact_words(text):
    """work-watch.js exactWords: the same words with their capitals kept, unfolded."""
    plain = _APOSTROPHE.sub("", _POSSESSIVE_ANY_CASE.sub("", _plain(text)))
    return _WORD.findall(plain)


def contains_words(hay, needle):
    n = len(needle)
    if not n or n > len(hay):
        return False
    return any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def _clean_term(term):
    return " ".join(re.sub(r"[\"“”]", " ", str(term or "")).split())


def _word_lists(terms, keep_case):
    split = exact_words if keep_case else text_words
    return [w for w in (split(_clean_term(t)) for t in terms or ()) if w]


def _any_in(texts, needles):
    return any(contains_words(words, n) for n in needles for words in texts)


def rule_matches(rule, texts):
    """Whether texts (headline, dek...) match a rule: a term (exact rules: its own
    capitals, no plural folding), one pair_any term when there are any, no exclude."""
    exact = rule.get("exact") is True
    terms = _word_lists(rule.get("terms"), exact)
    if not terms:
        return False
    strings = [str(t or "") for t in texts]
    folded = [text_words(t) for t in strings]
    if not _any_in([exact_words(t) for t in strings] if exact else folded, terms):
        return False
    pair = _word_lists(rule.get("pair_any"), False)
    if pair and not _any_in(folded, pair):
        return False
    return not _any_in(folded, _word_lists(rule.get("exclude"), False))


def work_tag(rule_id):
    return tag_for(f"work:{rule_id}")


# --- rules from the KV values ----------------------------------------------------------

def _terms_ok(value, low, high):
    return (isinstance(value, list) and low <= len(value) <= high
            and all(isinstance(t, str) and 2 <= len(t) <= MAX_TERM_CHARS and not _CONTROL.search(t)
                    and '"' not in t for t in value))


def _rule_ok(rule):
    return (isinstance(rule, dict) and isinstance(rule.get("id"), str) and ID_RE.match(rule["id"])
            and rule.get("tier") in TIERS and not isinstance(rule.get("tier"), bool)
            and _terms_ok(rule.get("terms"), 1, MAX_TERMS)
            and _terms_ok(rule.get("pair_any", []), 0, MAX_PAIR)
            and _terms_ok(rule.get("exclude", []), 0, MAX_EXCLUDE)
            and isinstance(rule.get("exact", False), bool))


def union_rules(values):
    """Every user's work rules, one list: [{id, tag, tier, terms, pair_any, exclude,
    exact}] and a Counter of drops (RULE_DROP_KEYS). Users interleave under the cap."""
    drops = Counter()
    per_user = []
    for value in values:
        if not (isinstance(value, dict) and value.get("v") == 2 and isinstance(value.get("work"), list)):
            continue
        entries = value["work"]
        if len(entries) > MAX_RULES_PER_VALUE:
            drops["over_value_cap"] += len(entries) - MAX_RULES_PER_VALUE
            entries = entries[:MAX_RULES_PER_VALUE]
        good = []
        for rule in entries:
            if not _rule_ok(rule):
                drops["bad_rule"] += 1
                continue
            tag = rule.get("tag")
            if not isinstance(tag, str) or not TAG_RE.match(tag) or tag != work_tag(rule["id"]):
                drops["bad_tag"] += 1
                continue
            good.append({"id": rule["id"], "tag": tag, "tier": rule["tier"], "terms": list(rule["terms"]),
                         "pair_any": list(rule.get("pair_any", [])), "exclude": list(rule.get("exclude", [])),
                         "exact": rule.get("exact", False)})
        per_user.append(good)
    out, seen = [], set()
    for i in range(max((len(u) for u in per_user), default=0)):
        for user in per_user:
            if i >= len(user):
                continue
            rule = user[i]
            if rule["tag"] in seen:
                drops["duplicate"] += 1
            elif len(out) >= MAX_RULES:
                drops["over_cap"] += 1
            else:
                seen.add(rule["tag"])
                out.append(rule)
    return out, drops


# --- searches ----------------------------------------------------------------------------

def _quoted(terms):
    out, seen = [], set()
    for t in terms:
        clean = _clean_term(t)
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            out.append(f'"{clean}"')
    return out


def rule_queries(rule):
    """A rule's Google News queries: its terms OR-joined, as few queries as fit
    MAX_Q_CHARS, each with the pair group (all of it, or none when it does not fit
    MAX_SUFFIX_CHARS: the local check still applies it) and the excludes that fit."""
    suffix = ""
    pair = _quoted(rule.get("pair_any", ()))
    if pair:
        group = f" ({' OR '.join(pair)})"
        if len(group) <= MAX_SUFFIX_CHARS:
            suffix = group
    for ex in _quoted(rule.get("exclude", ())):
        if len(suffix) + len(ex) + 2 <= MAX_SUFFIX_CHARS:
            suffix += f" -{ex}"
    room = MAX_Q_CHARS - len(suffix)
    queries, body = [], ""
    for term in _quoted(rule.get("terms", ())):
        if len(term) > room:
            continue
        joined = f"{body} OR {term}" if body else term
        if len(joined) > room:
            queries.append(body + suffix)
            joined = term
        body = joined
    if body:
        queries.append(body + suffix)
    return queries


def due(tier, now):
    """Tier 1 and 2 search every run; tier 3 and 4 when the UTC hour is a multiple of
    SLOW_EVERY."""
    return tier <= 2 or now.hour % SLOW_EVERY == 0


def plan(rules, now):
    """(queries [{q, tag, tier}] strongest tier first, rules deferred by cadence, queries
    over MAX_QUERIES)."""
    queries, deferred, over = [], 0, 0
    for rule in sorted(rules, key=lambda r: r["tier"]):
        if not due(rule["tier"], now):
            deferred += 1
            continue
        for q in rule_queries(rule):
            if len(queries) >= MAX_QUERIES:
                over += 1
            else:
                queries.append({"q": q, "tag": rule["tag"], "tier": rule["tier"]})
    return queries, deferred, over


def collect_work(values, now, fetch_fn, timeout, retries):
    """The work part of fetcher.watch.collect: rules, counts and one result per search.
    The rules stay in memory for the pool build's matching; results carry tags only."""
    rules, drops = union_rules(values)
    queries, deferred, over = plan(rules, now)
    results = fetch_searches([{"q": q["q"], "tag": q["tag"]} for q in queries], fetch_fn, timeout, retries)
    return {"rules": rules, "queries": len(queries), "deferred": deferred, "over_cap_queries": over,
            "rule_drops": dict(drops), "results": results}


def empty_work():
    return {"rules": [], "queries": 0, "deferred": 0, "over_cap_queries": 0, "rule_drops": {}, "results": []}
