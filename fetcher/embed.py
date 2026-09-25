"""B7: sentence vectors for the story stage's embedding term. Standard library only (R30).

DESIGN-bundles section 2(b), free route first (R40 answer 1): Cloudflare Workers AI's
REST API, called in batches with the cron-held pipeline token. The vector is only an
input: the grouping stays local (R8), it writes no text and nothing a model writes
reaches the reader (R13). fetcher.cluster uses it as one term inside B2's pairwise
score, behind B2's gates.

- Model: @cf/qwen/qwen3-embedding-0.6b, chosen by the bake-off (fetcher/embed_bakeoff.py,
  .github/workflows/bakeoff.yml) over @cf/baai/bge-m3 and qwen3 with an instruction.
  Its vectors are Matryoshka-trained, so the first DIMS of 1024 keep the direction.
- Text: the headline (outlet suffix stripped, as the story stage does) plus the first
  DEK_WORDS words of the dek.
- Vectors are cut to DIMS and stored as signed 8-bit integers (one scale per vector,
  dropped: only the direction matters for a cosine).
- Cache: .cache/embeddings.json, restored and saved by actions/cache beside F6's
  state.json, keyed by article id, so only new items are embedded. An entry not seen
  for CACHE_KEEP_HOURS is pruned; a different model or DIMS starts the cache over.
- Zero charges. Every run first reads the account's subscriptions (Billing Read) and
  calls nothing unless no Workers Paid subscription is there: on Workers Free, calls
  past the daily allocation fail rather than bill. Then a hard daily neuron cap
  (DAILY_NEURON_BUDGET of the 10,000 free neurons each UTC day), tracked in state.json
  and raised to the account's own measured count for the day (GraphQL, Account
  Analytics Read) when that is higher. Before each batch the run charges a
  conservative estimate (UTF-8 bytes / 3 per text, plus two tokens), or the API's own
  token count when that is higher. When the next batch would pass the cap, the run
  stops embedding and the rest of its items cluster lexically.
- Fallback: no token, no account id, an unconfirmed plan, an API error, the budget or
  the time cap all leave items without a vector. Pairs without two vectors score
  exactly as B2 does, and a run with no vectors at all clusters byte for byte as B2.

Nothing here ever prints or logs the token or the account id; the log line carries
counts and statuses only.
"""
import base64
import concurrent.futures
import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from array import array
from pathlib import Path

from fetcher.cluster import _strip_outlet

MODEL = "@cf/qwen/qwen3-embedding-0.6b"
DIMS = 768
DEK_WORDS = 60
BATCH = {"@cf/baai/bge-m3": 100, "@cf/qwen/qwen3-embedding-0.6b": 32}  # the models' maxItems
WORKERS = 6  # batches in flight; a qwen3 batch of 32 took 3.4 s in the bake-off
NEURONS_PER_M_TOKENS = 1075  # both candidates, developers.cloudflare.com/workers-ai/platform/pricing
FREE_NEURONS_PER_DAY = 10_000
DAILY_NEURON_BUDGET = 8_000
BYTES_PER_TOKEN = 3  # conservative: English runs about 4 characters a token
TOKENS_PER_TEXT = 2  # the model's start and end markers
MAX_SECONDS = 90  # wall clock for all calls in one run; the rest wait for the next run
TIMEOUT = 30
CACHE_PATH = ".cache/embeddings.json"
CACHE_SCHEMA = 1
CACHE_KEEP_HOURS = 48
TOKEN_ENV = "CF_PIPELINE_TOKEN"
ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID"
CF = "https://api.cloudflare.com/client/v4"
API = CF + "/accounts/{account}/ai/run/{model}"


class EmbedError(Exception):
    """A call failed. The message is a short status (http_401, cf_4006, timeout), never
    a response body, a url with the account id, or the token."""


def embed_text(item):
    title = _strip_outlet(item["title"]).strip()
    dek = " ".join((item.get("dek") or "").split()[:DEK_WORDS])
    return f"{title}\n{dek}" if dek else title


def estimate_tokens(text):
    return math.ceil(len(text.encode("utf-8")) / BYTES_PER_TOKEN) + TOKENS_PER_TEXT


def neurons(tokens):
    return tokens * NEURONS_PER_M_TOKENS / 1_000_000


