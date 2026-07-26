#!/usr/bin/env bash
# Daily restic snapshot of the stack state into iCloud Drive, with an
# optional Backblaze B2 mirror when RESTIC_B2_* variables are present in .env.
# Backs up: repo checkout (config/.env/docs/scripts/.git) + Calibre library.
# Explicitly NOT backed up: MediaData content (movies/tv/audiobooks/torrents).
#
# SQLite safety: host-side sqlite3 against live container databases is FORBIDDEN —
# host and guest SQLite do not share locks coherently over the Colima mount, and
# host reads corrupted radarr.db and kuma.db on 2026-07-06. Instead, the SQLite
# services are stopped for the ~10s restic run so their bind-mounted files are
# quiesced and consistent. Uptime Kuma (named volume) stays up; its db is exported
# with sqlite3 INSIDE the VM, where the filesystem is coherent.
#
# Paperless gets a document_exporter pass before services stop: a portable,
# version-independent export (originals + archive + metadata manifest) that
# restores cleanly even if the raw database copy is unusable.
#
# iCloud hazard: fileproviderd can wedge an open() on the repo forever — on
# 2026-07-07 restic hung 8h mid-backup with all services stopped and no alert
# (fail() never ran). Every step that can block therefore runs under run_timed,
# turning a hang into a failure that alerts and restarts services via the trap.
# SIGTERM was not enough to unstick that hang; the watchdog uses SIGKILL.
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
LOG="${HOMELAB}/config/backup.log"

env_value() {
  local key=$1
  sed -n "s/^${key}=//p" "${HOMELAB}/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/'
}

DATA_ROOT="$(env_value DATA_ROOT)"
STACK_NAME="$(env_value STACK_NAME)"
STACK_NAME="${STACK_NAME:-Homelab}"
CALIBRE_LIBRARY="${DATA_ROOT}/media/ebooks/calibre-library"
SNAP_DIR="${HOMELAB}/config/db-snapshots"
# Stopped for the backup window: SQLite services (open-file coherence) plus
# the Ghostfolio pair — its raw Postgres data dir is copied cold, though the
# pg_dump taken beforehand is the restore path of record.
SQLITE_SERVICES=(sonarr radarr bazarr prowlarr jellyseerr jellyfin audiobookshelf calibre-web-automated shelfmark paperless firefly ghostfolio ghostfolio-db beszel healthchecks)

export RESTIC_REPOSITORY="${HOME}/Library/Mobile Documents/com~apple~CloudDocs/homelab-backups/restic-repo"
RESTIC_PASSWORD="$(env_value RESTIC_PASSWORD)"
export RESTIC_PASSWORD
[ -n "${RESTIC_PASSWORD}" ] || { echo "FATAL: RESTIC_PASSWORD missing from .env" >&2; exit 1; }

RESTIC_B2_REPOSITORY="$(env_value RESTIC_B2_REPOSITORY)"
RESTIC_B2_AWS_ACCESS_KEY_ID="$(env_value RESTIC_B2_AWS_ACCESS_KEY_ID)"
RESTIC_B2_AWS_SECRET_ACCESS_KEY="$(env_value RESTIC_B2_AWS_SECRET_ACCESS_KEY)"
RESTIC_B2_AWS_DEFAULT_REGION="$(env_value RESTIC_B2_AWS_DEFAULT_REGION)"
RESTIC_B2_KEEP_LAST="$(env_value RESTIC_B2_KEEP_LAST)"
RESTIC_B2_KEEP_LAST="${RESTIC_B2_KEEP_LAST:-8}"

# B2 is never used as a raw file sync target. It is a second restic repository:
# restic decrypts the iCloud source locally, then re-encrypts before upload.
B2_CONFIGURED=false
if [ -n "${RESTIC_B2_REPOSITORY}${RESTIC_B2_AWS_ACCESS_KEY_ID}${RESTIC_B2_AWS_SECRET_ACCESS_KEY}" ]; then
  [ -n "${RESTIC_B2_REPOSITORY}" ] || { echo "FATAL: RESTIC_B2_REPOSITORY missing from .env" >&2; exit 1; }
  [ -n "${RESTIC_B2_AWS_ACCESS_KEY_ID}" ] || { echo "FATAL: RESTIC_B2_AWS_ACCESS_KEY_ID missing from .env" >&2; exit 1; }
  [ -n "${RESTIC_B2_AWS_SECRET_ACCESS_KEY}" ] || { echo "FATAL: RESTIC_B2_AWS_SECRET_ACCESS_KEY missing from .env" >&2; exit 1; }
  B2_CONFIGURED=true
