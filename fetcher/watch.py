"""W2 (R50): watch searches, the pipeline side of free-text interests and standing
stories. Standard library only (R30).

The phone (W1) keeps each user's followed phrases and standing-story keywords in the
Workers KV namespace titled almanac-interests, one key per user, each value
{"v":1,"queries":[{"q":"...","tag":"w:<10 hex>"}]}. Every run:

1. read_interests lists the namespace's keys and reads every value through the
   Cloudflare REST API, trying each token in TOKEN_ENV_NAMES that is set until one
   can list namespaces. No token, no namespace, a 403 or any other failure degrades
   to zero queries with a one-word status; it never fails the run.
2. union_queries interleaves the users' lists (everyone's first query, then
   everyone's second...), drops any entry whose tag is not "w:" plus the first 10 hex
   of SHA-256 of its normalized q, dedupes by tag and keeps at most MAX_QUERIES.
3. fetch_searches asks Google News search RSS for each query (last 3 days), a few at
   a time, with the fetcher's timeout and one retry.
4. watch_items (pure) extracts each result feed with F3's Google News rules
   (fetcher.fanout._extract_article), keeps the newest ITEMS_PER_QUERY within
   WINDOW, tags each item with its query's tag in `watch`, and folds an item found by
   two queries into one carrying both tags. fanout.build_pool_fanout then merges
   items that are already in the pool into that article's `watch` and budgets the
   rest (BUDGET_BYTES), exempt from the per-source cap.

An item keeps the real outlet as its source when the outlet is a configured source
(matched by domain or by name, F3's rule that a Google News item is never credited to
Google when the outlet is known); any other outlet is credited to one extra pool
source, SOURCE ("Google News"), added only on runs that searched.

Privacy (the repo and its Actions logs are public): a query string never leaves this
module except inside the Google News request URL. It is never in pool.json (articles
carry only the hashed tag), never in a returned structure past fetch_searches, never
in a log line, and no exception text from this module is ever printed. Logs carry
counts and statuses only.
"""
import concurrent.futures
import hashlib
import json
import os
import re
import socket
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from datetime import timedelta
from urllib.parse import quote, unquote, urlencode, urlsplit

from fetcher.fetch import USER_AGENT, FeedError, _clean, _utc, iter_feed_items, parse_xml
from fetcher.geo import tag_geo
from fetcher.topics import tag_article

NAMESPACE_TITLE = "almanac-interests"
CF_API_BASE = "https://api.cloudflare.com/client/v4"
# Tried in this order; the first that can list the account's namespaces is used.
# publish.yml passes only CF_PIPELINE_TOKEN (the repo secret CLOUDFLARE_PIPELINE_TOKEN,
# Workers KV Storage Edit); the other two names serve a local run.
TOKEN_ENV_NAMES = ("CF_PIPELINE_TOKEN", "CLOUDFLARE_WORKERS_TOKEN", "CLOUDFLARE_API_TOKEN")
ACCOUNT_ENV_NAMES = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNTID")
KV_TIMEOUT = 12
KV_MAX_BYTES = 2_000_000
MAX_KEYS = 200

MAX_QUERIES_PER_VALUE = 25
MAX_Q_CHARS = 100
MAX_QUERIES = 60
ITEMS_PER_QUERY = 10
WINDOW = timedelta(days=3)
BUDGET_BYTES = 60_000
WATCH_WORKERS = 4  # one host (news.google.com), so a few at a time, not the fanout's 32
RETRY_PAUSE = 1.0  # seconds before the one retry after a 429 or 5xx

TAG_RE = re.compile(r"^w:[0-9a-f]{10}$")
SEARCH_BASE = "https://news.google.com/rss/search"
SOURCE = {"id": "google_news_search", "name": "Google News", "feed_url": SEARCH_BASE}

QUERY_DROP_KEYS = ("bad_value", "bad_query", "bad_tag", "over_value_cap", "duplicate", "over_cap")
ITEM_DROP_KEYS = ("no_title", "bad_url", "no_date", "stale", "over_query_cap", "duplicate")