def quantize(values, dims=DIMS):
    """Floats from the API, cut to dims, as a direction in signed 8 bits: array('b')."""
    v = [float(x) for x in values[:dims]]
    peak = max((abs(x) for x in v), default=0.0)
    if not peak:
        return array("b", [0] * len(v))
    scale = 127 / peak
    return array("b", [max(-127, min(127, round(x * scale))) for x in v])


def encode(vec):
    return base64.b64encode(vec.tobytes()).decode("ascii")


def decode(text):
    vec = array("b")
    vec.frombytes(base64.b64decode(text))
    return vec


# HTTP (injectable: tests never touch the network)

def _post_json(url, token, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _get_json(url, token, timeout):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _cf_code(body):
    try:
        errs = json.loads(body).get("errors") or []
        return int(errs[0]["code"]) if errs else None
    except (ValueError, KeyError, TypeError, IndexError, AttributeError):
        return None


def _status(exc):
    """A short status for any failed call, never its body or url."""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            code = _cf_code(exc.read())
        except OSError:
            code = None
        return f"cf_{code}" if code else f"http_{exc.code}"
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, urllib.error.URLError):
        return "timeout" if isinstance(exc.reason, (socket.timeout, TimeoutError)) else "network"
    return "network"


class WorkersAI:
    """One model on the Workers AI REST API."""

    def __init__(self, account, token, model=MODEL, timeout=TIMEOUT, post=_post_json,
                 instruction=None):
        self.url = API.format(account=account, model=model)
        self.token, self.model, self.timeout, self.post = token, model, timeout, post
        self.instruction = instruction
        self.batch = BATCH.get(model, 32)

    def payload(self, texts):
        if self.instruction:  # qwen3's query side: the instruction is prepended by the model
            return {"queries": list(texts), "instruction": self.instruction}
        return {"text": list(texts)}

    def embed(self, texts):
        """Vectors (lists of floats) for texts, in order, and the token count the API
        reported, or None when it reported none. Raises EmbedError."""
        try:
            doc = self.post(self.url, self.token, self.payload(texts), self.timeout)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise EmbedError(_status(exc)) from None
        if not isinstance(doc, dict) or not doc.get("success", True):
            code = None
            if isinstance(doc, dict) and doc.get("errors"):
                code = (doc["errors"][0] or {}).get("code")
            raise EmbedError(f"cf_{code}" if code else "bad_response")
        res = doc.get("result", doc)
        data = res.get("data") if isinstance(res, dict) else None
        if not isinstance(data, list) or len(data) != len(texts):
            raise EmbedError("bad_response")
        if any(not isinstance(v, list) or not v for v in data):
            raise EmbedError("bad_response")
        usage = res.get("usage") if isinstance(res, dict) else None
        reported = None
        if isinstance(usage, dict):
            reported = usage.get("prompt_tokens") or usage.get("total_tokens")
            reported = reported if isinstance(reported, int) else None
        return data, reported


def workers_plan(subscriptions):
    """paid when any subscription's rate plan is a Workers one other than free (Workers
    Paid, or a partner Workers plan), else free."""
    for sub in subscriptions:
        rp = (sub or {}).get("rate_plan") or {}
        name = f"{rp.get('id', '')} {rp.get('public_name', '')}".lower()
        if "worker" in name and "free" not in name:
            return "paid"
    return "free"


def check_plan(account, token, get=_get_json, timeout=TIMEOUT):
    """free, paid, or unconfirmed:<status>. Only free lets a run call Workers AI."""
    try:
        doc = get(f"{CF}/accounts/{account}/subscriptions", token, timeout)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return f"unconfirmed:{_status(exc)}"
    if not isinstance(doc, dict) or not doc.get("success") or not isinstance(doc.get("result"), list):
        return "unconfirmed:bad_response"
    return workers_plan(doc["result"])


NEURONS_QUERY = (
    "query($a: String!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) { "
    "aiInferenceAdaptiveGroups(filter: {date_geq: $d, date_leq: $d}, limit: 1) "
    "{ sum { totalNeurons } } } } }")


