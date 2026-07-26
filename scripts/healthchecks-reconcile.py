#!/usr/bin/env python3
"""Reconcile the Git job registry into a Healthchecks project via API v3."""

from __future__ import annotations

import argparse
import json
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
        if job["monitoring"] not in {"active", "catalog-only"}:
            raise ValueError(f"{job['id']}: invalid monitoring mode")
        schedule = job["schedule"]
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


def payload_for(job: dict, timezone: str) -> dict:
    description = "\n".join(
        [
            job["purpose"],
            "",
            f"Authority: {job['authority']}",
            f"Source: {job['source']}",
            f"Command: {job['command']}",
            f"Expected duration: {job.get('expected_duration_seconds', 'unspecified')} seconds",
            f"Risk: {job.get('risk', 'unspecified')}",
            f"Monitoring: {job['monitoring']}",
            *([f"Notes: {job['notes']}"] if job.get("notes") else []),
        ]
    )
    payload = {
        "name": job["name"],
        "slug": job["id"],
        "tags": f"{job['authority']} {job['monitoring']} managed-by-git",
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
    counts = {"active": 0, "catalog-only": 0}

    for job in registry["jobs"]:
        check = api.post("/checks/", payload_for(job, registry["timezone"]))
        if check.get("slug") != job["id"]:
            raise ValueError(
                f"{job['id']}: check slug is {check.get('slug')!r}; ping URL would not resolve"
            )
        if job["monitoring"] == "catalog-only" and check.get("status") != "paused":
            api.post(f"/checks/{check['uuid']}/pause")
        elif job["monitoring"] == "active" and check.get("status") == "paused":
            api.post(f"/checks/{check['uuid']}/resume")
        state["jobs"].append(
            {
                "id": job["id"],
                "uuid": check["uuid"],
                "monitoring": job["monitoring"],
            }
        )
        counts[job["monitoring"]] += 1

    args.output.write_text("\n".join(env_lines) + "\n")
    args.output.chmod(0o600)
    args.state.write_text(json.dumps(state, indent=2) + "\n")
    print(
        f"Reconciled {len(registry['jobs'])} checks: "
        f"{counts['active']} active, {counts['catalog-only']} catalog-only"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