# Feed hosts shared by unrelated publishers: a match on one of these says nothing
# about which outlet an item came from.
SHARED_HOSTS = frozenset({
    "feedburner.com", "google.com", "substack.com", "medium.com", "workers.dev",
    "blogspot.com", "wordpress.com", "rss.app", "feedblitz.com",
})
_SECOND_LEVEL = frozenset({"co", "com", "org", "net", "gov", "ac", "edu", "or", "ne"})
_SITE_RE = re.compile(r"site:([A-Za-z0-9.-]+)")
_TRACKING_PARAMS = ("utm_", "oc=", "ocid=", "cmpid=", "smid=", "fbclid=", "gclid=", "ref=")
TITLE_KEY_MIN_CHARS = 20
TITLE_KEY_MIN_WORDS = 3


# --- queries -------------------------------------------------------------------

def normalize(q):
    """Trimmed, lowercased, whitespace runs collapsed to one space. The phone's
    equivalent: q.trim().toLowerCase().replace(/\\s+/g, " ")."""
    return " ".join(q.strip().lower().split())


def tag_for(q):
    return "w:" + hashlib.sha256(normalize(q).encode("utf-8")).hexdigest()[:10]


def union_queries(values):
    """Every user's value in, one deduplicated query list out: [{"q", "tag"}], plus a
    Counter of what was dropped and why (QUERY_DROP_KEYS). Users are interleaved so
    the MAX_QUERIES cap falls evenly rather than on whoever's key sorts last."""
    drops = Counter()
    per_user = []
    for value in values:
        if not (isinstance(value, dict) and value.get("v") == 1
                and isinstance(value.get("queries"), list)):
            drops["bad_value"] += 1
            continue
        entries = value["queries"]
        if len(entries) > MAX_QUERIES_PER_VALUE:
            drops["over_value_cap"] += len(entries) - MAX_QUERIES_PER_VALUE
            entries = entries[:MAX_QUERIES_PER_VALUE]
        good = []
        for entry in entries:
            q = entry.get("q") if isinstance(entry, dict) else None
            tag = entry.get("tag") if isinstance(entry, dict) else None
            if (not isinstance(q, str) or not isinstance(tag, str) or not normalize(q)
                    or len(q) > MAX_Q_CHARS):
                drops["bad_query"] += 1
                continue
            if not TAG_RE.match(tag) or tag != tag_for(q):
                drops["bad_tag"] += 1
                continue
            good.append({"q": " ".join(q.split()), "tag": tag})
        per_user.append(good)
    out, seen = [], set()
    for i in range(max((len(u) for u in per_user), default=0)):
        for user in per_user:
            if i >= len(user):
                continue
            query = user[i]
            if query["tag"] in seen:
                drops["duplicate"] += 1
            elif len(out) >= MAX_QUERIES:
                drops["over_cap"] += 1
            else:
                seen.add(query["tag"])
                out.append(query)
    return out, drops


# --- Workers KV ----------------------------------------------------------------

class KVError(Exception):
    """Carries a short status only (http_403, timeout...), never a response body."""

    def __init__(self, status):
        super().__init__(status)
        self.status = status


def _http_get(url, token, timeout=KV_TIMEOUT):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "User-Agent": USER_AGENT, "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(KV_MAX_BYTES)


def _get(http_get, url, token):
    try:
        return http_get(url, token, KV_TIMEOUT)
    except urllib.error.HTTPError as exc:
        raise KVError(f"http_{exc.code}") from None
    except (socket.timeout, TimeoutError):
        raise KVError("timeout") from None
    except urllib.error.URLError as exc:
        timed_out = isinstance(exc.reason, (socket.timeout, TimeoutError))
        raise KVError("timeout" if timed_out else "network") from None
    except Exception:  # noqa: BLE001 - any failure is a status, never a crash
        raise KVError("error") from None


def _api_json(data):
    try:
        doc = json.loads(data)
    except (ValueError, TypeError):
        raise KVError("bad_response") from None
    if not isinstance(doc, dict) or doc.get("success") is False:
        raise KVError("bad_response")
    return doc


