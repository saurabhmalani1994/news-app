"""W2 (R50) proof: watch searches for free-text interests and standing stories.

No network: the Cloudflare KV REST API and Google News are both fakes. Every phrase
here is invented ("zebra quantum widgets" and friends); no real interest ever
appears in a fixture.
"""
import json
import re
import urllib.error
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from html import escape
from pathlib import Path
from urllib.parse import parse_qs, quote, quote_plus, unquote, urlsplit

import pytest

import fetcher.fanout as fanout
import fetcher.watch as watch
from contract.validate import validate
from fetcher.fanout import build_pool_fanout

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc)
Q1, Q2, Q3 = "zebra quantum widgets", "marmalade lighthouse accord", "velvet tractor summit"
T1, T2, T3 = (watch.tag_for(q) for q in (Q1, Q2, Q3))
ACCOUNT = "0123456789abcdef0123456789abcdef"
NS_ID = "fedcba9876543210fedcba9876543210"


def _src(id_, name, url, **extra):
    return {"id": id_, "name": name, "feed_url": url, "bucket": "general", "lean": "center",
            "lean_basis": "test fixture, not a real rating", "syndication_group": id_, **extra}


HARBOR = _src("harbor", "Harbor Herald", "https://feeds.harborherald.example/rss")
SOURCES = [HARBOR]


def _rss(items):
    """items: (title, url, datetime). A plain outlet feed."""
    body = "".join(
        f"<item><title>{escape(t)}</title><link>{escape(u)}</link>"
        f"<pubDate>{format_datetime(w, usegmt=True)}</pubDate>"
        f"<description>A plain summary of the piece.</description></item>"
        for t, u, w in items
    )
    return f'<rss version="2.0"><channel><title>x</title>{body}</channel></rss>'.encode("utf-8")


def _gn(items):
    """items: dicts with title, outlet, outlet_url, when, slug and optional direct (a
    real article link inside the description). Shaped like Google News search RSS."""
    out = []
    for it in items:
        link = f"https://news.google.com/rss/articles/{it['slug']}?oc=5"
        desc = f'<a href="{link}">{it["title"]}</a>'
        if it.get("direct"):
            desc += f' (<a href="{it["direct"]}">direct</a>)'
        desc += f'&nbsp;&nbsp;<font color="#6f6f6f">{it["outlet"]}</font>'
        out.append(
            f"<item><title>{escape(it['title'])} - {escape(it['outlet'])}</title>"
            f"<link>{link}</link><guid isPermaLink=\"false\">{it['slug']}</guid>"
            f"<pubDate>{format_datetime(it['when'], usegmt=True)}</pubDate>"
            f"<description>{escape(desc)}</description>"
            f"<source url=\"{it['outlet_url']}\">{escape(it['outlet'])}</source></item>"
        )
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
            f"<title>Google News</title>{''.join(out)}</channel></rss>").encode("utf-8")


def _item(title, slug, hours_ago=1, outlet="Distant Gazette",
          outlet_url="https://www.distantgazette.example", now=NOW, **extra):
    return {"title": title, "outlet": outlet, "outlet_url": outlet_url,
            "when": now - timedelta(hours=hours_ago), "slug": slug, **extra}


def _watch_input(results, kv="ok"):
    return {"kv": kv, "token": "CLOUDFLARE_WORKERS_TOKEN" if kv == "ok" else None,
            "queries": len(results), "query_drops": {},
            "results": [{"tag": tag, "data": data, "error": None if data is not None else "http_503"}
                        for tag, data in results]}


HARBOR_FEED = _rss([
    ("Harbor towns sign the tidal energy compact", "https://www.harborherald.example/a1", NOW - timedelta(hours=2)),
    ("Ferry timetable grows for the autumn season", "https://www.harborherald.example/a2", NOW - timedelta(hours=3)),
    ("Lighthouse keepers archive opens to visitors", "https://www.harborherald.example/a3", NOW - timedelta(hours=4)),
    ("Fishing cooperative reports record mackerel catch", "https://www.harborherald.example/a4", NOW - timedelta(hours=5)),
    ("School board weighs longer lunch breaks", "https://www.harborherald.example/a5", NOW - timedelta(hours=6)),
    ("Bakery wins regional sourdough contest", "https://www.harborherald.example/a6", NOW - timedelta(hours=7)),
    ("Quiet canal repairs finish ahead of schedule", "https://www.harborherald.example/a7", NOW - timedelta(hours=8)),
])