fi

cd "${HOMELAB}"

restart_services() {
  docker compose start "${SQLITE_SERVICES[@]}" >> "${LOG}" 2>&1 || {
    degrade "service restart failed — containers may still be stopped"
    telegram_alert "service restart failed — containers may still be stopped"
  }
}
trap restart_services EXIT
# untrapped TERM/INT would skip the EXIT trap and leave services stopped;
# the in-flight run_timed child would survive as an orphan, so kill it too.
# The pids expand to nothing when no child is running — `kill -9 0` would
# signal this script's own process group and fail() would never run.
trap 'kill -9 ${CURRENT_CMD_PID:-} ${CURRENT_WATCHDOG_PID:-} 2>/dev/null || true; fail "terminated by signal"' TERM INT

# Steps that are allowed to fail without aborting the backup still have to be
# visible: a run that lost a snapshot must not report a plain success.
DEGRADED=()
degrade() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') WARNING: $1" >> "${LOG}"
  DEGRADED+=("$1")
}

telegram_send() {
  TG_TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"
  TG_CHAT="$(env_value TELEGRAM_CHAT_ID)"
  local text=$1
  local silent=${2:-false}
  # Forum topic for backup alerts; they belong with monitoring.
  TG_TOPIC="$(env_value TELEGRAM_TOPIC_BACKUP)"
  [ -n "${TG_TOKEN}" ] && curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" -d message_thread_id="${TG_TOPIC:-1}" \
    -d disable_notification="${silent}" \
    -d text="${text}" \
    >/dev/null 2>&1 || true
}

telegram_alert() {
  telegram_send "🚨 ${STACK_NAME} backup FAILED: $1 — see config/backup.log"
}

fail() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') restic backup FAILED: $1" | tee -a "${LOG}" >&2
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP down "$1"
  telegram_alert "$1"
  exit 1
}

run_timed() {
  local limit=$1; shift
  "$@" >> "${LOG}" 2>&1 &
  local cmd_pid=$!
  CURRENT_CMD_PID=${cmd_pid}
  (sleep "${limit}"; kill -9 "${cmd_pid}" 2>/dev/null) &
  local watchdog_pid=$!
  CURRENT_WATCHDOG_PID=${watchdog_pid}
  wait "${cmd_pid}" && local rc=0 || local rc=$?
  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
  return "${rc}"
}

run_b2_timed() {
  local limit=$1; shift
  run_timed "${limit}" env \
    AWS_ACCESS_KEY_ID="${RESTIC_B2_AWS_ACCESS_KEY_ID}" \
    AWS_SECRET_ACCESS_KEY="${RESTIC_B2_AWS_SECRET_ACCESS_KEY}" \
    AWS_DEFAULT_REGION="${RESTIC_B2_AWS_DEFAULT_REGION}" \
    RESTIC_PASSWORD="${RESTIC_PASSWORD}" \
    RESTIC_FROM_PASSWORD="${RESTIC_PASSWORD}" \
    "$@"
}

mirror_to_b2() {
  [ "${B2_CONFIGURED}" = true ] || return 0

  echo "$(date '+%Y-%m-%d %H:%M:%S') backblaze b2 mirror starting" >> "${LOG}"
  run_b2_timed 7200 restic -r "${RESTIC_B2_REPOSITORY}" copy --from-repo "${RESTIC_REPOSITORY}" ||
    fail "backblaze copy step (failed or timed out)"
  run_b2_timed 1800 restic -r "${RESTIC_B2_REPOSITORY}" forget --keep-last "${RESTIC_B2_KEEP_LAST}" --prune ||
    fail "backblaze retention/prune step"
  run_b2_timed 1800 restic -r "${RESTIC_B2_REPOSITORY}" check ||
    fail "backblaze integrity check"
  echo "$(date '+%Y-%m-%d %H:%M:%S') backblaze b2 mirror ok: keep-last ${RESTIC_B2_KEEP_LAST}" >> "${LOG}"
}