def _find_namespace(http_get, base, token):
    for page in range(1, 51):
        doc = _api_json(_get(http_get, f"{base}/storage/kv/namespaces?per_page=100&page={page}", token))
        for ns in doc.get("result") or []:
            if isinstance(ns, dict) and ns.get("title") == NAMESPACE_TITLE and isinstance(ns.get("id"), str):
                return ns["id"]
        info = doc.get("result_info") or {}
        if not isinstance(info, dict) or page >= int(info.get("total_pages") or 1):
            return None
    return None


def _list_keys(http_get, base, ns, token):
    names, cursor = [], ""
    for _ in range(20):
        url = f"{base}/storage/kv/namespaces/{quote(ns, safe='')}/keys?limit=1000"
        if cursor:
            url += f"&cursor={quote(cursor, safe='')}"
        doc = _api_json(_get(http_get, url, token))
        for key in doc.get("result") or []:
            if isinstance(key, dict) and isinstance(key.get("name"), str):
                names.append(key["name"])
        info = doc.get("result_info") or {}
        cursor = info.get("cursor") if isinstance(info, dict) else ""
        if not cursor or len(names) >= MAX_KEYS:
            break
    return names[:MAX_KEYS]


def _parse_value(raw):
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def read_interests(env=None, http_get=None):
    """Return (values, status, token_env_name). values holds one parsed document per
    key (None for one that did not parse), in key order. status is ok, no_token,
    no_namespace, http_<code>, timeout, network, bad_response or error. Never
    raises."""
    env = os.environ if env is None else env
    http_get = http_get or _http_get
    account = next((env.get(n) for n in ACCOUNT_ENV_NAMES if env.get(n)), "")
    tokens = [(n, env.get(n)) for n in TOKEN_ENV_NAMES if env.get(n)]
    if not account or not tokens:
        return [], "no_token", None
    base = f"{CF_API_BASE}/accounts/{quote(account, safe='')}"
    status = "error"
    for name, token in tokens:
        try:
            ns = _find_namespace(http_get, base, token)
        except KVError as exc:
            status = exc.status
            continue
        if ns is None:
            return [], "no_namespace", name
        try:
            keys = _list_keys(http_get, base, ns, token)
        except KVError as exc:
            return [], exc.status, name
        values = []
        for key in keys:
            url = f"{base}/storage/kv/namespaces/{quote(ns, safe='')}/values/{quote(key, safe='')}"
            try:
                values.append(_parse_value(_get(http_get, url, token)))
            except KVError:
                values.append(None)
        return values, "ok", name
    return [], status, None


# --- Google News search ----------------------------------------------------------

def search_url(q):
    params = {"q": f"{q} when:3d", "hl": "en-US", "gl": "US", "ceid": "US:en"}
    return f"{SEARCH_BASE}?{urlencode(params, quote_via=quote, safe=':')}"


def _fetch_status(url, fetch_fn, timeout, retries):
    """(data, None) or (None, status) with the HTTP code kept (http_429...), after the
    fetcher's one retry. Exception text is dropped: it can carry the URL."""
    last = "error"
    for attempt in range(retries + 1):
        if attempt and (last == "http_429" or last.startswith("http_5")):
            time.sleep(RETRY_PAUSE)
        try:
            return fetch_fn(url, timeout=timeout), None
        except FeedError:
            last = "too_large"
        except urllib.error.HTTPError as exc:
            last = f"http_{exc.code}"
        except (socket.timeout, TimeoutError):
            last = "timeout"
        except urllib.error.URLError as exc:
            last = "timeout" if isinstance(exc.reason, (socket.timeout, TimeoutError)) else "network"
        except Exception:  # noqa: BLE001
            last = "error"
    return None, last


def fetch_searches(queries, fetch_fn, timeout, retries, workers=WATCH_WORKERS):
    """One Google News search per query. Returns [{"tag", "data", "error"}] in query
    order: the tag, never the q, is all that travels on from here."""
    if not queries:
        return []

    def _job(query):
        data, error = _fetch_status(search_url(query["q"]), fetch_fn, timeout, retries)
        return {"tag": query["tag"], "data": data, "error": error}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, len(queries)))) as ex:
        return list(ex.map(_job, queries))


