#!/usr/bin/env python3
"""Reconcile the Git job registry into a Healthchecks project via API v3."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request


DEFAULT_REGISTRY = pathlib.Path("/opt/homelab/jobs/jobs.json")
DEFAULT_KEY = pathlib.Path("/opt/homelab/runtime/management-api-key")
DEFAULT_PING_KEY = pathlib.Path("/opt/homelab/runtime/ping-key")
DEFAULT_OUTPUT = pathlib.Path("/opt/homelab/runtime/ping-urls.env")
DEFAULT_STATE = pathlib.Path("/opt/homelab/runtime/reconcile-state.json")
# Jobs tagged `core` belong to no optional module and always run.
ALWAYS_ON_MODULE = "core"
ACTIVE = "active"
# The scheduler reports no per-run completion, so the check exists to document
# the schedule and can never go green on its own.
CATALOG_ONLY = "catalog-only"
# Deliberately silenced in the registry: the job runs and its check records
# pings, but a missed window raises nothing.
MUTED = "muted"
# Its module is switched off, so the job does not run at all.
DISABLED = "disabled"
DECLARED_STATES = {ACTIVE, CATALOG_ONLY, MUTED}
# A long-running agent rather than a timer: it has no per-run completion to
# report, so it is in the registry for installation only.
DAEMON = "daemon"


def enabled_modules() -> set[str]:
    # Absent and empty mean different things. Compose always sets the variable
    # for this container, so an absent one means the reconciler is running
    # somewhere that never read .env — and treating that as "no modules" would
    # pause every check while the jobs behind them keep running.
    profiles = os.environ.get("COMPOSE_PROFILES")
    if profiles is None:
        raise SystemExit(
            "COMPOSE_PROFILES is not set. Refusing to run: an absent value would "
            "read as every module disabled and pause their checks. Recreate the "
            "container (docker compose up -d --force-recreate healthchecks) so it "
            "inherits the value from .env."
        )
    return {ALWAYS_ON_MODULE, *(p.strip() for p in profiles.split(",") if p.strip())}


def required_modules(job: dict) -> set[str]:
    # A job may need more than one module: the Karakeep-to-vault pull is a wiki
    # job that talks to the bookmarks stack.
    module = job["module"]
    return {module} if isinstance(module, str) else set(module)


def monitoring_state(job: dict, enabled: set[str]) -> str:
    # A switched-off module wins over whatever the registry declares: the job
    # cannot run, so nothing it says about alerting applies.
    return job["monitoring"] if required_modules(job) <= enabled else DISABLED


def registry_timezone(registry: dict) -> str:
    # TZ is the single source of truth in .env; the registry value is only a
    # fallback for a bare shell that has not sourced it.
    return os.environ.get("TZ") or registry.get("timezone") or "UTC"


def write_secret(path: pathlib.Path, value: str) -> None:
    # Create the file already restricted. write_text() honours the umask, so
    # the ping key would sit world-readable until the chmod landed.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(value)
    # O_CREAT's mode is ignored when the file already exists.
    path.chmod(0o600)


def load_registry(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text())
    if data.get("schema_version") != 1:
        raise ValueError("unsupported jobs registry schema")
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("jobs must be a non-empty list")

    ids: set[str] = set()
    for job in jobs:
        required = {
            "id",
            "name",
            "module",
            "authority",
            "source",
            "command",
            "purpose",
            "schedule",
            "grace_seconds",
            "monitoring",
        }
        missing = required - job.keys()
        if missing:
            raise ValueError(f"{job.get('id', '<unknown>')}: missing {sorted(missing)}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", job["id"]):
            raise ValueError(f"{job['id']}: invalid id")
        if job["id"] in ids:
            raise ValueError(f"{job['id']}: duplicate id")
        if job["monitoring"] not in DECLARED_STATES:
            raise ValueError(
                f"{job['id']}: invalid monitoring mode; expected one of "
                f"{sorted(DECLARED_STATES)}"
            )
        modules = required_modules(job)
        if not modules or not all(isinstance(name, str) and name for name in modules):
            raise ValueError(f"{job['id']}: module must be a name or a list of names")
        schedule = job["schedule"]
        # Daemons are registered so that module filtering can install and
        # remove their launchd agents; they never become checks.
        if schedule.get("type") == DAEMON:
            ids.add(job["id"])
            continue
        if schedule.get("type") == "cron":
            if len(schedule.get("expression", "").split()) != 5:
                raise ValueError(f"{job['id']}: invalid cron expression")
        elif schedule.get("type") == "interval":
            if int(schedule.get("seconds", 0)) < 60:
                raise ValueError(f"{job['id']}: interval must be at least 60 seconds")
        else:
            raise ValueError(f"{job['id']}: invalid schedule type")
        ids.add(job["id"])
    return data


class Api:
    def __init__(self, base_url: str, key: str):
        self.base_url = base_url.rstrip("/")
        self.key = key

    def post(self, path: str, payload: dict | None = None) -> dict:
        body = json.dumps(payload or {}).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "X-Api-Key": self.key},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Healthchecks API {exc.code}: {detail}") from exc


def payload_for(job: dict, timezone: str, state: str) -> dict:
    description = "\n".join(
        [
            job["purpose"],
            "",
            f"Authority: {job['authority']}",
            f"Source: {job['source']}",
            f"Command: {job['command']}",
            f"Expected duration: {job.get('expected_duration_seconds', 'unspecified')} seconds",
            f"Risk: {job.get('risk', 'unspecified')}",
            f"Module: {' + '.join(sorted(required_modules(job)))}",
            f"Monitoring: {state}",
            *([f"Notes: {job['notes']}"] if job.get("notes") else []),
        ]
    )
    payload = {
        "name": job["name"],
        "slug": job["id"],
        "tags": f"{job['authority']} {state} managed-by-git",
        "desc": description,
        "grace": int(job["grace_seconds"]),
        "methods": "POST",
        "channels": "*",
        "unique": ["slug"],
    }
    schedule = job["schedule"]
    if schedule["type"] == "cron":
        payload["schedule"] = schedule["expression"]
        payload["tz"] = timezone
    else:
        payload["timeout"] = int(schedule["seconds"])
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=pathlib.Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--api-key-file", type=pathlib.Path, default=DEFAULT_KEY)
    parser.add_argument("--ping-key-file", type=pathlib.Path, default=DEFAULT_PING_KEY)
    parser.add_argument("--api-url", default="http://127.0.0.1:8000/api/v3")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--state", type=pathlib.Path, default=DEFAULT_STATE)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    registry = load_registry(args.registry)
    if args.validate_only:
        print(f"Valid registry: {len(registry['jobs'])} scheduled jobs")
        return 0

    # Jobs whose module is switched off are still upserted, then paused. They
    # cannot simply be skipped: this reconciler never deletes, so a check left
    # behind by a module you have since disabled would keep missing its window
    # and alerting forever. The registry is the whole truth about which checks
    # alert, so a pause applied in the web UI is undone on the next run —
    # declare `"monitoring": "muted"` to silence a job for good.
    modules = enabled_modules()
    timezone = registry_timezone(registry)
    jobs = [job for job in registry["jobs"] if job["schedule"]["type"] != DAEMON]

    key = args.api_key_file.read_text().strip()
    if not key:
        raise SystemExit("empty Healthchecks management API key")
    ping_key = args.ping_key_file.read_text().strip()
    if not ping_key:
        raise SystemExit("empty Healthchecks ping key")
    api = Api(args.api_url, key)
    env_lines = [
        "# Generated by scripts/healthchecks-reconcile.py; do not edit.",
        "# Callers build <base>/ping/<key>/<job id>; job ids are the check slugs.",
        f"HEALTHCHECKS_PING_KEY={ping_key}",
    ]
    state = {"schema_version": 1, "jobs": []}
    counts = dict.fromkeys([*DECLARED_STATES, DISABLED], 0)

    for job in jobs:
        monitoring = monitoring_state(job, modules)
        check = api.post("/checks/", payload_for(job, timezone, monitoring))
        if check.get("slug") != job["id"]:
            raise ValueError(
                f"{job['id']}: check slug is {check.get('slug')!r}; ping URL would not resolve"
            )
        running = monitoring == ACTIVE
        paused = check.get("status") == "paused"
        if not running and not paused:
            api.post(f"/checks/{check['uuid']}/pause")
        if running and paused:
            api.post(f"/checks/{check['uuid']}/resume")
        state["jobs"].append(
            {
                "id": job["id"],
                "uuid": check["uuid"],
                "monitoring": monitoring,
            }
        )
        counts[monitoring] += 1

    write_secret(args.output, "\n".join(env_lines) + "\n")
    args.state.write_text(json.dumps(state, indent=2) + "\n")
    print(
        f"Reconciled {len(jobs)} checks: "
        f"{counts[ACTIVE]} active, {counts[CATALOG_ONLY]} catalog-only, "
        f"{counts[MUTED]} muted, {counts[DISABLED]} paused (module not enabled)"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
