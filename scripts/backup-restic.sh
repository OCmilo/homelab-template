#!/usr/bin/env bash
# Daily restic snapshot of the stack state into iCloud Drive, with an
# optional Backblaze B2 mirror when RESTIC_B2_* variables are present in .env.
# Backs up: repo checkout (config/.env/docs/scripts/.git) + Calibre library.
# Explicitly NOT backed up: MediaData content (movies/tv/audiobooks/torrents).
#
# SQLite safety: host-side sqlite3 against live container databases is FORBIDDEN —
# host and guest SQLite do not share locks coherently over the Colima mount, and
# host-side reads have corrupted service databases outright. Instead, the SQLite
# services are stopped for the ~10s restic run so their bind-mounted files are
# quiesced and consistent. Uptime Kuma (named volume) stays up; its db is exported
# with sqlite3 INSIDE the VM, where the filesystem is coherent.
#
# Paperless gets a document_exporter pass before services stop: a portable,
# version-independent export (originals + archive + metadata manifest) that
# restores cleanly even if the raw database copy is unusable.
#
# iCloud hazard: fileproviderd can wedge an open() on the repo forever. That has
# hung restic for hours mid-backup with all services stopped and no alert raised,
# since fail() never ran. Every step that can block therefore runs under run_timed,
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
  # Values may be quoted either way: spaces need quoting for `source .env`,
  # and JSON values force single quotes.
  sed -n "s/^${key}=//p" "${HOMELAB}/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
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

# Every service below is profile-gated, so an install that does not run a
# module must not try to stop, exec into, or snapshot it: `docker compose stop`
# on a disabled service fails the whole backup, and the rest would warn nightly
# until the operator stopped reading the alerts.
ENABLED_SERVICES="$(docker compose config --services 2>/dev/null || true)"
# Empty means Compose could not read the project at all. Continuing would stop
# nothing, snapshot nothing, and still report a clean backup.
[ -n "${ENABLED_SERVICES}" ] || { echo "FATAL: docker compose config --services returned nothing" >&2; exit 1; }
enabled() { printf '%s\n' "${ENABLED_SERVICES}" | grep -qxF -- "$1"; }

SELECTED_SERVICES=()
for service in "${SQLITE_SERVICES[@]}"; do
  if enabled "${service}"; then
    SELECTED_SERVICES+=("${service}")
  fi
done
SQLITE_SERVICES=(${SELECTED_SERVICES[@]+"${SELECTED_SERVICES[@]}"})

restart_services() {
  docker compose start "${SQLITE_SERVICES[@]}" >> "${LOG}" 2>&1 || {
    degrade "service restart failed — containers may still be stopped"
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

fail() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') restic backup FAILED: $1" | tee -a "${LOG}" >&2
  # Healthchecks is stopped during the cold database snapshot.  Bring it back
  # before posting the failure, otherwise the only failure signal is lost.
  restart_services
  trap - EXIT
  for attempt in {1..15}; do
    if curl -fsS -m 2 "${HEALTHCHECKS_BASE_URL:-http://127.0.0.1:8008}/" >/dev/null; then
      "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP down "$1"
      exit 1
    fi
    sleep 2
  done
  echo "$(date '+%Y-%m-%d %H:%M:%S') WARNING: Healthchecks unavailable; failure ping could not be sent" >> "${LOG}"
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP down "$1"
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
    fail "Backblaze B2 restic copy step (failed or timed out)"
  run_b2_timed 1800 restic -r "${RESTIC_B2_REPOSITORY}" forget --keep-last "${RESTIC_B2_KEEP_LAST}" --prune ||
    fail "Backblaze B2 restic retention/prune step (failed or timed out)"
  run_b2_timed 1800 restic -r "${RESTIC_B2_REPOSITORY}" check ||
    fail "Backblaze B2 restic integrity check (failed or timed out)"
  echo "$(date '+%Y-%m-%d %H:%M:%S') backblaze b2 mirror ok: keep-last ${RESTIC_B2_KEEP_LAST}" >> "${LOG}"
}

"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP start "backup started"

rm -rf "${SNAP_DIR}"
mkdir -p "${SNAP_DIR}"
if enabled uptime-kuma; then
  run_timed 300 docker run --rm -v homelab_kuma-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
      'apk add -q sqlite && sqlite3 /data/kuma.db ".backup /snap/kuma-volume_kuma.db"' ||
    degrade "kuma volume snapshot failed"
fi

if enabled karakeep; then
  run_timed 600 docker run --rm -v homelab_karakeep-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
      'apk add -q sqlite && sqlite3 /data/db.db ".backup /snap/karakeep-volume_db.db" && { [ ! -d /data/assets ] || tar czf /snap/karakeep-volume_assets.tgz -C /data assets; }' ||
    degrade "karakeep volume snapshot failed"
fi

if enabled paperless; then
  run_timed 900 docker compose exec -T paperless document_exporter ../export --delete --no-progress-bar ||
    degrade "paperless export failed (raw data dir still backed up)"
fi

if enabled ghostfolio-db; then
  run_timed 300 docker compose exec -T ghostfolio-db sh -c \
      'pg_dump -U ghostfolio -Fc ghostfolio > /dumps/ghostfolio.dump' ||
    degrade "ghostfolio pg_dump failed (raw data dir still backed up)"
fi

run_timed 300 docker compose stop "${SQLITE_SERVICES[@]}" || fail "stopping services"

if enabled jellyfin; then
  run_timed 600 docker run --rm -v homelab_jellyfin-config:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
      'tar czf /snap/jellyfin-volume_config.tgz -C /data .' ||
    degrade "jellyfin volume snapshot failed (raw named volume still exists)"
fi

if enabled beszel; then
  run_timed 300 docker run --rm -v homelab_beszel-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
      'tar czf /snap/beszel-volume_data.tgz -C /data .' ||
    degrade "beszel volume snapshot failed (raw named volume still exists)"
fi

run_timed 300 docker run --rm -v homelab_healthchecks-data:/data -v "${SNAP_DIR}:/snap" alpine sh -c \
    'tar czf /snap/healthchecks-volume_data.tgz -C /data .' ||
  degrade "healthchecks volume snapshot failed (raw named volume still exists)"

run_timed 1800 restic backup \
  --exclude "${HOMELAB}/cache" \
  --exclude "${HOMELAB}/bin" \
  --exclude "${HOMELAB}/config/adguardhome-host" \
  --exclude "${HOMELAB}/config/_retired" \
  --exclude-caches \
  "${HOMELAB}" "${CALIBRE_LIBRARY}" || fail "primary restic backup step (failed or timed out)"

restart_services
trap - EXIT

run_timed 900 restic forget --keep-daily 7 --keep-weekly 8 --keep-monthly 6 --prune ||
  fail "primary restic retention/prune step (failed or timed out)"

run_timed 900 restic check || fail "primary restic integrity check (failed or timed out)"

mirror_to_b2

SNAPSHOT_COUNT="$(restic snapshots --json | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "snapshots")')"

# A degraded run carries its warning text into Healthchecks because the missing
# pieces are exactly the ones a restore would need.
WARNINGS=""
[ "${#DEGRADED[@]}" -eq 0 ] || {
  WARNINGS="$(printf '\n⚠️ %s' "${DEGRADED[@]}")"
}

echo "$(date '+%Y-%m-%d %H:%M:%S') restic backup ok: ${SNAPSHOT_COUNT} (${#DEGRADED[@]} degraded steps)" >> "${LOG}"
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_BACKUP up "backup ok: ${SNAPSHOT_COUNT}${WARNINGS}"
