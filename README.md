# Almanac

A personal news reader. A scheduled GitHub Actions job fetches public RSS and Atom feeds,
cleans and clusters them into one pool, and publishes a static, phone-first web app to a
private site behind Cloudflare Access. Ranking runs on the reader's own device, with rules
the reader can read and edit. Nothing here is a hosted service for other people.

## Layout

- `fetcher/`: feed fetching, parsing, dedup, clustering, events (standard library Python)
- `contract/`: the pool schema and its validator
- `app/`: the page builder and the browser app (plain ES modules, no framework)
- `relay/`, `cron/`: small Cloudflare Workers used by the pipeline
- `sources.json`, `topics.json`, `geo.json`: feed list and tagging tables
- `docs/`: design notes

## Running the tests

Python 3.10 or later and Node 22 or later.

```
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/js/*.test.js
```

The runtime code needs no packages; `requirements-dev.txt` is for tests only. The
browser proofs in `tests/browser/` need Chrome and are run by hand; see
`tests/browser/README.md`. They use the Python in `PYTHON` if set, else the repo's `.venv`.

To build a page locally from a pool file:

```
python -m app.build --pool tests/fixtures/golden_pool.json --out dist
```

## Feed content

Headlines, descriptions and article text belong to their publishers. The app links to
the source for every story. Test fixtures in `tests/fixtures/` are either synthetic or
hold headlines with short feed descriptions, kept only to test clustering and ranking.
