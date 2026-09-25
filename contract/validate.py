"""Standard library validator for pool.json (R30: no pip install in the cron path).

Interprets the subset of JSON Schema 2020-12 that pool.schema.json uses, reading the
schema file itself so there is one source of truth. Any keyword it does not implement
raises SchemaError, so a schema edit can never silently weaken this validator.

Usage: python -m contract.validate path/to/pool.json   (exit 0 valid, 1 invalid)
"""
import json
import re
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("pool.schema.json")
BODY_SCHEMA_PATH = Path(__file__).with_name("body.schema.json")

ANNOTATIONS = {"$schema", "$id", "$defs", "$comment", "title", "description"}
ASSERTIONS = {
    "$ref", "type", "const", "required", "properties", "additionalProperties",
    "items", "minItems", "maxItems", "pattern", "minLength", "maxLength", "minimum", "enum",
    "uniqueItems",
}


class SchemaError(Exception):
    """The schema uses something this validator does not implement."""


def load_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def load_body_schema():
    """S22: the closed shape for bodies/<article_id>.json, a separate document
    from the pool, validated with the same stdlib engine (R30)."""
    return json.loads(BODY_SCHEMA_PATH.read_text(encoding="utf-8"))


def _type_ok(value, name):
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    raise SchemaError(f"unknown type {name!r}")


def _same(a, b):
    # JSON Schema equality: booleans are never numbers, 1 equals 1.0.
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return False
    return a == b


def _resolve(root, ref):
    if not ref.startswith("#/"):
        raise SchemaError(f"only local refs are supported: {ref!r}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def _check(value, schema, root, path, errors):
    if schema is True:
        return
    if schema is False:
        errors.append(f"{path}: not allowed")
        return
    unknown = set(schema) - ANNOTATIONS - ASSERTIONS
    if unknown:
        raise SchemaError(f"unsupported keywords {sorted(unknown)} at {path}")

    if "$ref" in schema:
        _check(value, _resolve(root, schema["$ref"]), root, path, errors)
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            errors.append(f"{path}: expected {'/'.join(types)}, got {type(value).__name__}")
            return
    if "const" in schema and not _same(value, schema["const"]):
        errors.append(f"{path}: must equal {schema['const']!r}")
    if "enum" in schema and not any(_same(value, v) for v in schema["enum"]):
        errors.append(f"{path}: must be one of {schema['enum']!r}")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: does not match {schema['pattern']}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems") is True and any(
                _same(value[i], value[j]) for i in range(len(value)) for j in range(i)):
            errors.append(f"{path}: items are not unique")
        if "items" in schema:
            for i, item in enumerate(value):
                _check(item, schema["items"], root, f"{path}[{i}]", errors)

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required field {key!r}")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                _check(item, props[key], root, f"{path}.{key}", errors)
            elif "additionalProperties" in schema:
                _check(item, schema["additionalProperties"], root, f"{path}.{key}", errors)


def _cluster_method(units, has_near_dups):
    # Units (a near-duplicate group, or a lone article) are joined only by cosine_entity;
    # articles inside a near-duplicate group only by minhash. Mirrors fetcher.cluster.
    if units > 1 and has_near_dups:
        return "minhash+cosine_entity"
    return "cosine_entity" if units > 1 else "minhash"