def collect(env=None, http_get=None, fetch_fn=None, timeout=12, retries=1):
    """Everything main() needs before the pool is built: the KV status, the query
    count and drops, and each search's result. Never raises."""
    try:
        values, kv, token_name = read_interests(env, http_get)
        queries, query_drops = union_queries(values)
        results = fetch_searches(queries, fetch_fn, timeout, retries) if queries else []
        return {"kv": kv, "token": token_name, "queries": len(queries),
                "query_drops": dict(query_drops), "results": results}
    except Exception:  # noqa: BLE001 - the watch step never fails the run
        return {"kv": "error", "token": None, "queries": 0, "query_drops": {}, "results": []}


# --- outlets and matching ----------------------------------------------------------

def base_domain(host):
    labels = [p for p in (host or "").lower().rstrip(".").split(".") if p]
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _host(url):
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""


def outlet_index(sources):
    """({base domain: source}, {casefolded name: source}) over configured sources,
    first source in sources.json order winning a shared domain."""
    by_domain, by_name = {}, {}
    for s in sources:
        hosts = [_host(s["feed_url"])]
        if s.get("via") == "google_news":
            m = _SITE_RE.search(unquote(s.get("via_url") or ""))
            if m:
                hosts.append(m.group(1))
        for host in hosts:
            domain = base_domain(host)
            if domain and domain not in SHARED_HOSTS:
                by_domain.setdefault(domain, s)
        by_name.setdefault(s["name"].casefold(), s)
    return by_domain, by_name


def _outlet(item, index):
    """(source_id, bucket, outlet name as Google gives it) for one search item."""
    by_domain, by_name = index
    el = item.find("source")
    name = _clean("".join(el.itertext())) if el is not None else ""
    domain = base_domain(_host(el.get("url") or "")) if el is not None else ""
    source = by_domain.get(domain) if domain else None
    source = source or (by_name.get(name.casefold()) if name else None)
    if source is not None:
        return source["id"], source.get("bucket"), name
    return SOURCE["id"], None, name


def canonical_url(url):
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    query = "&".join(sorted(p for p in parts.query.split("&")
                            if p and not p.lower().startswith(_TRACKING_PARAMS)))
    return f"{host}{parts.path.rstrip('/')}" + (f"?{query}" if query else "")


def title_key(title):
    """Case, accents' compatibility forms and punctuation folded, for "the same
    headline". Too short or too generic a headline gets no key at all."""
    text = re.sub(r"[\W_]+", " ", unicodedata.normalize("NFKC", title).casefold())
    key = " ".join(text.split())
    if len(key) < TITLE_KEY_MIN_CHARS or len(key.split()) < TITLE_KEY_MIN_WORDS:
        return None
    return key


def match_keys(article):
    """Keys that say two records are one article, strongest first: the same id (same
    URL), the same canonical URL, the same headline from the same source, the same
    headline from anywhere (wire copy)."""
    keys = [("id", article["id"])]
    try:
        keys.append(("url", canonical_url(article["url"])))
    except ValueError:
        pass
    tk = title_key(article["title"])
    if tk:
        keys.append(("st", article["source_id"], tk))
        keys.append(("t", tk))
    return keys


def add_tags(article, tags, order):
    article["watch"] = sorted(set(article.get("watch", ())) | set(tags))
    current = article.get("_watch_order")
    article["_watch_order"] = order if current is None else min(current, order)


# --- search results into items (pure) ---------------------------------------------

def _clean_item(article, outlet, bucket, topics_doc):
    """Google News search titles end in " - <outlet>" and their descriptions are a
    list of headline links, never a summary: strip the suffix, drop the dek, and tag
    topics and geography from the headline alone."""
    title = article["title"]
    suffix = f" - {outlet}" if outlet else ""
    if suffix and title.endswith(suffix) and len(title) > len(suffix):
        title = title[: -len(suffix)].rstrip()
    article["title"] = title
    article.pop("dek", None)
    article["geo"] = tag_geo(bucket, title, "")
    article["topics"] = tag_article(bucket, title, "", topics_doc, geo=article["geo"])