def measured_neurons(account, token, day, post=_post_json, timeout=TIMEOUT):
    """The account's Workers AI neurons charged on day (UTC), or None when unreadable."""
    try:
        doc = post(f"{CF}/graphql", token, {"query": NEURONS_QUERY,
                                           "variables": {"a": account, "d": day}}, timeout)
        groups = doc["data"]["viewer"]["accounts"][0]["aiInferenceAdaptiveGroups"]
        total = groups[0]["sum"]["totalNeurons"] if groups else 0
        return float(total) if isinstance(total, (int, float)) and total >= 0 else None
    except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, TypeError,
            AttributeError):
        return None


# Cache

def load_cache(path=CACHE_PATH, model=MODEL, dims=DIMS):
    """({id: [b64 vector, last seen epoch hour]}, status). Status: hit, absent, corrupt,
    or model_changed (a different model or DIMS: nothing carries over). Never raises."""
    p = Path(path)
    if not p.exists():
        return {}, "absent"
    try:
        doc = json.loads(p.read_bytes())
        items = doc["items"]
        if not isinstance(items, dict) or doc.get("schema_version") != CACHE_SCHEMA:
            return {}, "corrupt"
        if doc.get("model") != model or doc.get("dims") != dims:
            return {}, "model_changed"
        clean = {}
        for k, v in items.items():
            if (isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)
                    and isinstance(v[1], int)):
                clean[k] = v
        return clean, "hit"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}, "corrupt"


def save_cache(entries, now_hour, path=CACHE_PATH, model=MODEL, dims=DIMS):
    """Prune entries not seen for CACHE_KEEP_HOURS, write, and return (items, bytes)."""
    keep = {k: v for k, v in sorted(entries.items()) if now_hour - v[1] <= CACHE_KEEP_HOURS}
    body = json.dumps({"schema_version": CACHE_SCHEMA, "model": model, "dims": dims,
                       "items": keep}, separators=(",", ":")).encode("utf-8")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return len(keep), len(body)


# Budget (state.json `embed_budget`)

def budget_today(previous, now):
    """Neurons already charged on now's UTC day, from state.json's embed_budget."""
    day = now.strftime("%Y-%m-%d")
    if isinstance(previous, dict) and previous.get("day") == day:
        used = previous.get("neurons")
        if isinstance(used, (int, float)) and used >= 0:
            return day, float(used)
    return day, 0.0


# The run

def _stats(**kw):
    base = {"state": "ok", "plan": "unchecked", "embedded": 0, "cached": 0, "missing": 0,
            "batches": 0, "api_seconds": 0.0, "tokens_estimated": 0, "tokens_reported": 0,
            "neurons": 0.0, "neurons_measured": None, "cache_status": "unused",
            "cache_items": 0, "cache_bytes": 0}
    base.update(kw)
    return base


def vectors_for(items, client, cache, now, budget_used=0.0, budget=DAILY_NEURON_BUDGET,
                max_seconds=MAX_SECONDS, workers=WORKERS, dims=DIMS):
    """Vectors for items from the cache, embedding the missing ones newest first.

    Returns (vectors {id: array('b')}, stats). Updates cache in place (every item seen
    gets this hour as its last seen). Batches are reserved against the budget in order,
    newest first, then run `workers` at a time until max_seconds; a batch not started by
    then is dropped and not charged. stats: state (ok, budget, time_cap,
    api_error:<status>), embedded, cached, missing, batches, api_seconds (summed over
    calls), tokens_estimated, tokens_reported, neurons (charged this run)."""
    hour = int(now.timestamp() // 3600)
    vectors, todo = {}, []
    for it in items:
        got = cache.get(it["id"])
        if got is not None:
            got[1] = hour
            vectors[it["id"]] = decode(got[0])
        else:
            todo.append(it)
    stats = _stats(cached=len(vectors))
    todo.sort(key=lambda it: (it["published_at"], it["id"]), reverse=True)

    planned, used = [], budget_used
    for k in range(0, len(todo), client.batch):
        chunk = todo[k:k + client.batch]
        texts = [embed_text(it) for it in chunk]
        est = sum(estimate_tokens(t) for t in texts)
        if client.instruction:
            est += estimate_tokens(client.instruction) * len(texts)
        if used + neurons(est) > budget:
            stats["state"] = "budget"
            break
        used += neurons(est)
        planned.append((chunk, texts, est))

    def call(texts):
        t0 = time.monotonic()
        try:
            return client.embed(texts), None, time.monotonic() - t0
        except EmbedError as exc:
            return None, str(exc), time.monotonic() - t0

    start = time.monotonic()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers))
    futures = [pool.submit(call, texts) for _, texts, _ in planned]
    errors = []
    try:
        for (chunk, texts, est), fut in zip(planned, futures):
            left = max_seconds - (time.monotonic() - start)
            try:
                result, err, secs = fut.result(timeout=max(left, 0.001))
            except concurrent.futures.TimeoutError:
                if stats["state"] == "ok":
                    stats["state"] = "time_cap"
                # Charged if it started: a call in flight may still be billed as usage.
                if fut.running() or fut.done():
                    stats["neurons"] += neurons(est)
                continue
            stats["api_seconds"] += secs
            if err is not None:
                errors.append(err)
                stats["neurons"] += neurons(est)  # a failed call may still be charged
                continue
            data, reported = result
            stats["batches"] += 1
            stats["neurons"] += neurons(max(est, reported or 0))
            stats["tokens_estimated"] += est
            stats["tokens_reported"] += reported or 0
            for it, values in zip(chunk, data):
                vec = quantize(values, dims)
                cache[it["id"]] = [encode(vec), hour]
                vectors[it["id"]] = vec
                stats["embedded"] += 1
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    if errors and stats["state"] == "ok":
        stats["state"] = f"api_error:{errors[0]}"
    stats["missing"] = len(items) - len(vectors)
    return vectors, stats


