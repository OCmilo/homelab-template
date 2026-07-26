#!/usr/bin/env python3
"""Collapse per-transaction merchant accounts into one canonical account each.

The Enable Banking importer names every expense account after the transaction
description, so each Glovo order produced its own account. Rules trigger on
description rather than account, so repointing account links is safe for them.
Every move is appended to normalize-journal.jsonl so it can be undone.
Runs nightly at 08:30 via com.homelab.firefly-normalize-merchants.plist
"""

from __future__ import annotations

import json
import re
import sys

import firefly_lib
from firefly_lib import Firefly, healthchecks_push, telegram_send

JOB_ID = "firefly-normalize-merchants"
MAP_FILE = firefly_lib.HOMELAB / "config" / "firefly" / "merchant-map.json"
JOURNAL_FILE = firefly_lib.HOMELAB / "config" / "firefly" / "normalize-journal.jsonl"
EXPENSE = "expense"


def load_patterns() -> list[tuple[re.Pattern, str]]:
    spec = json.loads(MAP_FILE.read_text())
    return [(re.compile(entry["match"]), entry["canonical"]) for entry in spec["patterns"]]


def canonical_for(patterns, name: str) -> str | None:
    hits = (canonical for pattern, canonical in patterns if pattern.match(name.lower()))
    return next(hits, None)


def group_accounts(patterns, accounts) -> dict[str, list[dict]]:
    families: dict[str, list[dict]] = {}
    for account in accounts:
        canonical = canonical_for(patterns, account["attributes"]["name"])
        families.setdefault(canonical, []).append(account)
    families.pop(None, None)
    return families


def target_id(firefly: Firefly, canonical: str, members: list[dict], dry_run: bool) -> str | None:
    survivors = (m["id"] for m in members if m["attributes"]["name"] == canonical)
    found = next(survivors, None)
    if found or dry_run:
        return found
    return firefly.call("POST", "/accounts", {"name": canonical, "type": EXPENSE})["data"]["id"]


def pending_moves(firefly: Firefly, account_id: str, destination: str) -> list[dict]:
    groups = firefly.paged(f"/accounts/{account_id}/transactions")
    return [
        {
            "transaction_id": group["id"],
            "journal_id": split["transaction_journal_id"],
            "from_account_id": account_id,
            "to_account_id": destination,
            "description": split["description"],
        }
        for group in groups
        for split in group["attributes"]["transactions"]
        if split["destination_id"] == account_id
    ]


def apply_moves(firefly: Firefly, moves: list[dict], dry_run: bool) -> None:
    if dry_run:
        return
    for move in moves:
        firefly.call(
            "PUT",
            f"/transactions/{move['transaction_id']}",
            {
                "transactions": [
                    {"transaction_journal_id": move["journal_id"], "destination_id": move["to_account_id"]}
                ]
            },
        )


def drop_if_empty(firefly: Firefly, account_id: str, dry_run: bool) -> bool:
    leftover = firefly.paged(f"/accounts/{account_id}/transactions")
    if leftover or dry_run:
        return False
    firefly.call("DELETE", f"/accounts/{account_id}")
    return True


def record(entries: list[dict], dry_run: bool) -> None:
    if dry_run or not entries:
        return
    with JOURNAL_FILE.open("a") as handle:
        handle.writelines(f"{json.dumps(entry)}\n" for entry in entries)


def process(firefly: Firefly, families: dict[str, list[dict]], dry_run: bool) -> tuple[list[dict], list[str]]:
    moves: list[dict] = []
    removed: list[str] = []
    for canonical in sorted(families):
        members = families[canonical]
        destination = target_id(firefly, canonical, members, dry_run)
        variants = [m for m in members if m["attributes"]["name"] != canonical]
        family_moves = [m for variant in variants for m in pending_moves(firefly, variant["id"], destination)]
        apply_moves(firefly, family_moves, dry_run)
        gone = [v for v in variants if drop_if_empty(firefly, v["id"], dry_run)]
        family_removed = [f"{v['id']}:{v['attributes']['name']}" for v in (variants if dry_run else gone)]
        record([{"kind": "move", **move} for move in family_moves], dry_run)
        record([{"kind": "removed_account", "account": name} for name in family_removed], dry_run)
        removed.extend(family_removed)
        moves.extend(family_moves)
        print(f"{canonical:<18} {len(variants):>3} variants  {len(family_moves):>4} transactions", flush=True)
    return moves, removed


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    healthchecks_push(JOB_ID, "start", "merchant normalization started")
    firefly = Firefly()

    try:
        patterns = load_patterns()
        accounts = firefly.paged("/accounts", {"type": EXPENSE})
        families = group_accounts(patterns, accounts)
        moves, removed = process(firefly, families, dry_run)
    except (OSError, RuntimeError, KeyError, ValueError) as exc:
        healthchecks_push(JOB_ID, "fail", f"normalization failed: {exc}")
        telegram_send(f"🚨 Firefly merchant normalization failed: {exc}")
        raise

    summary = f"{len(moves)} transactions repointed, {len(removed)} accounts removed"
    print(f"\n{'DRY RUN: ' * dry_run}{summary}")
    healthchecks_push(JOB_ID, "success", summary)

    if moves and not dry_run:
        telegram_send(f"🧹 Firefly merchant cleanup: {summary}")


main()
