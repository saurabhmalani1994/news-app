"""T2: #rank-input's compact form (app/page_input.py). The page embeds encode_input's
output; every reader on the device decodes it with js/page-input.js decodeInput. These
hold the form to decoding back to exactly the build's object, in Python and in the
browser's decoder alike, and hold it to being smaller."""
import html
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from app.build import render
from app.page_input import decode_input, encode_input
from tests.test_frontpage import fixture_pool
from tests.test_u1_summaries_reader import _pool_with_bodies

ROOT = Path(__file__).resolve().parents[1]
ELL = "…"


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _embedded_raw(page):
    return json.loads(html.unescape(re.search(r'<template id="rank-input">(.*?)</template>', page, re.S).group(1)))


TRICKY = {
    "deks": {f"s{i}": ["A dek long enough to be cut at every tier of the page, one to four lines.",
                       "A dek long enough to be cut at every tier of the page" + ELL,
                       "A dek long enough to be cut at" + ELL] for i in range(5)},
    # A cut whose stem holds an astral character is never a reference: JS counts it as two.
    "astral": ["\U0001F30D A world dek that runs well past thirty characters long", "\U0001F30D A world dek that runs well past" + ELL],
    "tildes": ["~", "~~x", "~-", "~0", "~0^3"],
    "rows": [{"id": "a", "x": 1}, {"id": "b"}, {"x": 2, "id": "c"}, {"id": "d", "x": None}],  # key order differs
    "cols": [{"id": f"a{i}", "url": "https://example.org/shared-url", **({"dek": "d"} if i % 2 else {})} for i in range(6)],
    "small": {"k": "v", "n": 0},
    "empty": {"list": [], "map": {}, "s": ""},
}


@pytest.mark.parametrize("data", [TRICKY, {"only": "plain"}, []])
def test_the_compact_form_decodes_to_the_very_object_key_order_included(data):
    assert _dumps(decode_input(encode_input(data))) == _dumps(data)


def test_a_key_starting_with_a_tilde_is_refused():
    with pytest.raises(ValueError):
        encode_input({"~k": 1})


def test_input_without_a_table_decodes_as_itself():
    assert decode_input({"pool": {}}) == {"pool": {}}


def test_the_page_embeds_the_compact_form_and_it_is_smaller():
    for pool in (fixture_pool(), _pool_with_bodies()):
        raw = _embedded_raw(render(pool))
        assert set(raw) == {"~s", "v"}
        decoded = decode_input(raw)
        assert {"pool", "deks", "fronts", "coverage", "vdeks"} <= set(decoded)
        assert len(_dumps(raw)) < len(_dumps(decoded))


NODE_DECODE = """
import { readFileSync } from "node:fs";
import { decodeInput } from "./app/static/js/page-input.js";
const raw = JSON.parse(readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify(decodeInput(raw)));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node, as the ranker does")
@pytest.mark.parametrize("make", ["page", "tricky"])
def test_the_browser_decoder_gives_the_same_object(make):
    raw = _embedded_raw(render(_pool_with_bodies())) if make == "page" else encode_input(TRICKY)
    done = subprocess.run([shutil.which("node"), "--input-type=module", "-e", NODE_DECODE], cwd=ROOT,
                          input=_dumps(raw).encode("utf-8"), capture_output=True, check=True)
    assert done.stdout.decode("utf-8") == _dumps(decode_input(raw))
