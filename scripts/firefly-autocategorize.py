#!/usr/bin/env python3
"""Categorise leftover transactions from how the same merchant was filed before.

Runs after the rule engine, so it only ever sees what the rules did not match.
The merchant key is the expense account first (normalization makes that stable)
and a trimmed description root second. Applied categories are tagged so they
can be told apart from rule output and undone in bulk.
Runs nightly at 08:45 via com.homelab.firefly-autocategorize.plist
"""

from __future__ import annotations

import argparse
import collections
import datetime
import re

from firefly_lib import Firefly, healthchecks_push, telegram_send

JOB_ID = "firefly-autocategorize"
TAG = "auto-learned"
HISTORY_START = "2020-01-01"
CANDIDATE_DAYS = 30
MIN_OCCURRENCES = 2
MIN_AGREEMENT = 0.8
ROOT_TOKENS = 2
MIN_ROOT_LENGTH = 4
TRANSFER = "transfer"
EXPENSE_TYPE = "Expense account"
PLACEHOLDER_PREFIX = "("
MAX_LISTED = 15
NOISE_TOKEN = re.compile(r"\d")


def root_of(description: str) -> str:
    tokens = [t for t in re.split(r"[\s*]+", description.lower()) if t and not NOISE_TOKEN.search(t)]
    return " ".join(tokens[:ROOT_TOKENS])


def is_merchant(split: dict) -> bool:
    """Firefly's '(unknown destination)' placeholder and asset accounts are not merchants.

    Both collect unrelated transactions, so using them as a key hands every
    stray transaction the majority category of a bucket it has nothing to do with.
    """
    name = split["destination_name"] or ""
    return split["destination_type"] == EXPENSE_TYPE and not name.startswith(PLACEHOLDER_PREFIX)


def splits_of(groups) -> list[dict]:
    return [
        dict(
            split,
            transaction_id=group["id"],
            group_journal_ids=[
                sibling["transaction_journal_id"] for sibling in group["attributes"]["transactions"]
            ],
        )
        for group in groups
        for split in group["attributes"]["transactions"]
        if split["type"] != TRANSFER
    ]


def learn(splits) -> dict[str, collections.Counter]:
    knowledge: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for split in splits:
        if not split["category_name"]:
            continue
        root = root_of(split["description"])
        if len(root) >= MIN_ROOT_LENGTH:
            knowledge[f"root:{root}"][split["category_name"]] += 1
        if not is_merchant(split):
            continue
        knowledge[f"account:{split['destination_id']}"][split["category_name"]] += 1
    return knowledge


def verdict(counter: collections.Counter) -> str | None:
    total = sum(counter.values())
    if total < MIN_OCCURRENCES:
        return None
    category, hits = counter.most_common(1)[0]
    return category if hits / total >= MIN_AGREEMENT else None


def lookup_keys(split: dict) -> list[str]:
    root = [f"root:{root_of(split['description'])}"]
    if not is_merchant(split):
        return root
    return [f"account:{split['destination_id']}"] + root


def guess(knowledge, split: dict) -> str | None:
    verdicts = (verdict(knowledge[key]) for key in lookup_keys(split) if key in knowledge)
    return next((v for v in verdicts if v), None)


def apply_category(firefly: Firefly, split: dict, category: str) -> None:
    tags = sorted(set(split.get("tags") or []) | {TAG})
    # Firefly replaces the whole split set on update, so every sibling journal
    # has to be listed or a split transaction loses its other legs. A split
    # named by journal id alone is left exactly as it is.
    updates = [{"transaction_journal_id": journal} for journal in split["group_journal_ids"]]
    for entry in updates:
        targeted = entry["transaction_journal_id"] == split["transaction_journal_id"]
        targeted and entry.update({"category_name": category, "tags": tags})
    firefly.call(
        "PUT",
        f"/transactions/{split['transaction_id']}",
        {"apply_rules": False, "fire_webhooks": False, "transactions": updates},
    )


def write_back(firefly: Firefly, applied: list[tuple[dict, str]], dry_run: bool) -> None:
    if dry_run:
        return
    for split, category in applied:
        apply_category(firefly, split, category)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--days", type=int, default=CANDIDATE_DAYS, help="how far back to look for candidates")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dry_run = args.dry_run
    healthchecks_push(JOB_ID, "start", "autocategorize started")
    firefly = Firefly()
    today = datetime.date.today()

    try:
        history = splits_of(firefly.paged("/transactions", {"start": HISTORY_START, "end": today.isoformat()}))
        knowledge = learn(history)
        window_start = (today - datetime.timedelta(days=args.days)).isoformat()
        recent = splits_of(firefly.paged("/transactions", {"start": window_start, "end": today.isoformat()}))
        candidates = [split for split in recent if not split["category_name"]]
        matched = [(split, guess(knowledge, split)) for split in candidates]
        applied = [(split, category) for split, category in matched if category]
        write_back(firefly, applied, dry_run)
    except (OSError, RuntimeError, KeyError, ValueError) as exc:
        healthchecks_push(JOB_ID, "fail", f"autocategorize failed: {exc}")
        telegram_send(f"🚨 Firefly autocategorize failed: {exc}")
        raise

    for split, category in applied[:MAX_LISTED]:
        print(f"{split['date'][:10]}  {split['description'][:40]:<40} -> {category}")

    summary = f"{len(applied)} of {len(candidates)} uncategorized transactions learned from history"
    print(f"\n{'DRY RUN: ' * dry_run}{summary}")
    healthchecks_push(JOB_ID, "success", summary)

    if applied and not dry_run:
        lines = "\n".join(f"• {s['description'][:40]} → {c}" for s, c in applied[:MAX_LISTED])
        telegram_send(f"🧠 Firefly learned {len(applied)} categories from history:\n\n{lines}")


main()
