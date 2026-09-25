"""B7: the embedding term (DESIGN-bundles section 2(b)). No network: every Workers AI call
here goes to a fake post function."""
import copy
import hashlib
import json
import re
import time
import urllib.error
from array import array
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest

from contract.validate import validate
from fetcher import cluster, embed
from fetcher.bundle_eval import load_fixture
from fetcher.cluster import cluster_items, method_for
from fetcher.embed import workers_plan

ROOT = Path(__file__).resolve().parents[1]
BUNDLES = ROOT / "tests/fixtures/bundles"
NOW = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)

# B2's output, recorded from main at d206e36 before B7 touched fetcher/cluster.py: sha256
# of json.dumps(cluster_items(articles), sort_keys=True, separators=(",", ":")).
B2_DIGESTS = {
    "gold_2026-09-24.json": "52b1755a5948824bc070be97c6847c3cca81178e45a5135f5381f34b68a84b1b",
    "gold_2026-09-24b.json": "9ddeebdd57438cff464e7e000b4520d4f14c7b231d8369d0b069f376ed5160f4",
    "synthetic_2000": "0780092c8bbf5064885a177df7672d8743271736c6e69b3e169857d36aa7ab78",
}


def _digest(clusters):
    return hashlib.sha256(json.dumps(clusters, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _item(id_, source, title, dek="", hour=10):
    return {"id": id_, "source_id": source, "title": title, "dek": dek,
            "published_at": f"2026-09-25T{hour:02d}:00:00Z"}


# The fallback: no vectors is B2, byte for byte

@pytest.mark.parametrize("name", ["gold_2026-09-24.json", "gold_2026-09-24b.json"])
def test_no_vectors_clusters_byte_for_byte_as_b2(name):
    arts = load_fixture(BUNDLES / name)["articles"]
    assert _digest(cluster_items(arts)) == B2_DIGESTS[name]
    assert _digest(cluster_items(arts, vectors=None)) == B2_DIGESTS[name]
    assert _digest(cluster_items(arts, vectors={})) == B2_DIGESTS[name]
    # Vectors for ids the run does not have, or all-zero vectors, change nothing either.
    assert _digest(cluster_items(arts, vectors={"nope": array("b", [1, 2])})) == B2_DIGESTS[name]


def test_no_vectors_synthetic_run_is_b2():
    from test_cluster import _synthetic
    assert _digest(cluster_items(_synthetic(2000))) == B2_DIGESTS["synthetic_2000"]


# The term

PARA_A = _item("a", "bbc", "Ethiopian army says it repelled attacks in the north",
               "Government forces pushed back an assault near the regional border.", 8)
# They share one rare headline key ("Ethiopia", the demonym folded), so blocking admits
# the pair, but their lexical cosine is about 0.14, under every B2 threshold.
PARA_B = _item("b", "wsj", "Tigray rebels launch offensive in Ethiopia as truce collapses",
               "Fighting resumed in the north of the country after months of calm.", 9)


def _unit(k, dims=8):
    v = array("b", [0] * dims)
    v[k] = 100
    return v


def test_the_term_joins_a_paraphrase_the_lexical_score_leaves_apart(monkeypatch):
    # At full weight 0.5 (the shipped 0.2 is tuned for a whole run, where average links
    # and rare-entity bars differ), a same-direction pair clears B2's bar.
    monkeypatch.setattr(cluster, "EMBED_WEIGHT", 0.5)
    assert cluster_items([PARA_A, PARA_B]) == []
    same = {"a": _unit(0), "b": _unit(0)}
    got = cluster_items([PARA_A, PARA_B], vectors=same)
    assert [c["article_ids"] for c in got] == [["a", "b"]]
    assert got[0]["method"] == "cosine_entity+embedding"
    # Orthogonal vectors add nothing: the pair stays apart.
    assert cluster_items([PARA_A, PARA_B], vectors={"a": _unit(0), "b": _unit(1)}) == []
    # One vector alone is no pair term.
    assert cluster_items([PARA_A, PARA_B], vectors={"a": _unit(0)}) == []
    # Blocking still gates: with no shared rare key the pair is never scored.
    unblocked = dict(PARA_B, title="Rebels launch offensive as truce collapses")
    assert cluster_items([PARA_A, unblocked], vectors=same) == []


def test_the_term_is_the_rescaled_cosine_above_the_floor(monkeypatch):
    monkeypatch.setattr(cluster, "EMBED_WEIGHT", 0.5)
    monkeypatch.setattr(cluster, "EMBED_FLOOR", 0.6)
    monkeypatch.setattr(cluster, "EMBED_TERM_MIN", 0.0)
    a = (array("b", [100, 0]), 100.0)
    b = (array("b", [80, 60]), 100.0)  # cosine 0.8
    assert cluster._embed_term(a, b) == pytest.approx(0.5 * (0.8 - 0.6) / 0.4)
    c = (array("b", [0, 100]), 100.0)  # cosine 0: under the floor, clamped to 0
    assert cluster._embed_term(a, c) == 0.0
    assert cluster._embed_term(a, a) == pytest.approx(0.5)


def test_the_term_stays_behind_the_36_hour_span():
    far = dict(PARA_B, published_at="2026-09-27T09:00:00Z")  # 49 h after PARA_A
    assert cluster_items([PARA_A, far], vectors={"a": _unit(0), "b": _unit(0)}) == []


def test_the_term_never_joins_one_outlets_pieces_alone():
    same_outlet = dict(PARA_B, source_id="bbc")
    assert cluster_items([PARA_A, same_outlet], vectors={"a": _unit(0), "b": _unit(0)}) == []


def test_method_names_the_term():
    assert method_for(2, False, True) == "cosine_entity+embedding"
    assert method_for(3, True, True) == "minhash+cosine_entity+embedding"
    assert method_for(1, True, True) == "minhash"  # one unit: no score joined anything
    assert method_for(2, False) == "cosine_entity"
    assert set(cluster.METHODS) >= {"cosine_entity+embedding", "minhash+cosine_entity+embedding"}


def test_embedding_run_is_deterministic_in_any_input_order():
    arts = load_fixture(BUNDLES / "gold_2026-09-24b.json")["articles"]
    vecs = {a["id"]: _unit(hash(a["story"]) % 8) for a in arts}
    first = sorted(sorted(c["article_ids"]) for c in cluster_items(arts, vectors=vecs))
    again = sorted(sorted(c["article_ids"]) for c in cluster_items(arts[::-1], vectors=vecs))
    assert first == again


# Contract: +embedding needs 2+ units

def _pool_with(method, dups=()):
    from test_contract import GOLDEN
    pool = copy.deepcopy(GOLDEN)
    a0, a1 = pool["articles"][0]["id"], pool["articles"][1]["id"]
    pool["clusters"] = [{"id": "c1", "method": method, "article_ids": [a0, a1],
                         "near_duplicates": [list(d) for d in dups], "independent_sources": 2,
                         "lean_buckets": ["center-left"]}]
    return pool, a0, a1


def test_contract_accepts_embedding_only_where_a_score_joined_units():
    pool, a0, a1 = _pool_with("cosine_entity+embedding")
    assert validate(pool) == []
    pool, a0, a1 = _pool_with("minhash+embedding")
    assert validate(pool)
    pool, _, _ = _pool_with("cosine_entity+embedding")
    pool["clusters"][0]["near_duplicates"] = [pool["clusters"][0]["article_ids"]]
    pool["clusters"][0]["method"] = "minhash+cosine_entity+embedding"
    assert validate(pool)  # one unit: nothing was scored


# Text, quantizing, tokens

def test_text_is_the_headline_without_its_outlet_and_60_dek_words():
    dek = " ".join(f"w{k}" for k in range(80))
    text = embed.embed_text({"title": "Judge lifts ban on CNN - The Indian Express", "dek": dek})
    title, body = text.split("\n")
    assert title == "Judge lifts ban on CNN"
    assert body.split() == [f"w{k}" for k in range(60)]
    assert embed.embed_text({"title": "Xi lands", "dek": ""}) == "Xi lands"


def test_quantize_keeps_the_direction_in_signed_bytes():
    v = embed.quantize([0.5, -0.25, 0.0, 0.1, 9.0], dims=4)
    assert list(v) == [127, -64, 0, 25]
    assert embed.decode(embed.encode(v)) == v
    assert list(embed.quantize([0.0, 0.0], dims=2)) == [0, 0]


def test_token_estimate_is_conservative():
    assert embed.estimate_tokens("abcdef") == 2 + 2
    assert embed.neurons(1_000_000) == embed.NEURONS_PER_M_TOKENS


# Workers AI client (fake post)

class FakePost:
    """Fake POST for both the embedding calls and the GraphQL neuron read."""

    def __init__(self, dims=embed.DIMS, fail=None, usage=None, measured=0.0, delay=0.0):
        self.calls, self.dims, self.fail, self.usage = [], dims, fail, usage
        self.measured, self.delay, self.graphql = measured, delay, 0

    def __call__(self, url, token, payload, timeout):
        if url.endswith("/graphql"):
            self.graphql += 1
            return {"data": {"viewer": {"accounts": [{"aiInferenceAdaptiveGroups": [
                {"sum": {"totalNeurons": self.measured}}]}]}}}
        self.calls.append((url, payload))
        if self.delay:
            time.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        texts = payload.get("text") or payload.get("queries")
        res = {"shape": [len(texts), self.dims],
               "data": [[float(len(t) % 7 + 1)] + [0.5] * (self.dims - 1) for t in texts]}
        if self.usage:
            res["usage"] = {"prompt_tokens": self.usage}
        return {"success": True, "errors": [], "result": res}


def fake_get(plan="free"):
    def get(url, token, timeout):
        assert url.endswith("/subscriptions")
        if plan == "forbidden":
            raise _http_error(403, {"errors": [{"code": 10000}]})
        subs = [{"rate_plan": {"id": "free", "public_name": "Free Website", "scope": "zone"}}]
        if plan == "paid":
            subs.append({"rate_plan": {"id": "workers_paid", "public_name": "Workers Paid",
                                       "scope": "account"}})
        return {"success": True, "result": subs}
    return get


def _http_error(code, body):
    return urllib.error.HTTPError("https://x", code, "err", {}, BytesIO(json.dumps(body).encode()))


def test_client_posts_text_batches_and_reads_data():
    post = FakePost(usage=123)
    client = embed.WorkersAI("acct", "tok", post=post)
    data, reported = client.embed(["one", "two"])
    assert len(data) == 2 and reported == 123
    url, payload = post.calls[0]
    assert url.endswith(f"/accounts/acct/ai/run/{embed.MODEL}")
    assert payload == {"text": ["one", "two"]}
    assert client.batch == 32


def test_client_errors_are_short_statuses_without_the_token():
    for exc, want in ((_http_error(429, {"errors": [{"code": 4006, "message": "m"}]}), "cf_4006"),
                      (_http_error(401, {}), "http_401"),
                      (TimeoutError(), "timeout"),
                      (urllib.error.URLError("dns"), "network")):
        client = embed.WorkersAI("acct", "secret-token", post=FakePost(fail=exc))
        with pytest.raises(embed.EmbedError) as got:
            client.embed(["x"])
        assert str(got.value) == want
        assert "secret-token" not in str(got.value)


def test_client_refuses_a_short_or_odd_answer():
    def short(url, token, payload, timeout):
        return {"success": True, "result": {"data": [[1.0]]}}
    with pytest.raises(embed.EmbedError, match="bad_response"):
        embed.WorkersAI("a", "t", post=short).embed(["x", "y"])


# The run: plan check, cache, budget, fallbacks

ENV = {embed.TOKEN_ENV: "t", embed.ACCOUNT_ENV: "a"}


def _items(n, hour0=0):
    return [_item(f"i{k:03d}", f"s{k % 3}", f"Headline number {k}", "a dek", (hour0 + k) % 24)
            for k in range(n)]


def _run(items, tmp_path, post=None, get=None, **kw):
    return embed.run(items, NOW, env=kw.pop("env", ENV), cache_path=tmp_path / "e.json",
                     post=post or FakePost(), get=get or fake_get(), **kw)


def test_run_without_a_token_calls_nothing_and_writes_nothing(tmp_path):
    post = FakePost()
    vectors, budget, stats = _run(_items(5), tmp_path, post=post, env={})
    assert vectors == {} and post.calls == [] and post.graphql == 0
    assert not (tmp_path / "e.json").exists()
    assert stats["state"] == "no_token" and stats["missing"] == 5
    assert budget == {"day": "2026-09-25", "neurons": 0.0}
    _, _, stats = _run(_items(1), tmp_path, env={embed.TOKEN_ENV: "t"})
    assert stats["state"] == "no_account"


@pytest.mark.parametrize("plan,state", [("paid", "plan_paid"),
                                        ("forbidden", "plan_unconfirmed:cf_10000")])
def test_run_calls_nothing_unless_the_plan_is_workers_free(tmp_path, plan, state):
    post = FakePost()
    vectors, budget, stats = _run(_items(5), tmp_path, post=post, get=fake_get(plan))
    assert vectors == {} and post.calls == [] and stats["state"] == state
    assert not (tmp_path / "e.json").exists()


def test_run_embeds_only_new_items_and_carries_the_cache(tmp_path):
    post = FakePost()
    v1, b1, s1 = _run(_items(40), tmp_path, post=post)
    assert (s1["embedded"], s1["cached"], s1["batches"], s1["plan"]) == (40, 0, 2, "free")
    assert len(v1) == 40 and b1["neurons"] > 0 and len(v1["i000"]) == embed.DIMS
    post2 = FakePost()
    v2, b2, s2 = _run(_items(45), tmp_path, post=post2, previous_budget=b1)
    assert (s2["embedded"], s2["cached"], s2["missing"]) == (5, 40, 0)
    assert len(post2.calls) == 1 and len(post2.calls[0][1]["text"]) == 5
    assert b2["neurons"] > b1["neurons"]
    assert all(v1[k] == v2[k] for k in v1)
    assert s2["cache_status"] == "hit" and s2["cache_items"] == 45


def test_budget_stops_embedding_and_the_rest_fall_back(tmp_path):
    near = {"day": "2026-09-25", "neurons": embed.DAILY_NEURON_BUDGET - 0.01}
    post = FakePost()
    vectors, budget, stats = _run(_items(20), tmp_path, post=post, previous_budget=near)
    assert post.calls == [] and vectors == {}
    assert stats["state"] == "budget" and stats["missing"] == 20
    assert budget["neurons"] == pytest.approx(near["neurons"], abs=0.01)
    # A new UTC day starts from zero.
    yesterday = {"day": "2026-09-24", "neurons": embed.DAILY_NEURON_BUDGET}
    assert embed.budget_today(yesterday, NOW) == ("2026-09-25", 0.0)


def test_budget_counts_the_accounts_measured_neurons_when_higher(tmp_path):
    post = FakePost(measured=embed.DAILY_NEURON_BUDGET)  # state.json says 0, the account says full
    vectors, budget, stats = _run(_items(5), tmp_path, post=post)
    assert post.calls == [] and stats["state"] == "budget"
    assert stats["neurons_measured"] == embed.DAILY_NEURON_BUDGET
    assert budget["neurons"] == embed.DAILY_NEURON_BUDGET


def test_budget_charges_the_higher_of_estimate_and_reported():
    client = embed.WorkersAI("a", "t", post=FakePost(usage=10_000))
    _, stats = embed.vectors_for(_items(3), client, {}, NOW)
    assert stats["neurons"] == pytest.approx(embed.neurons(10_000))


def test_an_api_error_falls_back_for_the_rest_of_the_run(tmp_path):
    post = FakePost(fail=_http_error(500, {}))
    vectors, budget, stats = _run(_items(5), tmp_path, post=post)
    assert vectors == {} and stats["state"] == "api_error:http_500" and len(post.calls) == 1
    assert budget["neurons"] > 0  # a failed call is charged its estimate


def test_time_cap_leaves_the_rest_for_the_next_run():
    client = embed.WorkersAI("a", "t", post=FakePost(delay=0.3))
    client.batch = 1
    vectors, stats = embed.vectors_for(_items(8), client, {}, NOW, max_seconds=0.5, workers=1)
    assert stats["state"] == "time_cap" and 0 < len(vectors) < 8


def test_newest_items_are_embedded_first():
    post = FakePost()
    client = embed.WorkersAI("a", "t", post=post)
    client.batch = 2
    items = _items(6)
    embed.vectors_for(items, client, {}, NOW, workers=1)
    newest = sorted(items, key=lambda it: (it["published_at"], it["id"]), reverse=True)[:2]
    assert post.calls[0][1]["text"] == [embed.embed_text(it) for it in newest]


def test_cache_prunes_stale_entries_and_starts_over_on_a_new_model(tmp_path):
    path = tmp_path / "e.json"
    hour = int(NOW.timestamp() // 3600)
    entries = {"old": ["AAA=", hour - embed.CACHE_KEEP_HOURS - 1], "new": ["AAA=", hour - 1]}
    count, size = embed.save_cache(entries, hour, path)
    assert count == 1 and size == path.stat().st_size
    got, status = embed.load_cache(path)
    assert status == "hit" and set(got) == {"new"}
    assert embed.load_cache(path, model="@cf/other") == ({}, "model_changed")
    assert embed.load_cache(path, dims=embed.DIMS // 2) == ({}, "model_changed")
    path.write_text("{not json")
    assert embed.load_cache(path) == ({}, "corrupt")
    assert embed.load_cache(tmp_path / "none.json") == ({}, "absent")


def test_log_line_has_counts_only(tmp_path):
    _, budget, stats = _run(_items(3), tmp_path)
    line = embed.log_line(stats, budget)
    assert "plan=free state=ok fallback=none embedded=3 cached=0" in line
    assert "neurons_measured_before=0.0" in line and "tok" not in line.replace("tokens_", "")
    _, budget, stats = _run(_items(3), tmp_path, env={})
    assert "fallback=all_lexical" in embed.log_line(stats, budget)


# The Workers plan check and the bake-off workflow

def test_workers_plan_reads_a_workers_paid_subscription():
    assert workers_plan([]) == "free"
    assert workers_plan([{"rate_plan": {"id": "free", "public_name": "Free Website"}}]) == "free"
    assert workers_plan([{"rate_plan": {"id": "workers_paid", "public_name": "Workers Paid"}}]) == "paid"
    assert workers_plan([{"rate_plan": {"id": "PARTNERS_WORKERS_SS", "public_name": ""}}]) == "paid"


def test_bakeoff_workflow_is_manual_only_and_names_secrets_only():
    wf = (ROOT / ".github/workflows/bakeoff.yml").read_text(encoding="utf-8")
    on = wf.split("\non:", 1)[1].split("\npermissions:", 1)[0]
    assert "workflow_dispatch" in on
    assert "schedule" not in on and "push" not in on and "cron" not in on
    assert "secrets.CLOUDFLARE_PIPELINE_TOKEN" in wf and "secrets.CLOUDFLARE_ACCOUNTID" in wf
    assert not re.search(r"echo[^\n]*\$\{?(CF_|CLOUDFLARE_)", wf)  # never echoes a secret
    assert "embed_bakeoff plan" in wf.split("embed_bakeoff embed")[0]  # plan check first


# Timing: the design's 10,000-item benchmark with a vector on every item (768 signed
# bytes each), embedding calls excluded since they are cached and batched.

def test_clustering_10000_items_with_vectors_finishes_under_budget(capsys):
    import random
    import time as _time
    from test_cluster import CLUSTER_BUDGET_SECONDS, _synthetic
    items = _synthetic(10_000)
    rng = random.Random(7)
    centers, vectors = {}, {}
    for it in items:
        c = centers.setdefault(it["title"].split()[0], [rng.gauss(0, 1) for _ in range(embed.DIMS)])
        vectors[it["id"]] = array("b", [max(-127, min(127, round(20 * (x + rng.gauss(0, 0.8)))))
                                        for x in c])
    t0 = _time.perf_counter()
    clusters = cluster_items(items, vectors=vectors)
    elapsed = _time.perf_counter() - t0
    with capsys.disabled():
        print(f"\nB7 benchmark: cluster_items(10000 synthetic, vectors) {elapsed:.2f}s, "
              f"{len(clusters)} clusters")
    assert elapsed < CLUSTER_BUDGET_SECONDS
    ids = [i for c in clusters for i in c["article_ids"]]
    assert len(ids) == len(set(ids))


# The fetch path (fanout): the embedder, the published method, state.json, the log

def _quake_pool(**kw):
    from test_bundle_eval import NOON, _feeds
    from fetcher.fanout import build_pool_fanout
    sources, results = _feeds()
    return build_pool_fanout(sources, results, NOON, **kw)


def test_fetch_path_without_vectors_is_the_b2_pool_byte_for_byte():
    from fetcher.fanout import dumps
    plain = dumps(_quake_pool())
    assert dumps(_quake_pool(embedder=lambda c: {})) == plain
    assert dumps(_quake_pool(embedder=lambda c: None)) == plain


def test_fetch_path_with_vectors_publishes_the_embedding_method():
    seen = []

    def embedder(cands):
        seen.append(len(cands))
        return {c["id"]: _unit(0) for c in cands}

    pool = _quake_pool(embedder=embedder)
    assert seen == [5]
    assert validate(pool) == []
    assert [c["method"] for c in pool["clusters"]] == ["cosine_entity+embedding"]


def test_main_keeps_the_budget_in_state_and_logs_one_embed_line(monkeypatch, tmp_path, capsys):
    from test_bundle_eval import _offline
    from fetcher import fanout, state
    args = _offline(monkeypatch, tmp_path)
    monkeypatch.setenv(embed.TOKEN_ENV, "t")
    monkeypatch.setenv(embed.ACCOUNT_ENV, "a")
    monkeypatch.setattr(embed, "CACHE_PATH", str(tmp_path / "e.json"))
    post = FakePost()
    real_run = embed.run
    monkeypatch.setattr(embed, "run", lambda items, now, previous_budget=None: real_run(
        items, now, previous_budget=previous_budget, cache_path=tmp_path / "e.json",
        post=post, get=fake_get()))
    assert fanout.main(args + ["--out", str(tmp_path / "dist" / "pool.json")]) == 0
    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if l.startswith("embed "))
    assert "plan=free state=ok embedded=5" in line.replace("fallback=none ", "")
    assert "cluster_methods=" in line and "secret" not in line
    doc = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state.validate_state(doc) == []
    assert doc["embed_budget"]["neurons"] > 0
    # The next run reads it back and embeds nothing new.
    assert fanout.main(args + ["--out", str(tmp_path / "dist" / "pool.json")]) == 0
    line = next(l for l in capsys.readouterr().out.splitlines() if l.startswith("embed "))
    assert "embedded=0 cached=5" in line


def test_main_publishes_lexically_when_embedding_blows_up(monkeypatch, tmp_path, capsys):
    from test_bundle_eval import _offline
    from fetcher import fanout
    args = _offline(monkeypatch, tmp_path)

    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(embed, "run", boom)
    assert fanout.main(args + ["--out", str(tmp_path / "dist" / "pool.json")]) == 0
    assert "clustering lexically" in capsys.readouterr().err


def test_state_embed_budget_is_optional_and_checked():
    from fetcher import state
    pool = _quake_pool()
    doc = state.build_state(pool)
    assert "embed_budget" not in doc and state.validate_state(doc) == []
    doc = state.build_state(pool, {"day": "2026-09-25", "neurons": 12.5})
    assert state.validate_state(doc) == []
    assert state.embed_budget_from(state.dumps_state(doc).encode()) == {"day": "2026-09-25", "neurons": 12.5}
    for bad in ({"day": "2026-09-25"}, {"day": 1, "neurons": 1}, {"day": "d", "neurons": -1}, []):
        assert state.validate_state(dict(doc, embed_budget=bad))


def test_publish_passes_the_token_by_name_and_caches_the_vectors():
    wf = (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")
    fetch = wf.split("- name: Fetch", 1)[1].split("\n      - ", 1)[0]
    assert "CF_PIPELINE_TOKEN: ${{ secrets.CLOUDFLARE_PIPELINE_TOKEN }}" in fetch
    assert "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNTID }}" in fetch
    assert wf.count("path: .cache/embeddings.json") == 2
    assert "embed-${{ github.run_id }}-${{ github.run_attempt }}" in wf
    assert wf.count("path: .cache/state.json") == 2  # F6's cache untouched
