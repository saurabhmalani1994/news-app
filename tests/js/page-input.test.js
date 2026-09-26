// T2: the page's #rank-input is written compact (app/page_input.py encode_input) and
// every reader decodes it through js/page-input.js decodeInput. These hold the decoder
// to the form's rules and offline.js's classic-script copy to the module's own text.
// tests/test_page_input.py holds Python's encoder and this decoder to one output on a
// real build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeInput } from "../../app/static/js/page-input.js";

test("input with no string table is returned as is", () => {
  const plain = { pool: { articles: [] }, now: "2026-09-26T00:00:00Z" };
  assert.equal(decodeInput(plain), plain);
  assert.equal(decodeInput(null), null);
});

test("references, cut references, escaped tildes, columns and keyed objects decode", () => {
  const raw = {
    "~s": ["The long dek that every tier cuts from.", "https://example.org/a", "a1"],
    v: {
      full: "~0",
      cut: "~0^8",
      tilde: "~~kept",
      plain: "text",
      n: 3,
      flag: false,
      nothing: null,
      list: { "~k": ["id", "url", "dek"], "~r": [["~2", "~1", "~-"], ["b2", "~-", "~0^3"], ["c3", "x", "y"], ["d4", "~-", "~-"]] },
      map: { "~o": ["~2", "b2", "c3", "d4"], "~v": [1, [2, "~1"], "~0", { small: "~~" }] },
      rows: { "~o": ["~2", "b2", "c3", "d4"], "~k": ["t"], "~r": [["x"], ["~-"], ["~0^4"], ["z"]] },
    },
  };
  assert.deepEqual(decodeInput(raw), {
    full: "The long dek that every tier cuts from.",
    cut: "The long…",
    tilde: "~kept",
    plain: "text",
    n: 3,
    flag: false,
    nothing: null,
    list: [{ id: "a1", url: "https://example.org/a" }, { id: "b2", dek: "The…" }, { id: "c3", url: "x", dek: "y" }, { id: "d4" }],
    map: { a1: 1, b2: [2, "https://example.org/a"], c3: "The long dek that every tier cuts from.", d4: { small: "~" } },
    rows: { a1: { t: "x" }, b2: {}, c3: { t: "The …" }, d4: { t: "z" } },
  });
});

test("offline.js keeps a byte-for-byte copy of decodeInput, since a classic script cannot import it", () => {
  const moduleSource = readFileSync(new URL("../../app/static/js/page-input.js", import.meta.url), "utf-8");
  const offlineSource = readFileSync(new URL("../../app/static/js/offline.js", import.meta.url), "utf-8");
  const own = moduleSource.match(/^export (function decodeInput\(raw\) \{[\s\S]*?\n\})/m)[1];
  const copy = offlineSource.match(/^ {2}(function decodeInput\(raw\) \{[\s\S]*?\n {2}\})/m)[1];
  assert.equal(copy.replace(/\n {2}/g, "\n"), own);
});
