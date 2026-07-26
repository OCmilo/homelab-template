#!/usr/bin/env python3
"""Nightly guard for config/firefly/rules.json.

Rules edited in the Firefly UI silently drift from the committed file. This
job runs the sync script's diff and reports drift to Telegram so the fix
(--export to adopt the UI edit, or --apply to restore the file, then commit)
happens the same day. Drift is a finding, not a failure: the check pings
success with the diff attached; only a crashed diff pings fail.
"""

import pathlib
import subprocess
import sys

from firefly_lib import healthchecks_push, telegram_send

JOB_ID = "firefly-rules-drift"
SYNC = pathlib.Path(__file__).resolve().parent / "firefly-rules-sync.py"
DRIFT_MARKERS = ("drift:", "missing live", "live only")
REPORT_LIMIT = 500


def main():
    healthchecks_push(JOB_ID, "start", "rules drift check started")
    result = subprocess.run([sys.executable, str(SYNC)], capture_output=True, text=True)
    if result.returncode == 0:
        healthchecks_push(JOB_ID, "success", "rules.json matches live rules")
        return
    drifted = any(marker in result.stdout for marker in DRIFT_MARKERS)
    if not drifted:
        healthchecks_push(JOB_ID, "fail", (result.stderr or result.stdout)[:REPORT_LIMIT])
        sys.exit(1)
    diff = result.stdout.strip()
    telegram_send(
        "Firefly rules drifted from config/firefly/rules.json:\n"
        f"{diff}\n\n"
        "Run scripts/firefly-rules-sync.py --export to adopt the UI edits "
        "(or --apply to restore the file), then commit."
    )
    healthchecks_push(JOB_ID, "success", diff[:REPORT_LIMIT])


main()
