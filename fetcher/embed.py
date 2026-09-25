"""B7: sentence vectors for the story stage's embedding term. Standard library only (R30).

DESIGN-bundles section 2(b), free route first (R40 answer 1): Cloudflare Workers AI's
REST API, called in batches with the cron-held pipeline token. The vector is only an
input: the grouping stays local (R8), it writes no text and nothing a model writes
reaches the reader (R13). fetcher.cluster uses it as one term inside B2's pairwise
score, behind B2's gates.

- Text: the headline (outlet suffix stripped, as the story stage does) plus the first
  DEK_WORDS words of the dek.
- Vectors are cut to DIMS, unit-normalized and stored as signed 8-bit integers (one
  scale per vector, dropped: only the direction matters for a cosine).
- Cache: .cache/embeddings.json, restored and saved by actions/cache beside F6's
  state.json, keyed by article id, so only new items are embedded. An entry not seen
  for CACHE_KEEP_HOURS is pruned; a different model or DIMS starts the cache over.
- Budget: a hard daily neuron cap (DAILY_NEURON_BUDGET, under the 10,000 free
  neurons Workers AI gives every account each UTC day), tracked in state.json. Before
  each batch the run charges a conservative estimate (UTF-8 bytes / 3 per text, plus
  two tokens); it charges the API's own token count instead when that is higher. When
  the next batch would pass the cap, the run stops embedding and the rest of its items
  cluster lexically.
- Fallback: no token, no account id, an API error, the budget or the time cap all
  leave items without a vector. Pairs without two vectors score exactly as B2 does,
  and a run with no vectors at all clusters byte for byte as B2 (tests assert it).

Nothing here ever prints or logs the token; the log line carries counts only.
"""
import base64
import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from array import array
from datetime import datetime, timezone
from pathlib import Path

from fetcher.cluster import _strip_outlet

# Chosen by the bake-off (.github/workflows/bakeoff.yml, fetcher/embed_bakeoff.py).
MODEL = "@cf/baai/bge-m3"
DIMS = 1024
DEK_WORDS = 60
BATCH = {"@cf/baai/bge-m3": 100, "@cf/qwen/qwen3-embedding-0.6b": 32}
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
API = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
FREE_ALLOCATION_USED = 4006  # Workers AI: the daily free allocation is spent


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
    """Floats from the API to a unit direction in signed 8 bits: array('b')."""
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


# Workers AI