def _feed_state(states):
    """The Google News source's one S05 feed state for the run: ok when any search
    returned items, else empty when any parsed, else the commonest failure."""
    if not states or "ok" in states:
        return "ok" if states else "empty"
    if "empty" in states:
        return "empty"
    return Counter(states).most_common(1)[0][0]


def watch_items(results, sources, now, topics_doc, leniency, image_rejected, extract):
    """Turn fetch_searches' results into watch items. Pure: no network, no clock.

    extract is fetcher.fanout._extract_article (passed in to keep the import one
    way). Returns (items, counts, feed_state, newest_published_at). counts holds
    fetched, candidates, drops (ITEM_DROP_KEYS) and errors; fetched equals
    candidates plus the sum of drops. Each item carries "watch" (its tags) and a
    scratch "_watch_order" (rank in its query, query index) the caller strips."""
    index = outlet_index(sources)
    drops, errors = Counter(), Counter()
    fetched = 0
    states = []
    cutoff = _utc(now - WINDOW)
    per_query = []
    for result in results:
        found = []
        per_query.append(found)
        if result["data"] is None:
            error = result["error"] or "error"
            errors[error] += 1
            states.append("timeout" if error == "timeout" else "http_error")
            continue
        try:
            root = parse_xml(result["data"], leniency)
        except FeedError:
            errors["parse_error"] += 1
            states.append("parse_error")
            continue
        items, kind = iter_feed_items(root)
        fetched += len(items)
        states.append("ok" if items else "empty")
        for item in items:
            sid, bucket, outlet = _outlet(item, index) if kind == "rss" else (SOURCE["id"], None, "")
            article = extract(item, sid, frozenset(), leniency, drops, image_rejected=image_rejected,
                              is_google_news=True, kind=kind)
            if article is None:
                continue
            _clean_item(article, outlet, bucket, topics_doc)
            if article["published_at"] < cutoff:
                drops["stale"] += 1
                continue
            found.append(article)
        found.sort(key=lambda a: (a["published_at"], a["id"]), reverse=True)
        drops["over_query_cap"] += max(0, len(found) - ITEMS_PER_QUERY)
        del found[ITEMS_PER_QUERY:]

    out, seen = [], {}
    for qi, found in enumerate(per_query):
        tag = results[qi]["tag"]
        for rank, article in enumerate(found):
            keys = match_keys(article)
            hit = next((seen[k] for k in keys if k in seen), None)
            if hit is not None:
                add_tags(hit, [tag], (rank, qi))
                drops["duplicate"] += 1
                continue
            add_tags(article, [tag], (rank, qi))
            out.append(article)
            for k in keys:
                seen.setdefault(k, article)
    counts = {
        "fetched": fetched,
        "candidates": len(out),
        "drops": {k: drops[k] for k in ITEM_DROP_KEYS if drops.get(k)},
        "errors": dict(sorted(errors.items())),
    }
    newest = max((a["published_at"] for a in out), default=None)
    return out, counts, _feed_state(states), newest


def merge_into(candidates, items):
    """Fold watch items that duplicate a pool candidate into that candidate's watch
    tags. Returns (new_items, merged_count); new_items are the ones the pool lacks."""
    index = {}
    for article in candidates:
        for k in match_keys(article):
            index.setdefault(k, article)
    new, merged = [], 0
    for item in items:
        hit = next((index[k] for k in match_keys(item) if k in index), None)
        if hit is None:
            new.append(item)
            continue
        add_tags(hit, item["watch"], item["_watch_order"])
        merged += 1
    return new, merged


def record_bytes(article):
    """Published size of one article record (plus its comma), scratch fields out."""
    public = {k: v for k, v in article.items() if not k.startswith("_")}
    return len(json.dumps(public, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1


def tag_bytes(article):
    """What the watch field adds to an article that would publish anyway."""
    return len(json.dumps({"watch": article["watch"]}, separators=(",", ":")).encode("utf-8")) - 1


def status_words(kv):
    """The KV status as the log line says it."""
    if kv.startswith("http_"):
        return kv[5:]
    return {"no_token": "no token or account id in env",
            "no_namespace": f"no namespace titled {NAMESPACE_TITLE}"}.get(kv, kv)
