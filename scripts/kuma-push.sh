#!/usr/bin/env bash
# Send scheduled-job telemetry to Healthchecks. The first argument is the
# legacy Kuma env-var name callers still pass; it only selects the check slug.
# Usage: kuma-push.sh <LEGACY_KUMA_ENV> <start|up|down> <message>
set -euo pipefail

HOMELAB="${HOMELAB:-${HOME}/homelab}"
HEALTHCHECKS_ENV="${HOMELAB}/config/healthchecks/ping-urls.env"

env_name="${1:?env var name required}"
status="${2:?status required}"
message="${3:-OK}"

case "${env_name}" in
  KUMA_PUSH_BACKUP) job_id=restic-backup ;;
  KUMA_PUSH_EB_CONSENT_REMINDER) job_id=enable-banking-consent-reminder ;;
  KUMA_PUSH_GHOSTFOLIO_CASH_SYNC) job_id=ghostfolio-cash-sync ;;
  KUMA_PUSH_SUBTITLE_TRANSLATE) job_id=subtitle-translation-fallback ;;
  KUMA_PUSH_TRIVY|KUMA_PUSH_TRIVY_SCAN) job_id=trivy-vulnerability-scan ;;
  KUMA_PUSH_WEEKLY_DIGEST) job_id=weekly-finance-digest ;;
  KUMA_PUSH_WIKI_AGENT_ENRICH_NOTE) job_id=wiki-note-enrichment ;;
  KUMA_PUSH_WIKI_AGENT_INGEST_INBOX) job_id=wiki-inbox-ingestion ;;
  KUMA_PUSH_WIKI_AGENT_LINT_WIKI) job_id=wiki-lint ;;
  KUMA_PUSH_WIKI_AGENT_REFRESH_MOC) job_id=wiki-map-of-content-refresh ;;
  KUMA_PUSH_WIKI_KARAKEEP) job_id=karakeep-wiki-intake ;;
  KUMA_PUSH_WIKI_PODCAST) job_id=wiki-podcast-transcription ;;
  *) exit 0 ;;
esac

[ -f "${HEALTHCHECKS_ENV}" ] || exit 0
set -a
# shellcheck disable=SC1090
source "${HEALTHCHECKS_ENV}"
set +a
[ -n "${HEALTHCHECKS_PING_KEY:-}" ] || exit 0

case "${status}" in
  start) hc_suffix="/start" ;;
  up) hc_suffix="" ;;
  down) hc_suffix="/fail" ;;
  *) echo "invalid job status: ${status}" >&2; exit 64 ;;
esac

hc_base="${HEALTHCHECKS_BASE_URL:-http://127.0.0.1:8008}"
curl -fsS -m 10 -X POST \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary "${message}" \
  "${hc_base}/ping/${HEALTHCHECKS_PING_KEY}/${job_id}${hc_suffix}" >/dev/null 2>&1 || true