def _pool(results, sources=SOURCES, feeds=None, **kw):
    feeds = feeds or {"harbor": (HARBOR_FEED, None)}
    return build_pool_fanout(sources, feeds, NOW, watch=_watch_input(results), **kw)


def _by_url(pool):
    return {a["url"]: a for a in pool["articles"]}


# --- queries: normalize, tag, union, dedup, bad tags, caps --------------------------

def test_tag_is_w_plus_ten_hex_of_the_normalized_query():
    assert re.fullmatch(r"w:[0-9a-f]{10}", T1)
    assert watch.tag_for("  Zebra   QUANTUM\twidgets ") == T1
    assert watch.normalize("  Zebra   QUANTUM\twidgets ") == Q1


def test_union_interleaves_users_and_dedupes_by_tag():
    alice = {"v": 1, "queries": [{"q": Q1, "tag": T1}, {"q": Q2, "tag": T2}]}
    bob = {"v": 1, "queries": [{"q": "Zebra  Quantum Widgets", "tag": T1}, {"q": Q3, "tag": T3}]}
    queries, drops = watch.union_queries([alice, bob])
    assert [q["tag"] for q in queries] == [T1, T2, T3]
    assert drops == {"duplicate": 1}


def test_a_bad_tag_is_dropped_and_bad_values_are_counted():
    values = [
        {"v": 1, "queries": [
            {"q": Q1, "tag": T2},                      # tag of another phrase
            {"q": Q2, "tag": "w:ZZZZZZZZZZ"},          # not hex
            {"q": Q3, "tag": T3},                      # fine
            {"q": "x" * 101, "tag": watch.tag_for("x" * 101)},  # over 100 characters
            {"q": "   ", "tag": watch.tag_for("   ")},  # empty once trimmed
            "not an object",
        ]},
        {"v": 2, "queries": []},  # unknown version
        None,                     # a value that did not parse
    ]
    queries, drops = watch.union_queries(values)
    assert queries == [{"q": Q3, "tag": T3}]
    assert drops == {"bad_tag": 2, "bad_query": 3, "bad_value": 2}


def test_caps_25_per_value_and_60_per_run():
    def user(n, prefix):
        qs = [f"{prefix} invented phrase {i}" for i in range(n)]
        return {"v": 1, "queries": [{"q": q, "tag": watch.tag_for(q)} for q in qs]}
    queries, drops = watch.union_queries([user(30, "alpha"), user(25, "beta"), user(25, "gamma")])
    assert len(queries) == watch.MAX_QUERIES == 60
    assert drops == {"over_value_cap": 5, "over_cap": 15}
    # interleaved: the cap falls on everyone's tail, not on one user
    firsts = {q["q"] for q in queries[:3]}
    assert firsts == {"alpha invented phrase 0", "beta invented phrase 0", "gamma invented phrase 0"}


def test_search_url_is_google_news_search_rss_for_the_last_three_days():
    assert watch.search_url(Q1) == (
        "https://news.google.com/rss/search?q=zebra%20quantum%20widgets%20when:3d"
        "&hl=en-US&gl=US&ceid=US:en"
    )


# --- Workers KV via the REST API (mocked) --------------------------------------------

