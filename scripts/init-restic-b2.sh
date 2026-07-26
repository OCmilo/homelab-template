#!/usr/bin/env bash
# One-time initialization for the encrypted Backblaze B2 restic mirror.
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
ICLOUD_REPO="${HOME}/Library/Mobile Documents/com~apple~CloudDocs/homelab-backups/restic-repo"

env_value() {
  local key=$1
  sed -n "s/^${key}=//p" "${HOMELAB}/.env" | tail -n 1
}

RESTIC_PASSWORD="$(env_value RESTIC_PASSWORD)"
RESTIC_B2_REPOSITORY="$(env_value RESTIC_B2_REPOSITORY)"
RESTIC_B2_AWS_ACCESS_KEY_ID="$(env_value RESTIC_B2_AWS_ACCESS_KEY_ID)"
RESTIC_B2_AWS_SECRET_ACCESS_KEY="$(env_value RESTIC_B2_AWS_SECRET_ACCESS_KEY)"
RESTIC_B2_AWS_DEFAULT_REGION="$(env_value RESTIC_B2_AWS_DEFAULT_REGION)"

[ -n "${RESTIC_PASSWORD}" ] || { echo "FATAL: RESTIC_PASSWORD missing from .env" >&2; exit 1; }
[ -n "${RESTIC_B2_REPOSITORY}" ] || { echo "FATAL: RESTIC_B2_REPOSITORY missing from .env" >&2; exit 1; }
[ -n "${RESTIC_B2_AWS_ACCESS_KEY_ID}" ] || { echo "FATAL: RESTIC_B2_AWS_ACCESS_KEY_ID missing from .env" >&2; exit 1; }
[ -n "${RESTIC_B2_AWS_SECRET_ACCESS_KEY}" ] || { echo "FATAL: RESTIC_B2_AWS_SECRET_ACCESS_KEY missing from .env" >&2; exit 1; }

export RESTIC_PASSWORD
export RESTIC_FROM_PASSWORD="${RESTIC_PASSWORD}"
export AWS_ACCESS_KEY_ID="${RESTIC_B2_AWS_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${RESTIC_B2_AWS_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="${RESTIC_B2_AWS_DEFAULT_REGION}"

restic -r "${RESTIC_B2_REPOSITORY}" init \
  --from-repo "${ICLOUD_REPO}" \
  --copy-chunker-params

restic -r "${RESTIC_B2_REPOSITORY}" check

echo "Backblaze B2 restic repository initialized and encrypted with RESTIC_PASSWORD."
