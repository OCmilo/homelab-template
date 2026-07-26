#!/usr/bin/env python3
"""Weekly finance digest: month-to-date budget envelope status to Telegram.

Firefly reports money per currency and never converts between them, so every
total here stays split by currency code rather than being added up and labelled
with a guess.

Runs Mondays 09:00 via ~/Library/LaunchAgents/com.homelab.weekly-digest.plist
"""

from __future__ import annotations

import collections
import datetime

from firefly_lib import Firefly, healthchecks_push, telegram_send

JOB_ID = "weekly-finance-digest"
OVER_BUDGET = "\U0001F534"
AHEAD_OF_PACE = "⚠️"
ON_TRACK = "✅"
PACE_TOLERANCE = 20
BUDGET_LIMIT = 100


def rendered(totals: dict[str, float]) -> str:
    return " + ".join(f"{value:.0f} {code}" for code, value in sorted(totals.items())) or "0"


def flag_for(pct: float, pace: float) -> str:
    over = OVER_BUDGET * (pct > 100)
    ahead = AHEAD_OF_PACE * (100 >= pct > pace + PACE_TOLERANCE)
    return over or ahead or ON_TRACK


def budget_status(firefly: Firefly, start, today, pace: float):
    """Per-envelope rows plus month-to-date totals, both keyed by currency."""
    rows = []
    budgeted: dict[str, float] = collections.defaultdict(float)
    spent: dict[str, float] = collections.defaultdict(float)
    params = {"limit": BUDGET_LIMIT, "start": start, "end": today}
    for budget in firefly.call("GET", "/budgets", params=params)["data"]:
        attrs = budget["attributes"]
        amount = float(attrs.get("auto_budget_amount") or 0)
        if not amount:
            continue
        code = attrs["currency_code"]
        # `spent` carries one entry per currency the envelope was spent in.
        # Only the envelope's own currency is comparable to its amount; the
        # rest is surfaced on the row instead of being folded into the total.
        by_currency = collections.defaultdict(float)
        for entry in attrs.get("spent", []):
            by_currency[entry["currency_code"]] -= float(entry["sum"])
        native = by_currency.pop(code, 0.0)
        pct = 100 * native / amount
        other = f" (+{rendered(dict(by_currency))} elsewhere)" * bool(by_currency)
        rows.append((pct, f"{flag_for(pct, pace)} {attrs['name']}: "
                          f"{native:.0f}/{amount:.0f} {code} ({pct:.0f}%){other}"))
        budgeted[code] += amount
        spent[code] += native
        for extra_code, extra in by_currency.items():
            spent[extra_code] += extra
    rows.sort(reverse=True)
    return [row for _, row in rows], dict(budgeted), dict(spent)


def month_totals(firefly: Firefly, start, today):
    summary = firefly.call("GET", "/summary/basic", params={"start": start, "end": today})
    earned: dict[str, float] = collections.defaultdict(float)
    spent: dict[str, float] = collections.defaultdict(float)
    buckets = {"earned-in-": earned, "spent-in-": spent}
    for key, value in summary.items():
        prefix = next((candidate for candidate in buckets if key.startswith(candidate)), None)
        if prefix is None:
            continue
        buckets[prefix][value["currency_code"]] += float(value["monetary_value"])
    return dict(earned), dict(spent)


def uncategorized(firefly: Firefly, start, today) -> int:
    query = f"has_no_category:true type:withdrawal date_after:{start} date_before:{today}"
    found = firefly.call("GET", "/search/transactions", params={"query": query, "limit": 1})
    return found["meta"]["pagination"]["total"]


def main() -> None:
    healthchecks_push(JOB_ID, "start", "weekly digest started")
    firefly = Firefly()
    today = datetime.date.today()
    start = today.replace(day=1)
    days_in_month = ((start + datetime.timedelta(days=32)).replace(day=1) - start).days
    pace = 100 * today.day / days_in_month

    try:
        rows, budgeted, spent = budget_status(firefly, start, today, pace)
        earned_all, spent_all = month_totals(firefly, start, today)
        uncat = uncategorized(firefly, start, today)
    except (OSError, RuntimeError, KeyError, ValueError) as exc:
        healthchecks_push(JOB_ID, "fail", f"weekly digest failed: {exc}")
        telegram_send(f"\U0001F6A8 Weekly finance digest failed: {exc}")
        raise

    header = (f"\U0001F4CA Finance digest — {today.strftime('%b %d')} "
              f"(day {today.day}/{days_in_month}, {pace:.0f}% through the month)")
    lines = [header, ""] + rows + [
        "",
        f"Budgeted spend: {rendered(spent)} of {rendered(budgeted)}",
        f"All spending: {rendered({code: -value for code, value in spent_all.items()})}"
        f" | Income: {rendered(earned_all)}",
        f"Uncategorized this month: {uncat} transactions",
    ]
    telegram_send("\n".join(lines))
    healthchecks_push(JOB_ID, "success", "weekly digest sent")
    print("digest sent")


main()
