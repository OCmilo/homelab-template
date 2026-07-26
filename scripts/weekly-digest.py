#!/usr/bin/env python3
"""Weekly finance digest: month-to-date budget envelope status to Telegram.

Runs Mondays 09:00 via ~/Library/LaunchAgents/com.homelab.weekly-digest.plist
"""
import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

HOMELAB = pathlib.Path.home() / "homelab"
BASE = "http://localhost:8086/api/v1"

env = (HOMELAB / ".env").read_text()

def kuma_push(status, message):
    subprocess.run(
        [str(HOMELAB / "scripts/kuma-push.sh"), "KUMA_PUSH_WEEKLY_DIGEST", status, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

def report_unhandled(exc_type, exc, tb):
    kuma_push("down", "weekly digest failed")
    sys.__excepthook__(exc_type, exc, tb)

sys.excepthook = report_unhandled
kuma_push("start", "weekly digest started")

def env_var(name, default=""):
    m = re.search(r"^{}=(.+)$".format(name), env, re.M)
    return m.group(1).strip() if m else default

TOKEN = env_var("FIREFLY_ACCESS_TOKEN")
HEADERS = {"Authorization": "Bearer {}".format(TOKEN), "Accept": "application/json"}

def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    return json.load(urllib.request.urlopen(req, timeout=120))

today = datetime.date.today()
start = today.replace(day=1)
next_month = (start + datetime.timedelta(days=32)).replace(day=1)
days_in_month = (next_month - start).days
pace = 100 * today.day / days_in_month

rows = []
total_budget = total_spent = 0.0
for b in get("/budgets?limit=100&start={}&end={}".format(start, today))["data"]:
    a = b["attributes"]
    amount = float(a.get("auto_budget_amount") or 0)
    if not amount:
        continue
    spent = -sum(float(s["sum"]) for s in a.get("spent", []))
    total_budget += amount
    total_spent += spent
    pct = 100 * spent / amount
    flag = "\U0001F534" if pct > 100 else ("⚠️" if pct > pace + 20 else "✅")
    rows.append((pct, "{} {}: {:.0f}/{:.0f} ({:.0f}%)".format(flag, a["name"], spent, amount, pct)))

rows.sort(reverse=True)

q = urllib.parse.quote('has_no_category:true type:withdrawal date_after:{} date_before:{}'.format(start, today))
uncat = get("/search/transactions?query={}&limit=1".format(q))["meta"]["pagination"]["total"]

summary = get("/summary/basic?start={}&end={}".format(start, today))
earned = spent_all = 0.0
for key, val in summary.items():
    if key.startswith("earned-in-"):
        earned += float(val["monetary_value"])
    if key.startswith("spent-in-"):
        spent_all += float(val["monetary_value"])

lines = ["\U0001F4CA Finance digest — {} (day {}/{}, {:.0f}% through the month)".format(
    today.strftime("%b %d"), today.day, days_in_month, pace), ""]
lines += [r[1] for r in rows]
lines += ["",
          "Budgeted spend: {:.0f}/{:.0f} EUR".format(total_spent, total_budget),
          "All spending: {:.0f} EUR | Income: {:.0f} EUR".format(-spent_all, earned),
          "Uncategorized this month: {} transactions".format(uncat)]
text = "\n".join(lines)

tg_token = env_var("TELEGRAM_BOT_TOKEN")
tg_chat = env_var("TELEGRAM_CHAT_ID")
thread = env_var("TELEGRAM_TOPIC_FINANCE", "208")
data = urllib.parse.urlencode({"chat_id": tg_chat, "message_thread_id": thread, "text": text}).encode()
urllib.request.urlopen("https://api.telegram.org/bot{}/sendMessage".format(tg_token), data=data, timeout=10)
kuma_push("up", "weekly digest sent")
print("digest sent")
