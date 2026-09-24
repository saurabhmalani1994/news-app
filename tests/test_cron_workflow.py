"""C1: publish.yml's cron-shaped dispatch path (R44) -- the trigger input the new
cron/ Worker uses to fire an hourly run, since GitHub's own `schedule:` trigger is
best effort and was observed firing only twice in about ten hourly slots.

Text-based checks on the workflow YAML, in the same style as
test_bundle_eval.py's publish.yml checks: no PyYAML dependency (BUILDER-RULES says
nothing gets pip installed in the scheduled path, and requirements-dev.txt stays as
it is unless a slice truly needs a new package; this one does not).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _workflow():
    return (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")


def test_both_workflow_dispatch_inputs_exist():
    wf = _workflow()
    on = wf.split("\npermissions:")[0]
    assert re.search(r"workflow_dispatch:\n\s+inputs:\n\s+dump_candidates:\n", on)
    assert re.search(r"dump_candidates:[\s\S]*?type: boolean[\s\S]*?default: false", on)
    assert re.search(
        r"trigger:\n\s+description:[\s\S]*?\n\s+type: string\n\s+default: \"manual\"", on
    )


def test_schedule_is_unchanged_as_the_fallback_trigger():
    wf = _workflow()
    on = wf.split("\npermissions:")[0]
    assert on.count("cron:") == 1
    assert 'cron: "17 * * * *"' in on


def test_test_job_skips_for_schedule_and_for_a_cron_shaped_dispatch():
    wf = _workflow()
    jobs = wf.split("\njobs:", 1)[1]
    test_job = jobs.split("\n  test:", 1)[1].split("\n  publish:", 1)[0]
    assert "if: github.event_name != 'schedule' && inputs.trigger != 'cron'" in test_job


def test_publish_job_still_runs_when_the_test_job_is_skipped():
    wf = _workflow()
    jobs = wf.split("\njobs:", 1)[1]
    publish_job = jobs.split("\n  publish:", 1)[1]
    assert "needs: test" in publish_job
    assert (
        "if: ${{ !cancelled() && (needs.test.result == 'success' "
        "|| needs.test.result == 'skipped') }}" in publish_job
    )
