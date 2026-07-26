#!/bin/sh
set -eu

healthchecks_push() {
  job_id="$1"
  signal="$2"
  message="$3"
  [ -n "${HEALTHCHECKS_PING_KEY:-}" ] || return 0
  suffix=""
  case "${signal}" in
    start) suffix="/start" ;;
    success) ;;
    fail) suffix="/fail" ;;
  esac
  wget -qO- --post-data "${message}" \
    "${HEALTHCHECKS_BASE_URL:-http://healthchecks:8000}/ping/${HEALTHCHECKS_PING_KEY}/${job_id}${suffix}" \
    >/dev/null 2>&1 || true
}

run_housekeeping() {
  healthchecks_push firefly-housekeeping start "firefly housekeeping started"
  if wget -qO- "http://firefly:8080/api/v1/cron/${FIREFLY_CRON_TOKEN}"; then
    healthchecks_push firefly-housekeeping success "firefly housekeeping ok"
  else
    healthchecks_push firefly-housekeeping fail "firefly housekeeping failed"
    exit 1
  fi
}

run_autoimport() {
  healthchecks_push firefly-autoimport start "firefly autoimport started"
  if wget -qO- --post-data '' "http://firefly-importer:8080/autoimport?directory=/import&secret=${FIREFLY_AUTO_IMPORT_SECRET}"; then
    healthchecks_push firefly-autoimport success "firefly autoimport ok"
  else
    healthchecks_push firefly-autoimport fail "firefly autoimport failed"
    exit 1
  fi
}

run_daemon() {
  apk add -q tzdata
  ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime
  {
    echo "0 2 * * * /usr/local/bin/firefly-cron-run.sh housekeeping"
    echo "30 2 * * * /usr/local/bin/firefly-cron-run.sh autoimport"
  } > /etc/crontabs/root
  crond -f -L /dev/stdout
}

case "${1:-}" in
  housekeeping) run_housekeeping ;;
  autoimport) run_autoimport ;;
  daemon) run_daemon ;;
  *) echo "usage: $0 housekeeping|autoimport|daemon" >&2; exit 64 ;;
esac
