#!/usr/bin/env python3
"""Keep the wiki operation log in chronological order."""

from __future__ import annotations

import re
import sys
from pathlib import Path


RUNS_HEADING = "## runs\n"
RUN_START = re.compile(r"(?m)^- (?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\b")


def order_runs(text: str) -> str:
    before, heading, runs = text.partition(RUNS_HEADING)
    if not heading:
        raise ValueError("missing ## runs heading")

    matches = list(RUN_START.finditer(runs))
    if not matches:
        return text

    prefix = runs[: matches[0].start()]
    blocks = [
        (match.group("timestamp"), position, runs[match.start() : next_start])
        for position, (match, next_start) in enumerate(
            zip(matches, [item.start() for item in matches[1:]] + [len(runs)])
        )
    ]
    ordered = sorted(blocks, key=lambda item: (item[0], item[1]))
    return before + heading + prefix + "".join(block for _, _, block in ordered)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} LOG_PATH", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    text = path.read_text()
    try:
        ordered = order_runs(text)
    except ValueError as error:
        print(f"wiki log: {error}: {path}", file=sys.stderr)
        return 1
    if ordered != text:
        path.write_text(ordered)
        print(f"wiki log: restored chronological run order in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
