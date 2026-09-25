"""W1 (R50): the build and deploy side of phrase interests and the interests sync.

The compact pool the ranker reads (build and device alike) carries each article's dek,
cleaned and cut to its first 200 characters, and W2's watch tags, so a phrase interest
matches a headline, a dek or a hashed tag on the phone. publish.yml makes the
almanac-interests KV namespace and its INTERESTS binding before the deploy, with the
pipeline token for KV and the Pages token for the binding, never printing either, and
deploys from the repo root so functions/ (the /api/interests Pages Function) goes out
with the site. Text checks on the workflow, like test_cron_workflow.py (no PyYAML).
"""
import json
from pathlib import Path

from app.csp import content_security_policy
from app.frontpage import RANK_DEK_CHARS, rank_dek, rank_input

ROOT = Path(__file__).resolve().parents[1]


def _article(**extra):
    return {"id": "a1", "source_id": "s1", "title": "Grid news", "published_at": "2026-09-24T00:00:00Z",
            "url": "https://example.com/a1", **extra}


def test_rank_input_carries_the_dek_and_watch_tags_for_phrase_matching():
    pool = {"articles": [_article(dek="A cheap heat pump for flats arrives", watch=["w:d8e4ee5a1b"])], "clusters": []}
    [record] = rank_input(pool)["articles"]
    assert record["dek"] == "A cheap heat pump for flats arrives"
    assert record["watch"] == ["w:d8e4ee5a1b"]
    assert "url" not in record


def test_rank_dek_is_cut_at_a_word_boundary_and_skips_a_repeated_headline():
    long = " ".join(["word"] * 100)
    cut = rank_dek(_article(dek=long))
    assert len(cut) <= RANK_DEK_CHARS and cut.endswith("word") and long.startswith(cut)
    assert rank_dek(_article(dek="Grid news, and more")) == ""
    assert rank_dek(_article()) == ""
    assert "dek" not in rank_input({"articles": [_article()], "clusters": []})["articles"][0]


def _publish_steps():
    wf = (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")
    return wf.split("\n  publish:", 1)[1]


def test_kv_step_runs_before_the_deploy_with_the_right_tokens_and_may_fail():
    job = _publish_steps()
    kv_at = job.index("- name: Ensure the interests KV namespace and its binding (W1)")
    deploy_at = job.index("- name: Deploy to Cloudflare Pages")
    assert kv_at < deploy_at
    step = job[kv_at:deploy_at]
    assert "continue-on-error: true" in step
    assert "KV_TOKEN: ${{ secrets.CLOUDFLARE_PIPELINE_TOKEN }}" in step
    assert "PAGES_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}" in step
    assert '"title":"almanac-interests"' in step and "INTERESTS" in step
    for leak in ('echo "$KV_TOKEN', 'echo "$PAGES_TOKEN', "set -x", "printenv", "env |"):
        assert leak not in step
    deploy = job[deploy_at:].split("\n      - ", 1)[0]
    assert "working-directory" not in deploy, "wrangler must run from the repo root to pick up functions/"
    assert "pages deploy dist --project-name almanac --branch main" in deploy


def test_the_function_is_in_functions_and_the_csp_already_allows_it():
    fn = (ROOT / "functions/api/interests.js").read_text(encoding="utf-8")
    assert "export function onRequest" in fn
    assert "cf-access-jwt-assertion" in fn
    assert "connect-src 'self'" in content_security_policy()


def test_no_profile_phrase_reaches_the_built_page(tmp_path):
    from app.build import main
    pool = json.loads((ROOT / "tests/fixtures/golden_pool.json").read_text(encoding="utf-8"))
    pool["articles"][0]["watch"] = ["w:d8e4ee5a1b"]
    src = tmp_path / "pool.json"
    src.write_text(json.dumps(pool), encoding="utf-8")
    main(["--pool", str(src), "--out", str(tmp_path / "dist")])
    page = (tmp_path / "dist/index.html").read_text(encoding="utf-8")
    assert "w:d8e4ee5a1b" in page, "the hashed tag travels with the article"
    assert '"phrase"' not in page
