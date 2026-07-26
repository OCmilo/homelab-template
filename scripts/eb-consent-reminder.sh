#!/usr/bin/env bash
# Reminds via Telegram (Finance topic) when the Enable Banking consent is
# close to expiring. Banks commonly cap consent at 90 days; renewal is a manual
# OAuth-style flow, so the reminder carries the full instructions.
# Runs daily at 10:00 via ~/Library/LaunchAgents/com.homelab.eb-consent-reminder.plist
set -euo pipefail

HOMELAB="${HOMELAB:-${HOME}/homelab}"
THREAD_FINANCE="$(sed -n 's/^TELEGRAM_TOPIC_FINANCE=//p' "${HOMELAB}/.env")"
THREAD_FINANCE="${THREAD_FINANCE:-1}"
BANK_NAME="$(sed -n 's/^BANK_NAME=//p' "${HOMELAB}/.env" | tr -d '"')"
BANK_NAME="${BANK_NAME:-your bank}"
BANK_IMPORT_CONFIG="$(sed -n 's/^BANK_IMPORT_CONFIG=//p' "${HOMELAB}/.env" | tr -d '"')"
BANK_IMPORT_CONFIG="${BANK_IMPORT_CONFIG:-bank.json}"
STACK_HOST="$(sed -n 's/^STACK_HOST=//p' "${HOMELAB}/.env")"
PRIVATE_DOMAIN="$(sed -n 's/^PRIVATE_DOMAIN=//p' "${HOMELAB}/.env")"
IMPORTER_URL="https://importer.${STACK_HOST}.${PRIVATE_DOMAIN}"

telegram_send() {
  TG_TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "${HOMELAB}/.env")"
  TG_CHAT="$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "${HOMELAB}/.env")"
  [ -n "${TG_TOKEN}" ] && curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" -d message_thread_id="${THREAD_FINANCE}" \
    -d text="$1" \
    >/dev/null 2>&1 || true
}

kuma_push() {
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_EB_CONSENT_REMINDER "$1" "$2"
}
trap 'kuma_push down "consent reminder failed"' ERR
kuma_push start "consent reminder started"

EXPIRES="$(sed -n 's/^EB_CONSENT_EXPIRES=//p' "${HOMELAB}/.env")"
[ -n "${EXPIRES}" ] || { kuma_push up "no consent expiry configured"; exit 0; }

days_left=$(( ($(date -j -f '%Y-%m-%d %H:%M:%S' "${EXPIRES} 23:59:59" '+%s') - $(date '+%s')) / 86400 ))

# warn at 30/14/7/3/1 days out, then daily once expired
case "${days_left}" in
  30|14|7|3|1) headline="🏦 Enable Banking consent expires in ${days_left} day(s) — ${EXPIRES}." ;;
  *) [ "${days_left}" -le 0 ] || { kuma_push up "consent ok: ${days_left} days left"; exit 0; }
     headline="🚨 Enable Banking consent EXPIRED (${EXPIRES}) — nightly ${BANK_NAME} imports are dead until renewed." ;;
esac

telegram_send "${headline}

How to renew (~5 min):
1. Make sure this device resolves ${IMPORTER_URL#https://} through AdGuard or Tailscale split DNS.
2. Open ${IMPORTER_URL}
3. Start an import → Enable Banking → ${BANK_NAME} → re-authorize in the bank's mobile app so every account appears. Set validity to 90 days.
4. Run that import once from the UI and download the config JSON at the end.
5. Save it over ${HOMELAB}/config/firefly-importer/import/${BANK_IMPORT_CONFIG}, but keep the rolling date_range partial / 30 d, cell duplicate detection keyed by external-id, and the account mapping (each Enable Banking account type — CARD, CACC — to its Firefly asset account).
6. Update EB_CONSENT_EXPIRES in ${HOMELAB}/.env to the new date (today + 90 days). This reminder stops once the date moves."
kuma_push up "consent reminder sent: ${days_left} days left"