def check_integrity(pool):
    """Cross-references JSON Schema cannot express. Run only on a schema-valid pool."""
    errors = []
    source_ids = {s["id"] for s in pool["sources"]}
    article_ids = [a["id"] for a in pool["articles"]]
    if len(set(article_ids)) != len(article_ids):
        errors.append("$.articles: duplicate article id")
    for i, a in enumerate(pool["articles"]):
        if a["source_id"] not in source_ids:
            errors.append(f"$.articles[{i}].source_id: unknown source {a['source_id']!r}")
    known = set(article_ids)
    clustered = set()
    cluster_ids = set()
    for i, c in enumerate(pool["clusters"]):
        if c["id"] in cluster_ids:
            errors.append(f"$.clusters[{i}].id: duplicate cluster id {c['id']!r}")
        cluster_ids.add(c["id"])
        members = set(c["article_ids"])
        for aid in c["article_ids"]:
            if aid not in known:
                errors.append(f"$.clusters[{i}]: unknown article {aid!r}")
        if len(members) != len(c["article_ids"]):
            errors.append(f"$.clusters[{i}]: article listed twice")
        if members & clustered:
            errors.append(f"$.clusters[{i}]: article already in another cluster")
        clustered |= members
        in_dups = set()
        for g in c["near_duplicates"]:
            if not set(g) <= members:
                errors.append(f"$.clusters[{i}].near_duplicates: id not in article_ids")
            if set(g) & in_dups or len(set(g)) != len(g):
                errors.append(f"$.clusters[{i}].near_duplicates: id in two groups")
            in_dups |= set(g)
        units = len(c["near_duplicates"]) + len(members - in_dups)
        expected = _cluster_method(units, bool(c["near_duplicates"]))
        if c["method"] != expected:
            errors.append(f"$.clusters[{i}].method: shape says {expected!r}, not {c['method']!r}")
        if "lean_buckets" in c and len(set(c["lean_buckets"])) != len(c["lean_buckets"]):
            errors.append(f"$.clusters[{i}].lean_buckets: duplicate entries, must be a set")
        if "independent_sources" in c and c["independent_sources"] > len(members):
            errors.append(
                f"$.clusters[{i}].independent_sources: {c['independent_sources']} exceeds "
                f"the cluster's {len(members)} articles"
            )
    if pool["counts"]["published"] != len(article_ids):
        errors.append("$.counts.published: does not equal the number of articles")
    c = pool["counts"]
    if c["fetched"] != c["published"] + sum(c["drops"].values()):
        errors.append("$.counts: fetched does not equal published plus the sum of drops")
    w = c.get("watch")
    if w is not None and w["fetched"] != w["candidates"] + sum(w["drops"].values()):
        errors.append("$.counts.watch: fetched does not equal candidates plus the sum of drops")
    if "feed_states" in c:
        total_feeds = sum(c["feed_states"].values())
        if total_feeds != len(pool["sources"]):
            errors.append(
                "$.counts.feed_states: total does not equal the number of sources"
            )
    if "source_health" in pool:
        health_ids = set(pool["source_health"])
        missing = source_ids - health_ids
        unknown = health_ids - source_ids
        if missing:
            errors.append(f"$.source_health: missing entries for {sorted(missing)!r}")
        if unknown:
            errors.append(f"$.source_health: entries for unknown sources {sorted(unknown)!r}")
    if "events" in pool:
        errors.extend(_check_events(pool["events"], cluster_ids))
    return errors


def _check_events(events, known_cluster_ids):
    """S31: cross-references pool.schema.json's event shape cannot express (R22).
    Every cluster_id must name a real cluster, a cluster belongs to at most one
    event (the same closed-shape rule as an article and its cluster), and live can
    only be true when eligible is also true, since R22 gates the Live tab on the
    same must-know eligibility (R16): a celebrity story can never go live."""
    errors = []
    event_ids = set()
    clustered = set()
    for i, e in enumerate(events):
        if e["id"] in event_ids:
            errors.append(f"$.events[{i}].id: duplicate event id {e['id']!r}")
        event_ids.add(e["id"])
        members = set(e["cluster_ids"])
        if len(members) != len(e["cluster_ids"]):
            errors.append(f"$.events[{i}].cluster_ids: cluster listed twice")
        for cid in e["cluster_ids"]:
            if cid not in known_cluster_ids:
                errors.append(f"$.events[{i}].cluster_ids: unknown cluster {cid!r}")
        if members & clustered:
            errors.append(f"$.events[{i}].cluster_ids: cluster already in another event")
        clustered |= members
        if e["live"] and not e["eligible"]:
            errors.append(f"$.events[{i}]: live is true but eligible is false")
    return errors


def check_shape(value, schema):
    """Structural validation only (the _check walk), no pool-specific cross
    references. S22 reuses this for bodies/<article_id>.json, which is a closed
    shape but not a pool, so check_integrity's pool-only assumptions do not apply."""
    errors = []
    _check(value, schema, schema, "$", errors)
    return errors


def validate(pool, schema=None):
    """Return a list of error strings; empty means valid."""
    schema = schema if schema is not None else load_schema()
    errors = check_shape(pool, schema)
    if not errors:
        errors = check_integrity(pool)
    return errors


def main(argv):
    if len(argv) != 2:
        print("usage: python -m contract.validate POOL_JSON", file=sys.stderr)
        return 2
    try:
        pool = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"INVALID: cannot read {argv[1]}: {exc}")
        return 1
    errors = validate(pool)
    if errors:
        print(f"INVALID: {len(errors)} error(s)")
        for e in errors[:50]:
            print(f"  {e}")
        return 1
    print(f"valid: {len(pool['articles'])} articles")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