def run(items, now, previous_budget=None, env=None, cache_path=CACHE_PATH, post=_post_json,
        get=_get_json, max_seconds=MAX_SECONDS):
    """The fetcher's entry point: (vectors, embed_budget for state.json, stats).

    With no token or account id, or a plan that is not confirmed Workers Free, nothing
    is embedded, the cache is left as it is, and the vectors come back empty, so the
    clusterer runs exactly as B2."""
    env = os.environ if env is None else env
    token, account = env.get(TOKEN_ENV, ""), env.get(ACCOUNT_ENV, "")
    day, used = budget_today(previous_budget, now)
    budget_state = {"day": day, "neurons": round(used, 2)}
    if not token or not account:
        state = "no_token" if not token else "no_account"
        return {}, budget_state, _stats(state=state, missing=len(items))
    plan = check_plan(account, token, get=get)
    if plan != "free":
        return {}, budget_state, _stats(state=f"plan_{plan}", plan=plan, missing=len(items))
    measured = measured_neurons(account, token, day, post=post)
    used = max(used, measured or 0.0)
    cache, cache_status = load_cache(cache_path)
    client = WorkersAI(account, token, post=post)
    vectors, stats = vectors_for(items, client, cache, now, budget_used=used,
                                 max_seconds=max_seconds)
    stats.update(plan=plan, neurons_measured=measured, cache_status=cache_status)
    stats["cache_items"], stats["cache_bytes"] = save_cache(
        cache, int(now.timestamp() // 3600), cache_path)
    return vectors, {"day": day, "neurons": round(used + stats["neurons"], 2)}, stats


def log_line(stats, budget_state):
    """The run's one embedding line: counts and statuses only (the log is public)."""
    fallback = "none" if stats["state"] == "ok" and not stats["missing"] else (
        "all_lexical" if not stats["embedded"] and not stats["cached"]
        else f"lexical_for_{stats['missing']}")
    measured = stats.get("neurons_measured")
    return (
        f"embed model={MODEL} dims={DIMS} plan={stats['plan']} state={stats['state']} "
        f"fallback={fallback} embedded={stats['embedded']} cached={stats['cached']} "
        f"missing={stats['missing']} batches={stats['batches']} "
        f"api_seconds={stats['api_seconds']:.2f} tokens_est={stats['tokens_estimated']} "
        f"tokens_reported={stats['tokens_reported']} neurons_run={stats['neurons']:.1f} "
        f"neurons_measured_before={'unread' if measured is None else f'{measured:.1f}'} "
        f"neurons_day={budget_state['neurons']:.1f} budget_day={DAILY_NEURON_BUDGET} "
        f"day={budget_state['day']} cache={stats['cache_status']} "
        f"cache_items={stats['cache_items']} cache_bytes={stats['cache_bytes']}"
    )
