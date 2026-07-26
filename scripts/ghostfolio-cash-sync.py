#!/usr/bin/env python3
"""Sync Revolut cash balances from Firefly III into Ghostfolio accounts.

Runs daily 07:00 via ~/Library/LaunchAgents/com.homelab.ghostfolio-cash-sync.plist
Creates the Ghostfolio accounts on first run; updates balances after.
Silent on success; Telegram alert to the Finance topic on failure.
"""
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

HOMELAB = pathlib.Path.home() / "homelab"
FIREFLY = "http://localhost:8086/api/v1"
GHOSTFOLIO = "http://localhost:3333/api/v1"

env = (HOMELAB / ".env").read_text()

def kuma_push(status, message):
    subprocess.run(
        [str(HOMELAB / "scripts/kuma-push.sh"), "KUMA_PUSH_GHOSTFOLIO_CASH_SYNC", status, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

def env_var(name, default=""):
    m = re.search(r"^{}=(.+)$".format(name), env, re.M)
    return m.group(1).strip() if m else default

# Firefly account id -> Ghostfolio account name, as JSON in .env:
# GHOSTFOLIO_ACCOUNT_MAP={"12": "Checking", "13": "Savings"}
ACCOUNTS = json.loads(env_var("GHOSTFOLIO_ACCOUNT_MAP", "{}"))

def call(url, headers, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def telegram_alert(text):
    token = env_var("TELEGRAM_BOT_TOKEN")
    chat = env_var("TELEGRAM_CHAT_ID")
    thread = env_var("TELEGRAM_TOPIC_FINANCE", "208")
    data = urllib.parse.urlencode(
        {"chat_id": chat, "message_thread_id": thread, "text": text}).encode()
    urllib.request.urlopen(
        "https://api.telegram.org/bot{}/sendMessage".format(token), data=data, timeout=10)

def main():
    ff_headers = {"Authorization": "Bearer {}".format(env_var("FIREFLY_ACCESS_TOKEN")),
                  "Accept": "application/json"}
    balances = {}
    for ff_id, name in ACCOUNTS.items():
        acct = call("{}/accounts/{}".format(FIREFLY, ff_id), ff_headers)
        balances[name] = float(acct["data"]["attributes"]["current_balance"])

    security_token = (HOMELAB / "config/ghostfolio/SECURITY_TOKEN").read_text().strip()
    auth = call("{}/auth/anonymous".format(GHOSTFOLIO),
                {"Content-Type": "application/json"},
                {"accessToken": security_token})["authToken"]
    gf_headers = {"Authorization": "Bearer {}".format(auth),
                  "Content-Type": "application/json"}

    existing = {a["name"]: a for a in call("{}/account".format(GHOSTFOLIO), gf_headers)["accounts"]}
    for name, balance in balances.items():
        found = existing.get(name)
        if found:
            call("{}/account/{}".format(GHOSTFOLIO, found["id"]), gf_headers,
                 {"id": found["id"], "name": name, "currency": "EUR",
                  "balance": balance, "platformId": None}, method="PUT")
            print("updated {}: {:.2f} EUR".format(name, balance))
            continue
        call("{}/account".format(GHOSTFOLIO), gf_headers,
             {"name": name, "currency": "EUR", "balance": balance, "platformId": None},
             method="POST")
        print("created {}: {:.2f} EUR".format(name, balance))

try:
    kuma_push("start", "cash sync started")
    main()
    kuma_push("up", "cash sync ok")
except Exception as exc:
    kuma_push("down", "cash sync failed")
    telegram_alert("⚠️ Ghostfolio cash sync failed: {}".format(exc))
    sys.exit(1)
