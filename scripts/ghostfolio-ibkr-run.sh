#!/bin/sh
set -eu

LOCK=/root/ghost.lock
MAPPING=/usr/app/src/mapping.yaml

STRICT_MAIN=/usr/app/src/strict_main.py

notify_failure() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || return 0
  [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0

  ERROR_TEXT="$1" python -c '
import os
import urllib.parse
import urllib.request

text = "Ghostfolio IBKR sync failed:\n{}".format(os.environ.get("ERROR_TEXT", "unknown error"))
data = urllib.parse.urlencode({
    "chat_id": os.environ["TELEGRAM_CHAT_ID"],
    "message_thread_id": os.environ.get("TELEGRAM_TOPIC_FINANCE", "1"),
    "text": text[:3500],
}).encode()
urllib.request.urlopen(
    "https://api.telegram.org/bot{}/sendMessage".format(os.environ["TELEGRAM_BOT_TOKEN"]),
    data=data,
    timeout=10,
)
' || true
}

healthchecks_push() {
  signal="$1"
  message="$2"
  [ -n "${HEALTHCHECKS_PING_KEY:-}" ] || return 0
  suffix=""
  case "${signal}" in
    start) suffix="/start" ;;
    success) ;;
    fail) suffix="/fail" ;;
  esac
  wget -qO- --post-data "${message}" \
    "${HEALTHCHECKS_BASE_URL:-http://healthchecks:8000}/ping/${HEALTHCHECKS_PING_KEY}/ghostfolio-ibkr-sync${suffix}" \
    >/dev/null 2>&1 || true
}

fail() {
  echo "ERROR: $1" >&2
  healthchecks_push fail "$1"
  notify_failure "$1"
  exit 1
}

if [ ! -f "$MAPPING" ]; then
  fail "missing Ghostfolio IBKR mapping file at $MAPPING"
fi

if ! grep -Eq "^[[:space:]]*symbol_mapping:" "$MAPPING"; then
  fail "invalid Ghostfolio IBKR mapping file at $MAPPING"
fi

if [ ! -f "$STRICT_MAIN" ]; then
  fail "missing strict Ghostfolio IBKR runner at $STRICT_MAIN"
fi

if [ ! -f "$LOCK" ]; then
  touch "$LOCK"
  trap 'rm -f "$LOCK"' EXIT INT TERM
  echo "Starting Sync"
  healthchecks_push start "ibkr sync started"
  cd /usr/app/src || exit 1
  if output="$(python strict_main.py 2>&1)"; then
    printf '%s\n' "$output"
  else
    status=$?
    printf '%s\n' "$output" >&2
    healthchecks_push fail "$output"
    notify_failure "$output"
    exit "$status"
  fi
  echo "Finished Sync"
  healthchecks_push success "ibkr sync ok"
else
  fail "lock-file present $LOCK, try increasing time between runs, next schedule will be $CRON"
fi
