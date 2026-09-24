"""Build the S01 static page: the pool's headlines as plain text, in pool order.

Feed content is hostile input (R26): every field is HTML-escaped, so a title can only
ever render as text. No styling, no images, no script. S04 replaces this page.

Usage: python -m app.build --pool dist/pool.json --out dist
"""
import argparse
import json
import shutil
import sys
from html import escape
from pathlib import Path

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Almanac</title>
</head>
<body>
<h1>Almanac</h1>
<p>Pool generated {generated_at}</p>
<ol id="headlines">
{items}
</ol>
</body>
</html>
"""


def render(pool):
    items = "\n".join(f"<li>{escape(a['title'])}</li>" for a in pool["articles"])
    return PAGE.format(generated_at=escape(pool["generated_at"]), items=items)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pool", default="dist/pool.json")
    ap.add_argument("--out", default="dist")
    args = ap.parse_args(argv)

    pool_path, out = Path(args.pool), Path(args.out)
    pool = json.loads(pool_path.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(render(pool), encoding="utf-8")
    if pool_path.resolve() != (out / "pool.json").resolve():
        shutil.copyfile(pool_path, out / "pool.json")
    print(f"built {out / 'index.html'} with {len(pool['articles'])} headlines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
