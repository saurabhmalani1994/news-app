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

ANNOTATIONS = {"$schema", "$id", "$defs", "$comment", "title", "description"}
ASSERTIONS = {
    "$ref", "type", "const", "required", "properties", "additionalProperties",
    "items", "minItems", "pattern", "minLength", "maxLength", "minimum",
}


class SchemaError(Exception):
    """The schema uses something this validator does not implement."""


def load_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


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
    for i, c in enumerate(pool["clusters"]):
        for aid in c["article_ids"]:
            if aid not in known:
                errors.append(f"$.clusters[{i}]: unknown article {aid!r}")
    if pool["counts"]["published"] != len(article_ids):
        errors.append("$.counts.published: does not equal the number of articles")
    c = pool["counts"]
    if c["fetched"] != c["published"] + sum(c["drops"].values()):
        errors.append("$.counts: fetched does not equal published plus the sum of drops")
    return errors


def validate(pool, schema=None):
    """Return a list of error strings; empty means valid."""
    schema = schema if schema is not None else load_schema()
    errors = []
    _check(pool, schema, schema, "$", errors)
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
