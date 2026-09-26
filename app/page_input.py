"""T2: the compact form of the page's #rank-input, and its decoder.

The page embeds one JSON object for the device (app/build.py _rank_input_json). Much of
it repeats: a story's dek at each tier is a cut of the same text, a face's dek repeats
the row's, an article id keys five maps and fills every cluster, a url sits in three
places, and the pool's 700 article objects each spell out the same seven keys. The
build writes it in this form and every reader on the device decodes it first
(app/static/js/page-input.js decodeInput, the same rules), so every reader sees exactly
the object the build made. Nothing about what the page shows or ranks changes.

The form: {"~s": [table], "v": value}, where inside `value`
- a string that repeats (8 chars or more) is "~" + its table index in base 36;
- a string ending in "..." (U+2026) whose stem begins a longer string is
  "~<index>^<length>": that string's first <length> characters plus the ellipsis
  (only when the stem is all BMP characters, so Python and JS count it alike);
- any other string starting with "~" gains one more "~";
- a list of 4 or more objects is {"~k": [keys], "~r": [[value per key]]}, "~-" for a
  key an object lacks;
- an object of 4 or more entries is {"~o": [keys as values], "~v": [values]}, or with
  "~k"/"~r" in place of "~v" when every value is an object.
An object key never starts with "~" (ids, source ids and field names), so these marks
never meet a real key; encode_input refuses one that does.
"""

from collections import Counter

ELLIPSIS = "\u2026"
MIN_SHARED = 8
MIN_PREFIX = 30
MIN_ROWS = 4
MISSING = "~-"
DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _b36(n):
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = DIGITS[r] + out
        if n == 0:
            return out


def _bmp(text):
    return all(ord(ch) < 0x10000 for ch in text)


def _count(value, counts):
    if isinstance(value, str):
        counts[value] += 1
    elif isinstance(value, list):
        for item in value:
            _count(item, counts)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key.startswith("~"):
                raise ValueError(f"#rank-input key starts with '~': {key!r}")
            if len(value) >= MIN_ROWS:
                counts[key] += 1
            _count(item, counts)


def _prefix_sources(counts):
    """{cut: (source, stem length)} for each "...stem..." string another string begins
    with. Deterministic: the longest source wins, then the lowest."""
    by_start = {}
    for text in sorted(counts, key=lambda t: (-len(t), t)):
        if len(text) > MIN_PREFIX:
            by_start.setdefault(text[:MIN_PREFIX], []).append(text)
    cuts = {}
    for text in counts:
        if not text.endswith(ELLIPSIS) or len(text) <= MIN_PREFIX:
            continue
        stem = text[:-1]
        if not _bmp(stem):
            continue
        for source in by_start.get(stem[:MIN_PREFIX], ()):
            if source != text and len(source) > len(stem) and source.startswith(stem):
                cuts[text] = (source, len(stem))
                break
    return cuts


def encode_input(data):
    """The compact form of `data` (a JSON-ready object); decode_input(encode_input(x)) == x."""
    counts = Counter()
    _count(data, counts)
    cuts = _prefix_sources(counts)
    shared = {t for t, n in counts.items() if n > 1 and len(t) >= MIN_SHARED}
    table, index = [], {}

    def ref(text):
        if text not in index:
            index[text] = len(table)
            table.append(text)
        return index[text]

    def string(text):
        if text in cuts:
            source, length = cuts[text]
            return f"~{_b36(ref(source))}^{_b36(length)}"
        if text in shared:
            return "~" + _b36(ref(text))
        return "~" + text if text.startswith("~") else text

    def columns(objects):
        """The union of the objects' keys in first-seen order, or None when some object
        orders its own keys otherwise (decoding must give back each key order)."""
        keys = []
        for obj in objects:
            for key in obj:
                if key not in keys:
                    keys.append(key)
        for obj in objects:
            if [k for k in keys if k in obj] != list(obj):
                return None
        return keys

    def rows(objects, keys):
        return [[enc(obj[k]) if k in obj else MISSING for k in keys] for obj in objects]

    def enc(value):
        if isinstance(value, str):
            return string(value)
        if isinstance(value, list):
            keys = (columns(value) if len(value) >= MIN_ROWS and all(isinstance(v, dict) for v in value)
                    else None)
            if keys is not None:
                return {"~k": [string(k) for k in keys], "~r": rows(value, keys)}
            return [enc(v) for v in value]
        if isinstance(value, dict):
            if len(value) < MIN_ROWS:
                return {k: enc(v) for k, v in value.items()}
            outer = [string(k) for k in value]
            values = list(value.values())
            keys = columns(values) if all(isinstance(v, dict) for v in values) else None
            if keys is not None:
                return {"~o": outer, "~k": [string(k) for k in keys], "~r": rows(values, keys)}
            return {"~o": outer, "~v": [enc(v) for v in values]}
        return value

    body = enc(data)
    return {"~s": table, "v": body}


def decode_input(raw):
    """The object encode_input was given. Input without a table is returned as is."""
    if not isinstance(raw, dict) or not isinstance(raw.get("~s"), list):
        return raw
    table = raw["~s"]

    def string(text):
        if not text.startswith("~"):
            return text
        if text[1:2] == "~":
            return text[1:]
        head, _, cut = text[1:].partition("^")
        source = table[int(head, 36)]
        return source[:int(cut, 36)] + ELLIPSIS if cut else source

    def rows(keys, body):
        keys = [string(k) for k in keys]
        return [{k: dec(cell) for k, cell in zip(keys, row) if cell != MISSING} for row in body]

    def dec(value):
        if isinstance(value, str):
            return string(value)
        if isinstance(value, list):
            return [dec(v) for v in value]
        if isinstance(value, dict):
            if "~o" in value:
                outer = [string(k) for k in value["~o"]]
                values = rows(value["~k"], value["~r"]) if "~k" in value else [dec(v) for v in value["~v"]]
                return dict(zip(outer, values))
            if "~k" in value:
                return rows(value["~k"], value["~r"])
            return {k: dec(v) for k, v in value.items()}
        return value

    return dec(raw["v"])
