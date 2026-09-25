"""B7: the embedding term (DESIGN-bundles section 2(b)). No network: every Workers AI call
here goes to a fake post function."""
import copy
import hashlib
import json
import re
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
from fetcher.embed_bakeoff import workers_plan

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


def test_the_term_joins_a_paraphrase_the_lexical_score_leaves_apart():
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
    def __init__(self, dims=4, fail=None, usage=None):
        self.calls, self.dims, self.fail, self.usage = [], dims, fail, usage

    def __call__(self, url, token, payload, timeout):
        self.calls.append((url, payload))
        if self.fail is not None:
            raise self.fail
        texts = payload.get("text") or payload.get("queries")
        res = {"shape": [len(texts), self.dims],
               "data": [[float(len(t) % 7 + 1)] + [0.5] * (self.dims - 1) for t in texts]}
        if self.usage:
            res["usage"] = {"prompt_tokens": self.usage}
        return {"success": True, "errors": [], "result": res}


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


# The run: cache, budget, fallbacks

def _items(n, hour0=0):
    return [_item(f"i{k:03d}", f"s{k % 3}", f"Headline number {k}", "a dek", (hour0 + k) % 24)
            for k in range(n)]


def test_run_without_a_token_calls_nothing_and_writes_nothing(tmp_path):
    post = FakePost()
    vectors, budget, stats = embed.run(_items(5), NOW, env={}, cache_path=tmp_path / "e.json", post=post)
    assert vectors == {} and post.calls == [] and not (tmp_path / "e.json").exists()
    assert stats["state"] == "no_token" and stats["missing"] == 5
    assert budget == {"day": "2026-09-25", "neurons": 0.0}
    _, _, stats = embed.run(_items(1), NOW, env={embed.TOKEN_ENV: "t"}, cache_path=tmp_path / "e.json")
    assert stats["state"] == "no_account"


def test_run_embeds_only_new_items_and_carries_the_cache(tmp_path):
    env = {embed.TOKEN_ENV: "t", embed.ACCOUNT_ENV: "a"}
    path = tmp_path / "e.json"
    post = FakePost(dims=embed.DIMS)
    v1, b1, s1 = embed.run(_items(150), NOW, env=env, cache_path=path, post=post)
    assert (s1["embedded"], s1["cached"], s1["batches"]) == (150, 0, 2)  # batches of 100
    assert len(v1) == 150 and b1["neurons"] > 0
    post2 = FakePost(dims=embed.DIMS)
    v2, b2, s2 = embed.run(_items(160), NOW, previous_budget=b1, env=env, cache_path=path, post=post2)
    assert (s2["embedded"], s2["cached"], s2["missing"]) == (10, 150, 0)
    assert len(post2.calls) == 1 and len(post2.calls[0][1]["text"]) == 10
    assert b2["neurons"] > b1["neurons"]
    assert all(v1[k] == v2[k] for k in v1)
    assert s2["cache_status"] == "hit" and s2["cache_items"] == 160


def test_budget_stops_embedding_and_the_rest_fall_back(tmp_path):
    env = {embed.TOKEN_ENV: "t", embed.ACCOUNT_ENV: "a"}
    near = {"day": "2026-09-25", "neurons": embed.DAILY_NEURON_BUDGET - 0.01}
    post = FakePost(dims=embed.DIMS)
    vectors, budget, stats = embed.run(_items(20), NOW, previous_budget=near, env=env,
                                       cache_path=tmp_path / "e.json", post=post)
    assert post.calls == [] and vectors == {}
    assert stats["state"] == "budget" and stats["missing"] == 20
    assert budget["neurons"] == pytest.approx(near["neurons"], abs=0.01)
    # A new UTC day starts from zero.
    yesterday = {"day": "2026-09-24", "neurons": embed.DAILY_NEURON_BUDGET}
    assert embed.budget_today(yesterday, NOW) == ("2026-09-25", 0.0)


def test_budget_charges_the_higher_of_estimate_and_reported(tmp_path):
    cache = {}
    client = embed.WorkersAI("a", "t", post=FakePost(dims=embed.DIMS, usage=10_000))
    _, stats = embed.vectors_for(_items(3), client, cache, NOW)
    assert stats["neurons"] == pytest.approx(embed.neurons(10_000))


def test_an_api_error_falls_back_for_the_rest_of_the_run(tmp_path):
    env = {embed.TOKEN_ENV: "t", embed.ACCOUNT_ENV: "a"}
    post = FakePost(fail=_http_error(500, {}))
    vectors, budget, stats = embed.run(_items(5), NOW, env=env, cache_path=tmp_path / "e.json", post=post)
    assert vectors == {} and stats["state"] == "api_error:http_500" and len(post.calls) == 1


def test_time_cap_leaves_the_rest_for_the_next_run():
    ticks = iter(range(0, 1000, 60))
    client = embed.WorkersAI("a", "t", post=FakePost(dims=embed.DIMS))
    client.batch = 1
    vectors, stats = embed.vectors_for(_items(10), client, {}, NOW, clock=lambda: next(ticks),
                                       max_seconds=90)
    assert stats["state"] == "time_cap" and 0 < len(vectors) < 10


def test_newest_items_are_embedded_first():
    post = FakePost(dims=embed.DIMS)
    client = embed.WorkersAI("a", "t", post=post)
    client.batch = 2
    items = _items(6)
    embed.vectors_for(items, client, {}, NOW)
    first = post.calls[0][1]["text"]
    newest = sorted(items, key=lambda it: (it["published_at"], it["id"]), reverse=True)[:2]
    assert first == [embed.embed_text(it) for it in newest]


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


def test_log_line_has_counts_only():
    stats = {"state": "ok", "embedded": 3, "cached": 7, "missing": 0, "batches": 1,
             "api_seconds": 0.4, "tokens_estimated": 90, "tokens_reported": 0, "neurons": 0.1,
             "cache_status": "hit", "cache_items": 10, "cache_bytes": 999}
    line = embed.log_line(stats, {"day": "2026-09-25", "neurons": 12.3})
    assert "embedded=3 cached=7" in line and "fallback=none" in line and "neurons_day=12.3" in line


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
