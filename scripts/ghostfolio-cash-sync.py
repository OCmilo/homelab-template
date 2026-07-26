#!/usr/bin/env python3
"""Sync bank cash balances from Firefly III into Ghostfolio accounts.

Each account keeps the currency Firefly holds it in — Ghostfolio converts for
its own reporting, so mislabelling the currency here would silently misprice
the whole cash position.

Runs daily 07:00 via ~/Library/LaunchAgents/com.homelab.ghostfolio-cash-sync.plist
Creates the Ghostfolio accounts on first run; updates balances after.
Silent on success; Telegram alert to the Finance topic on failure.
"""
import json
import subprocess
import sys
import urllib.request

import firefly_lib
from firefly_lib import ENV, telegram_send

HOMELAB = firefly_lib.HOMELAB
FIREFLY = "http://localhost:8086/api/v1"
GHOSTFOLIO = "http://localhost:3333/api/v1"

def kuma_push(status, message):
    subprocess.run(
        [str(HOMELAB / "scripts/kuma-push.sh"), "KUMA_PUSH_GHOSTFOLIO_CASH_SYNC", status, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

# Firefly account id -> Ghostfolio account name, as JSON in .env:
# GHOSTFOLIO_ACCOUNT_MAP={"12": "Checking", "13": "Savings"}
ACCOUNTS = json.loads(ENV.get("GHOSTFOLIO_ACCOUNT_MAP", "{}"))

def call(url, headers, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def main():
    ff_headers = {"Authorization": "Bearer {}".format(ENV["FIREFLY_ACCESS_TOKEN"]),
                  "Accept": "application/json"}
    balances = {}
    for ff_id, name in ACCOUNTS.items():
        attrs = call("{}/accounts/{}".format(FIREFLY, ff_id), ff_headers)["data"]["attributes"]
        balances[name] = (float(attrs["current_balance"]), attrs["currency_code"])

    security_token = (HOMELAB / "config/ghostfolio/SECURITY_TOKEN").read_text().strip()
    auth = call("{}/auth/anonymous".format(GHOSTFOLIO),
                {"Content-Type": "application/json"},
                {"accessToken": security_token})["authToken"]
    gf_headers = {"Authorization": "Bearer {}".format(auth),
                  "Content-Type": "application/json"}

    existing = {a["name"]: a for a in call("{}/account".format(GHOSTFOLIO), gf_headers)["accounts"]}
    for name, (balance, currency) in balances.items():
        found = existing.get(name)
        if found:
            call("{}/account/{}".format(GHOSTFOLIO, found["id"]), gf_headers,
                 {"id": found["id"], "name": name, "currency": currency,
                  "balance": balance, "platformId": None}, method="PUT")
            print("updated {}: {:.2f} {}".format(name, balance, currency))
            continue
        call("{}/account".format(GHOSTFOLIO), gf_headers,
             {"name": name, "currency": currency, "balance": balance, "platformId": None},
             method="POST")
        print("created {}: {:.2f} {}".format(name, balance, currency))

try:
    kuma_push("start", "cash sync started")
    main()
    kuma_push("up", "cash sync ok")
except Exception as exc:
    kuma_push("down", "cash sync failed")
    telegram_send("⚠️ Ghostfolio cash sync failed: {}".format(exc))
    sys.exit(1)
