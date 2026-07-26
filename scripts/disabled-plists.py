#!/usr/bin/env python3
"""Print the launchd plists whose module is not enabled in .env.

Used by install-jobs.sh to decide what to install and what to unload. Lives in
its own file rather than a heredoc because bash 3.2 — still the system bash on
macOS — mis-parses heredocs nested inside command substitution.
"""

from __future__ import annotations

import json
import pathlib
import sys

ALWAYS_ON_MODULE = "core"


def compose_profiles(env_file: pathlib.Path) -> str:
    """Read COMPOSE_PROFILES the way Compose itself reads it.

    The last assignment wins, one layer of surrounding quotes comes off, and an
    unquoted trailing comment is not part of the value. Guessing differently
    would uninstall jobs whose services are running.
    """
    raw = None
    for line in env_file.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "COMPOSE_PROFILES":
            raw = value.strip()

    if raw is None:
        raise SystemExit(
            "COMPOSE_PROFILES is not set in .env. Refusing to run: an absent "
            "value would read as every module disabled and uninstall their agents."
        )
    return raw.partition(" #")[0].strip().strip('"').strip("'")


def required_modules(job: dict) -> set[str]:
    module = job["module"]
    return {module} if isinstance(module, str) else set(module)


def main() -> int:
    home = pathlib.Path(sys.argv[1])
    env_file = home / ".env"
    if not env_file.exists():
        raise SystemExit(f"{env_file} not found — copy .env.example and set COMPOSE_PROFILES first")

    profiles = compose_profiles(env_file)
    enabled = {ALWAYS_ON_MODULE, *(name.strip() for name in profiles.split(",") if name.strip())}

    registry = json.loads((home / "jobs" / "jobs.json").read_text())
    for job in registry["jobs"]:
        source = job["source"]
        launchd = source.startswith("jobs/launchd/")
        if launchd and not required_modules(job) <= enabled:
            print(pathlib.Path(source).name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
