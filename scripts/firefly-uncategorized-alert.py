#!/usr/bin/env python3
"""Alert on Firefly transactions that nothing categorised.

Silent rule breakage is the failure this guards against: a bulk rule edit can
switch every action off and go unnoticed for days. It runs last in the chain,
so anything it reports escaped both the rules and history.
Runs daily at 09:00 via com.homelab.firefly-uncategorized-alert.plist
"""

from __future__ import annotations

import datetime

from firefly_lib import Firefly, healthchecks_push, telegram_send

JOB_ID = "firefly-uncategorized-alert"
LOOKBACK_DAYS = 7
TRANSFER = "transfer"
MAX_LISTED = 15


def uncategorised(firefly: Firefly, start: str, end: str) -> list[dict]:
    groups = firefly.paged("/transactions", {"start": start, "end": end})
    return [
        {"date": split["date"][:10], "description": split["description"], "amount": split["amount"]}
        for group in groups
        for split in group["attributes"]["transactions"]
        if not split["category_name"] and split["type"] != TRANSFER
    ]


def main() -> None:
    healthchecks_push(JOB_ID, "start", "uncategorized scan started")
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()

    try:
        found = uncategorised(Firefly(), start, today.isoformat())
    except (OSError, RuntimeError, KeyError, ValueError) as exc:
        healthchecks_push(JOB_ID, "fail", f"scan failed: {exc}")
        telegram_send(f"🚨 Firefly uncategorized scan failed: {exc}")
        raise

    if not found:
        healthchecks_push(JOB_ID, "success", f"no uncategorized transactions since {start}")
        return

    found.sort(key=lambda item: item["date"])
    lines = [f"• {item['date']}  {item['description']}  €{float(item['amount']):.2f}" for item in found[:MAX_LISTED]]
    overflow = len(found) - len(lines)
    lines.extend([f"…and {overflow} more"] if overflow > 0 else [])
    telegram_send(
        f"🏷️ {len(found)} uncategorized transaction(s) since {start}:\n\n" + "\n".join(lines) + "\n\n"
        "No rule matched and no history to learn from. Add a rule trigger, or check "
        "that the rule's actions are still enabled (a bulk API edit can silently switch them off)."
    )
    healthchecks_push(JOB_ID, "success", f"{len(found)} uncategorized since {start}")


main()