def _post_json(url, token, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _cf_code(body):
    try:
        errs = json.loads(body).get("errors") or []
        return int(errs[0]["code"]) if errs else None
    except (ValueError, KeyError, TypeError, IndexError, AttributeError):
        return None


class WorkersAI:
    """One model on the Workers AI REST API. post(url, token, payload, timeout) is
    injectable so tests never touch the network."""

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
        except urllib.error.HTTPError as exc:
            try:
                code = _cf_code(exc.read())
            except OSError:
                code = None
            raise EmbedError(f"cf_{code}" if code else f"http_{exc.code}") from None
        except (socket.timeout, TimeoutError):
            raise EmbedError("timeout") from None
        except urllib.error.URLError as exc:
            reason = exc.reason
            raise EmbedError("timeout" if isinstance(reason, (socket.timeout, TimeoutError))
                             else "network") from None
        except (OSError, ValueError):
            raise EmbedError("network") from None
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


def client_from_env(env=None, post=_post_json):
    """A WorkersAI client, or (None, status) when the token or account id is absent."""
    env = os.environ if env is None else env
    token, account = env.get(TOKEN_ENV, ""), env.get(ACCOUNT_ENV, "")
    if not token:
        return None, "no_token"
    if not account:
        return None, "no_account"
    return WorkersAI(account, token, post=post), "ok"


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

def vectors_for(items, client, cache, now, budget_used=0.0, budget=DAILY_NEURON_BUDGET,
                max_seconds=MAX_SECONDS, clock=time.monotonic, dims=DIMS):
    """Vectors for items from the cache, embedding the missing ones newest first.

    Returns (vectors {id: array('b')}, stats). Updates cache in place (every item seen
    gets this hour as its last seen). stats: state (ok, no_token, no_account, budget,
    time_cap, api_error:<status>), embedded, cached, missing, batches, api_seconds,
    tokens_estimated, tokens_reported, neurons (charged this run)."""
    hour = int(now.timestamp() // 3600)
    vectors, todo = {}, []
    for it in items:
        got = cache.get(it["id"])
        if got is not None:
            got[1] = hour
            vectors[it["id"]] = decode(got[0])
        else:
            todo.append(it)
    stats = {"state": "ok", "embedded": 0, "cached": len(vectors), "missing": 0, "batches": 0,
             "api_seconds": 0.0, "tokens_estimated": 0, "tokens_reported": 0, "neurons": 0.0}
    if client is None:
        stats["missing"] = len(todo)
        return vectors, stats
    todo.sort(key=lambda it: (it["published_at"], it["id"]), reverse=True)
    start, used = clock(), budget_used
    size = client.batch
    for k in range(0, len(todo), size):
        chunk = todo[k:k + size]
        texts = [embed_text(it) for it in chunk]
        est = sum(estimate_tokens(t) for t in texts)
        if client.instruction:
            est += estimate_tokens(client.instruction) * len(texts)
        if used + neurons(est) > budget:
            stats["state"] = "budget"
            break
        if clock() - start > max_seconds:
            stats["state"] = "time_cap"
            break
        t0 = clock()
        try:
            data, reported = client.embed(texts)
        except EmbedError as exc:
            stats["api_seconds"] += clock() - t0
            stats["state"] = f"api_error:{exc}"
            # A failed call may still have been charged; count the estimate.
            used += neurons(est)
            stats["neurons"] += neurons(est)
            break
        stats["api_seconds"] += clock() - t0
        stats["batches"] += 1
        charge = neurons(max(est, reported or 0))
        used += charge
        stats["neurons"] += charge
        stats["tokens_estimated"] += est
        stats["tokens_reported"] += reported or 0
        for it, values in zip(chunk, data):
            vec = quantize(values, dims)
            cache[it["id"]] = [encode(vec), hour]
            vectors[it["id"]] = vec
            stats["embedded"] += 1
    stats["missing"] = len(items) - len(vectors)
    return vectors, stats


def run(items, now, previous_budget=None, env=None, cache_path=CACHE_PATH, post=_post_json,
        clock=time.monotonic):
    """The fetcher's entry point: (vectors, new embed_budget for state.json, stats).

    With no token or account id nothing is called, the cache is left as it is, and the
    vectors come back empty, so the clusterer runs exactly as B2."""
    client, status = client_from_env(env, post=post)
    day, used = budget_today(previous_budget, now)
    if client is None:
        stats = {"state": status, "embedded": 0, "cached": 0, "missing": len(items),
                 "batches": 0, "api_seconds": 0.0, "tokens_estimated": 0,
                 "tokens_reported": 0, "neurons": 0.0, "cache_status": "unused",
                 "cache_items": 0, "cache_bytes": 0}
        return {}, {"day": day, "neurons": round(used, 2)}, stats
    cache, cache_status = load_cache(cache_path)
    vectors, stats = vectors_for(items, client, cache, now, budget_used=used, clock=clock)
    stats["cache_status"] = cache_status
    stats["cache_items"], stats["cache_bytes"] = save_cache(
        cache, int(now.timestamp() // 3600), cache_path)
    return vectors, {"day": day, "neurons": round(used + stats["neurons"], 2)}, stats


def log_line(stats, budget_state):
    """The run's one embedding line: counts and statuses only (the log is public)."""
    return (
        f"embed model={MODEL} dims={DIMS} state={stats['state']} "
        f"fallback={'none' if stats['state'] == 'ok' and not stats['missing'] else 'lexical_for_' + str(stats['missing'])} "
        f"embedded={stats['embedded']} cached={stats['cached']} missing={stats['missing']} "
        f"batches={stats['batches']} api_seconds={stats['api_seconds']:.2f} "
        f"tokens_est={stats['tokens_estimated']} tokens_reported={stats['tokens_reported']} "
        f"neurons_run={stats['neurons']:.1f} neurons_day={budget_state['neurons']:.1f} "
        f"budget_day={DAILY_NEURON_BUDGET} day={budget_state['day']} "
        f"cache={stats['cache_status']} cache_items={stats['cache_items']} "
        f"cache_bytes={stats['cache_bytes']}"
    )


def utc_now():
    return datetime.now(timezone.utc)