class FakeKV:
    """The three Cloudflare REST calls the fetcher makes, routed by path."""

    def __init__(self, values=None, namespaces=None, forbidden=(), page_size=2):
        self.values = values or {}
        self.namespaces = namespaces if namespaces is not None else [
            {"id": "11111111111111111111111111111111", "title": "some-other-namespace"},
            {"id": "22222222222222222222222222222222", "title": "another-one"},
            {"id": NS_ID, "title": watch.NAMESPACE_TITLE},
        ]
        self.forbidden = set(forbidden)
        self.page_size = page_size
        self.calls = []

    def __call__(self, url, token, timeout):
        self.calls.append((urlsplit(url).path, token))
        if token in self.forbidden:
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        parts = urlsplit(url)
        qs = parse_qs(parts.query)
        assert parts.path.startswith(f"/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces")
        if parts.path.endswith("/storage/kv/namespaces"):
            page = int(qs.get("page", ["1"])[0])
            start = (page - 1) * self.page_size
            chunk = self.namespaces[start:start + self.page_size]
            pages = max(1, -(-len(self.namespaces) // self.page_size))
            return json.dumps({"success": True, "errors": [], "result": chunk,
                               "result_info": {"page": page, "total_pages": pages}}).encode()
        if parts.path.endswith("/keys"):
            names = sorted(self.values)
            cursor = qs.get("cursor", [""])[0]
            start = int(cursor) if cursor else 0
            chunk = names[start:start + 1]  # one key per page, so the cursor is exercised
            nxt = str(start + 1) if start + 1 < len(names) else ""
            return json.dumps({"success": True, "result": [{"name": n} for n in chunk],
                               "result_info": {"count": len(chunk), "cursor": nxt}}).encode()
        if "/values/" in parts.path:
            key = unquote(parts.path.rsplit("/", 1)[1])
            return self.values[key]
        raise AssertionError(parts.path)


ENV = {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "CLOUDFLARE_WORKERS_TOKEN": "tok-workers",
       "CLOUDFLARE_API_TOKEN": "tok-pages"}


def _value(*qs):
    return json.dumps({"v": 1, "queries": [{"q": q, "tag": watch.tag_for(q)} for q in qs]}).encode()


def test_kv_read_finds_the_namespace_by_title_and_reads_every_key():
    kv = FakeKV(values={"user:aaa": _value(Q1, Q2), "user:bbb/with space": _value(Q3)})
    values, status, token = watch.read_interests(ENV, kv)
    assert status == "ok" and token == "CLOUDFLARE_WORKERS_TOKEN"
    assert [len(v["queries"]) for v in values] == [2, 1]
    assert any(path.endswith("/values/user%3Abbb%2Fwith%20space") for path, _ in kv.calls)


def test_kv_403_on_both_tokens_degrades_to_zero_queries():
    kv = FakeKV(values={"u": _value(Q1)}, forbidden={"tok-workers", "tok-pages"})
    assert watch.read_interests(ENV, kv) == ([], "http_403", None)
    got = watch.collect(env=ENV, http_get=kv, fetch_fn=lambda *a, **k: pytest.fail("no search"))
    assert got["kv"] == "http_403" and got["queries"] == 0 and got["results"] == []


def test_kv_first_token_403_second_token_reads():
    kv = FakeKV(values={"u": _value(Q1)}, forbidden={"tok-workers"})
    values, status, token = watch.read_interests(ENV, kv)
    assert status == "ok" and token == "CLOUDFLARE_API_TOKEN" and len(values) == 1


def test_kv_missing_namespace_degrades_to_zero_queries():
    kv = FakeKV(namespaces=[{"id": "1" * 32, "title": "not-it"}])
    assert watch.read_interests(ENV, kv) == ([], "no_namespace", "CLOUDFLARE_WORKERS_TOKEN")


def test_kv_without_a_token_or_account_makes_no_call():
    kv = FakeKV()
    assert watch.read_interests({"CLOUDFLARE_ACCOUNT_ID": ACCOUNT}, kv)[1] == "no_token"
    assert watch.read_interests({"CLOUDFLARE_API_TOKEN": "t"}, kv)[1] == "no_token"
    assert kv.calls == []


def test_kv_any_other_failure_is_a_status_not_a_crash():
    def boom(url, token, timeout):
        raise RuntimeError("anything at all")
    assert watch.read_interests(ENV, boom) == ([], "error", None)
    assert watch.collect(env=ENV, http_get=boom)["queries"] == 0


# --- search results into the pool ------------------------------------------------

def test_unknown_outlet_goes_to_the_google_news_source_title_cleaned_no_dek():
    feed = _gn([_item("Distant valley opens a new observatory", "s1")])
    pool = _pool([(T1, feed)])
    assert validate(pool) == []
    art = next(a for a in pool["articles"] if a["url"].startswith("https://news.google.com/"))
    assert art["source_id"] == "google_news_search"
    assert art["title"] == "Distant valley opens a new observatory"  # " - Distant Gazette" stripped
    assert "dek" not in art and art["topics"] and art["watch"] == [T1]
    assert not any(k.startswith("_") for k in art)
    ids = [s["id"] for s in pool["sources"]]
    assert ids == ["harbor", "google_news_search"]
    assert pool["sources"][1] == {"id": "google_news_search", "name": "Google News",
                                  "feed_url": "https://news.google.com/rss/search"}
    assert sum(pool["counts"]["feed_states"].values()) == 2
    assert pool["source_health"]["google_news_search"]["state"] == "ok"


def test_a_configured_outlet_keeps_its_own_source():
    feed = _gn([_item("Harbor pilots train on a new tug", "s2", outlet="Harbor Herald",
                      outlet_url="https://www.harborherald.example")])
    pool = _pool([(T1, feed)])
    art = next(a for a in pool["articles"] if a.get("watch"))
    assert art["source_id"] == "harbor" and art["title"] == "Harbor pilots train on a new tug"
    assert validate(pool) == []


def test_three_day_window_and_newest_ten():
    items = [_item(f"Observatory update number {i} from the distant valley", f"n{i}", hours_ago=i)
             for i in range(1, 15)]
    items += [_item("An old observatory story from last week", "old1", hours_ago=24 * 4),
              _item("Another old observatory story from long ago", "old2", hours_ago=24 * 5)]
    pool = _pool([(T1, _gn(items))])
    w = pool["counts"]["watch"]
    assert w["fetched"] == 16 and w["candidates"] == 10
    assert w["drops"] == {"stale": 2, "over_query_cap": 4}
    kept = sorted(a["title"] for a in pool["articles"] if a.get("watch"))
    assert kept == sorted(f"Observatory update number {i} from the distant valley" for i in range(1, 11))
    assert validate(pool) == []


def test_an_item_already_in_the_pool_gets_the_tag_not_a_duplicate():
    feed = _gn([
        # same headline, same outlet as harbor's a1: a canonical match
        _item("Harbor towns sign the tidal energy compact", "m1", outlet="Harbor Herald",
              outlet_url="https://www.harborherald.example"),
        # the description carries the outlet's own link to a2: the same URL
        _item("Autumn ferry timetable grows again", "m2", outlet="Harbor Herald",
              outlet_url="https://www.harborherald.example",
              direct="https://www.harborherald.example/a2"),
    ])
    pool = _pool([(T2, feed)])
    by_url = _by_url(pool)
    assert by_url["https://www.harborherald.example/a1"]["watch"] == [T2]
    assert by_url["https://www.harborherald.example/a2"]["watch"] == [T2]
    assert not any(a["url"].startswith("https://news.google.com/") for a in pool["articles"])
    w = pool["counts"]["watch"]
    assert w["merged"] == 2 and w["published"] == 0
    assert pool["counts"]["drops"]["duplicate_url"] == 2
    assert validate(pool) == []


def test_the_same_article_from_two_queries_carries_both_tags():
    same = _item("Distant valley opens a new observatory", "dup1")
    pool = _pool([(T1, _gn([same])), (T3, _gn([same]))])
    arts = [a for a in pool["articles"] if a.get("watch")]
    assert len(arts) == 1 and arts[0]["watch"] == sorted([T1, T3])
    assert pool["counts"]["watch"]["drops"] == {"duplicate": 1}
    assert validate(pool) == []


def test_watch_tag_exempts_a_pool_article_from_the_per_source_cap():
    feed = _gn([_item("Quiet canal repairs finish ahead of schedule", "c7", outlet="Harbor Herald",
                      outlet_url="https://www.harborherald.example")])
    pool = _pool([(T1, feed)])
    by_url = _by_url(pool)
    assert by_url["https://www.harborherald.example/a7"]["watch"] == [T1]  # 7th item, cap is 5
    assert "https://www.harborherald.example/a6" not in by_url  # still capped
    assert pool["counts"]["watch"]["published"] == 1
    assert pool["counts"]["drops"]["over_cap"] == 1
    assert validate(pool) == []


def test_watch_items_are_exempt_from_the_per_source_cap():
    items = [_item(f"Harbor pilots story number {i} about tugs", f"h{i}", hours_ago=i,
                   outlet="Harbor Herald", outlet_url="https://www.harborherald.example")
             for i in range(1, 9)]
    pool = _pool([(T1, _gn(items))])
    harbor = [a for a in pool["articles"] if a["source_id"] == "harbor"]
    assert len(harbor) == 5 + 8  # the feed's capped five, plus every watch item
    assert validate(pool) == []


def test_budget_is_enforced_round_robin_across_queries():
    results = []
    for tag, word in ((T1, "alpha"), (T2, "beta"), (T3, "gamma")):
        results.append((tag, _gn([_item(f"{word} observatory bulletin {i} from the valley", f"{word}{i}",
                                         hours_ago=i) for i in range(1, 11)])))
    budget = 2400
    pool = _pool(results, watch_budget=budget)
    w = pool["counts"]["watch"]
    assert 3 <= w["published"] < 30
    assert w["over_budget"] == 30 - w["published"]
    assert w["bytes"] <= budget == w["budget_bytes"]
    titles = {a["title"] for a in pool["articles"] if a.get("watch")}
    for word in ("alpha", "beta", "gamma"):  # every query's newest item goes first
        assert f"{word} observatory bulletin 1 from the valley" in titles
    published_bytes = sum(watch.record_bytes(a) for a in pool["articles"] if a.get("watch"))
    assert published_bytes == w["bytes"]
    assert validate(pool) == []


def test_watch_items_go_through_clustering(monkeypatch):
    seen = []
    real = fanout.cluster_items

    def spy(candidates):
        seen.extend(a["id"] for a in candidates)
        return real(candidates)

    monkeypatch.setattr(fanout, "cluster_items", spy)
    pool = _pool([(T1, _gn([_item("Distant valley opens a new observatory", "cl1")]))])
    art = next(a for a in pool["articles"] if a.get("watch"))
    assert art["id"] in seen


def test_watch_only_items_stay_out_of_the_public_candidate_dump():
    out = {}
    pool = _pool([(T1, _gn([_item("Distant valley opens a new observatory", "dd1")]))],
                 candidates_out=out)
    dump_urls = {c["url"] for c in out["dump"]["candidates"]}
    assert not any(u.startswith("https://news.google.com/") for u in dump_urls)
    assert out["dump"]["counts"]["candidates"] == 7
    assert validate(pool) == []


def test_failed_searches_are_counted_by_status_and_the_run_goes_on():
    pool = _pool([(T1, None), (T2, b"<rss><channel><item><title>Unclosed</channel>")])
    w = pool["counts"]["watch"]
    assert w["errors"] == {"http_503": 1, "parse_error": 1}
    assert w["fetched"] == 0 and w["published"] == 0
    assert pool["source_health"]["google_news_search"]["state"] in ("http_error", "parse_error")
    assert validate(pool) == []


def test_zero_queries_add_no_source_and_keep_the_ledger():
    pool = build_pool_fanout(SOURCES, {"harbor": (HARBOR_FEED, None)}, NOW,
                             watch={"kv": "http_403", "token": None, "queries": 0,
                                    "query_drops": {}, "results": []})
    assert [s["id"] for s in pool["sources"]] == ["harbor"]
    assert pool["counts"]["watch"]["kv"] == "http_403"
    assert pool["counts"]["watch"]["queries"] == 0
    assert validate(pool) == []


def test_no_watch_argument_means_no_watch_counts():
    pool = build_pool_fanout(SOURCES, {"harbor": (HARBOR_FEED, None)}, NOW)
    assert "watch" not in pool["counts"]
    assert not any("watch" in a for a in pool["articles"])


# --- main(): the run never fails, and the log never carries a query ----------------------

SECRET_EXTRA = "orchid ledger basin"  # a query with a bad tag: dropped, never logged


def _variants(q):
    return {q, q.lower(), q.upper(), quote(q), quote_plus(q), quote(q, safe=""), q.replace(" ", "+"),
            json.dumps(q), watch.normalize(q)}


def _write_sources(tmp_path):
    src = tmp_path / "sources.json"
    src.write_text(json.dumps({"schema_version": 1, "sources": SOURCES}), encoding="utf-8")
    return src


def _run_main(tmp_path, monkeypatch, kv, fetch):
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNTID", raising=False)
    monkeypatch.setattr(watch, "_http_get", kv)
    monkeypatch.setattr(watch, "RETRY_PAUSE", 0)
    monkeypatch.setattr(fanout, "fetch_feed", fetch)
    out = tmp_path / "dist" / "pool.json"
    rc = fanout.main(["--out", str(out), "--sources", str(_write_sources(tmp_path)),
                      "--state-path", str(tmp_path / "state.json"), "--timeout", "1"])
    return rc, out


def _live_feed(url, timeout=None):
    now = datetime.now(timezone.utc)
    if "news.google.com" in url:
        q = parse_qs(urlsplit(url).query)["q"][0]
        if Q2 in q:
            # an error whose own text carries the URL, and so the query
            raise urllib.error.HTTPError(url, 503, f"unavailable for {url}", {}, None)
        return _gn([_item("Distant valley opens a new observatory", "live1", now=now),
                    _item("Harbor pilots train on a new tug", "live2", now=now, outlet="Harbor Herald",
                          outlet_url="https://www.harborherald.example")])
    return _rss([("Harbor towns sign the tidal energy compact", "https://www.harborherald.example/a1",
                  now - timedelta(hours=1))])


def test_main_logs_counts_only_never_a_query(tmp_path, monkeypatch, capsys):
    bad = json.dumps({"v": 1, "queries": [{"q": SECRET_EXTRA, "tag": T1}]}).encode()
    kv = FakeKV(values={"user:one": _value(Q1, Q2), "user:two": _value(Q3, Q1), "user:three": bad})
    requested = []

    def fetch(url, timeout=None):
        requested.append(url)
        return _live_feed(url, timeout)

    rc, out = _run_main(tmp_path, monkeypatch, kv, fetch)
    captured = capsys.readouterr()
    log = captured.out + captured.err
    assert rc == 0
    assert "watch: 3 queries (kv ok via CLOUDFLARE_WORKERS_TOKEN)" in log
    assert '"http_503": 1' in log
    for q in (Q1, Q2, Q3, SECRET_EXTRA):
        for v in _variants(q):
            assert v not in log, "a query reached the log"
    # the searches really were made, one per query, for the last three days
    searched = [u for u in requested if "news.google.com" in u]
    # Q2's search failed with a 503 and got the fetcher's one retry
    assert sorted(searched) == sorted(watch.search_url(q) for q in (Q1, Q2, Q2, Q3))
    body = out.read_text(encoding="utf-8")
    pool = json.loads(body)
    assert validate(pool) == []
    for q in (Q1, Q2, Q3, SECRET_EXTRA):
        for v in _variants(q):
            assert v not in body, "a query reached pool.json"
    assert pool["counts"]["watch"]["query_drops"] == {"bad_tag": 1, "duplicate": 1}


def test_main_kv_403_logs_one_line_and_publishes(tmp_path, monkeypatch, capsys):
    kv = FakeKV(forbidden={"tok-workers", "tok-pages"})
    rc, out = _run_main(tmp_path, monkeypatch, kv, _live_feed)
    log = capsys.readouterr().out
    assert rc == 0
    assert "watch: 0 queries (kv unavailable: 403)" in log
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert pool["counts"]["watch"]["kv"] == "http_403"
    assert validate(pool) == []


def test_main_missing_namespace_logs_one_line_and_publishes(tmp_path, monkeypatch, capsys):
    kv = FakeKV(namespaces=[])
    rc, out = _run_main(tmp_path, monkeypatch, kv, _live_feed)
    assert rc == 0
    assert "watch: 0 queries (kv unavailable: no namespace titled almanac-interests)" in capsys.readouterr().out
    assert json.loads(out.read_text(encoding="utf-8"))["counts"]["watch"]["kv"] == "no_namespace"


def test_main_publishes_without_watch_items_when_they_break_the_build(tmp_path, monkeypatch, capsys):
    kv = FakeKV(values={"u": _value(Q1)})

    def broken(*a, **k):
        raise KeyError("boom")

    monkeypatch.setattr(watch, "watch_items", broken)
    rc, out = _run_main(tmp_path, monkeypatch, kv, _live_feed)
    captured = capsys.readouterr()
    assert rc == 0
    assert "publishing without them" in captured.err
    assert "dropped from this pool" in captured.out
    pool = json.loads(out.read_text(encoding="utf-8"))
    assert "watch" not in pool["counts"] and validate(pool) == []


def test_publish_workflow_passes_the_kv_tokens_to_fetch():
    wf = (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")
    fetch_step = wf.split("- name: Fetch", 1)[1].split("- name:", 1)[0]
    assert "CLOUDFLARE_WORKERS_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}" in fetch_step
    assert "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}" in fetch_step
    assert "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNTID }}" in fetch_step


def test_live_event_label_is_withheld_from_the_log_when_a_member_is_watch_tagged():
    pool = {
        "articles": [{"id": "a1"}, {"id": "a2", "watch": [T1]}, {"id": "b1"}, {"id": "b2"}],
        "clusters": [{"id": "c_a", "article_ids": ["a1", "a2"]}, {"id": "c_b", "article_ids": ["b1", "b2"]}],
        "events": [
            {"id": "e1", "label": "Invented Label One", "cluster_ids": ["c_a"], "hype": 4,
             "live": True, "hold_state": "none", "live_since": "2026-09-24T10:00:00Z"},
            {"id": "e2", "label": "Invented Label Two", "cluster_ids": ["c_b"], "hype": 3,
             "live": True, "hold_state": "none", "live_since": "2026-09-24T10:00:00Z"},
            {"id": "e3", "label": "Not live", "cluster_ids": [], "hype": 0,
             "live": False, "hold_state": "none"},
        ],
    }
    rows = fanout.live_event_rows(pool)
    assert rows == [["e1", "(withheld: watch)", 4, "none", "2026-09-24T10:00:00Z"],
                    ["e2", "Invented Label Two", 3, "none", "2026-09-24T10:00:00Z"]]
