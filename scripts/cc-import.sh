#!/bin/bash
# Import a credit card statement CSV into Firefly III.
# Usage: cc-import.sh <statement.csv>
#
# Strips "Credit card repayment" TRANSFER rows first: the checking-account
# feed already carries those as transfers to the card account (rule 10), so
# importing the card-side row would double-count the repayment.
# Duplicate detection is hash-based, so re-importing a statement is a no-op.
set -euo pipefail
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

HOMELAB="${HOMELAB:-${HOME}/homelab}"
THREAD_FINANCE="$(sed -n 's/^TELEGRAM_TOPIC_FINANCE=//p' "${HOMELAB}/.env")"
THREAD_FINANCE="${THREAD_FINANCE:-1}"
CSV="${1:?usage: cc-import.sh <statement.csv>}"
IMPORT_DIR="${HOMELAB}/config/firefly-importer/import"
CONFIG="${HOMELAB}/config/firefly-importer/cc-statement.json"

telegram_send() {
  TG_TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "${HOMELAB}/.env")"
  TG_CHAT="$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "${HOMELAB}/.env")"
  [ -n "${TG_TOKEN}" ] && curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" -d message_thread_id="${THREAD_FINANCE}" \
    -d text="$1" \
    >/dev/null 2>&1 || true
}

head -1 "${CSV}" > "${IMPORT_DIR}/cc-statement.csv"
tail -n +2 "${CSV}" | grep -v '^TRANSFER.*Credit card repayment' >> "${IMPORT_DIR}/cc-statement.csv" || true
cp "${CONFIG}" "${IMPORT_DIR}/cc-statement.json"

rows=$(($(wc -l < "${IMPORT_DIR}/cc-statement.csv") - 1))
result="ok"
docker exec firefly-importer php artisan importer:import \
  /import/cc-statement.json /import/cc-statement.csv \
  > /tmp/cc-import-last.log 2>&1 || result="importer exited nonzero (duplicates count as errors; check /tmp/cc-import-last.log)"

created=$(grep -c "Created withdrawal\|Created deposit" /tmp/cc-import-last.log || true)
rm -f "${IMPORT_DIR}/cc-statement.csv" "${IMPORT_DIR}/cc-statement.json"

echo "rows submitted: ${rows}, transactions created: ${created}, status: ${result}"
telegram_send "💳 Credit card statement imported: ${created}/${rows} new transactions (${result})"