"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP start "backup started"

rm -rf "${SNAP_DIR}"
mkdir -p "${SNAP_DIR}"
run_timed 300 docker run --rm -v homelab_kuma-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'apk add -q sqlite && sqlite3 /data/kuma.db ".backup /snap/kuma-volume_kuma.db"' ||
  degrade "kuma volume snapshot failed"

run_timed 600 docker run --rm -v homelab_karakeep-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'apk add -q sqlite && sqlite3 /data/db.db ".backup /snap/karakeep-volume_db.db" && { [ ! -d /data/assets ] || tar czf /snap/karakeep-volume_assets.tgz -C /data assets; }' ||
  degrade "karakeep volume snapshot failed"

run_timed 900 docker compose exec -T paperless document_exporter ../export --delete --no-progress-bar ||
  degrade "paperless export failed (raw data dir still backed up)"

run_timed 300 docker compose exec -T ghostfolio-db sh -c \
    'pg_dump -U ghostfolio -Fc ghostfolio > /dumps/ghostfolio.dump' ||
  degrade "ghostfolio pg_dump failed (raw data dir still backed up)"

run_timed 300 docker compose stop "${SQLITE_SERVICES[@]}" || fail "stopping services"

run_timed 600 docker run --rm -v homelab_jellyfin-config:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'tar czf /snap/jellyfin-volume_config.tgz -C /data .' ||
  degrade "jellyfin volume snapshot failed (raw named volume still exists)"

run_timed 300 docker run --rm -v homelab_beszel-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'tar czf /snap/beszel-volume_data.tgz -C /data .' ||
  degrade "beszel volume snapshot failed (raw named volume still exists)"

run_timed 300 docker run --rm -v homelab_healthchecks-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'tar czf /snap/healthchecks-volume_data.tgz -C /data .' ||
  degrade "healthchecks volume snapshot failed (raw named volume still exists)"

run_timed 1800 restic backup \
  --exclude "${HOMELAB}/cache" \
  --exclude "${HOMELAB}/bin" \
  --exclude "${HOMELAB}/config/adguardhome-host" \
  --exclude "${HOMELAB}/config/_retired" \
  --exclude-caches \
  "${HOMELAB}" "${CALIBRE_LIBRARY}" || fail "backup step (failed or timed out)"

restart_services
trap - EXIT

run_timed 900 restic forget --keep-daily 7 --keep-weekly 8 --keep-monthly 6 --prune || fail "forget/prune step"

run_timed 900 restic check || fail "integrity check"

mirror_to_b2

SNAPSHOT_COUNT="$(restic snapshots --json | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "snapshots")')"

B2_NOTE=""
[ "${B2_CONFIGURED}" != true ] || B2_NOTE="; Backblaze B2 mirror ok"

# A degraded run is reported as a warning, out loud (not silenced), because the
# missing pieces are exactly the ones a restore would need.
WARNINGS=""
ICON="✅"
STATUS="succeeded"
SILENT=true
[ "${#DEGRADED[@]}" -eq 0 ] || {
  WARNINGS="$(printf '\n⚠️ %s' "${DEGRADED[@]}")"
  ICON="⚠️"
  STATUS="completed with warnings"
  SILENT=false
}

echo "$(date '+%Y-%m-%d %H:%M:%S') restic backup ok: ${SNAPSHOT_COUNT} (${#DEGRADED[@]} degraded steps)" >> "${LOG}"
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP up "backup ok: ${SNAPSHOT_COUNT}${WARNINGS}"
telegram_send "${ICON} ${STACK_NAME} backup ${STATUS}: ${SNAPSHOT_COUNT}${B2_NOTE}${WARNINGS}" "${SILENT}"
