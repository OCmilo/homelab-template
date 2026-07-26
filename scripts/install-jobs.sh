#!/usr/bin/env bash
# Render the launchd job templates (jobs/launchd/*.plist) into
# ~/Library/LaunchAgents and (re)load any that changed. Templates use
# @@HOME@@/homelab where this checkout lives — launchd cannot expand env vars
# in ProgramArguments, so paths are stamped at install time. Safe to re-run.
set -euo pipefail

HOMELAB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "${AGENTS_DIR}"

for template in "${HOMELAB}"/jobs/launchd/*.plist; do
  name="$(basename "${template}")"
  target="${AGENTS_DIR}/${name}"
  # Templates spell the checkout as @@HOME@@/homelab; substituting the whole
  # prefix keeps a clone at any other path working.
  rendered="$(sed -e "s|@@HOME@@/homelab|${HOMELAB}|g" -e "s|@@HOME@@|${HOME}|g" "${template}")"
  if [ -f "${target}" ] && [ "${rendered}" = "$(cat "${target}")" ]; then
    echo "unchanged: ${name}"
    continue
  fi
  # Unload before overwriting: launchctl reads the Label out of the file on
  # disk, so unloading afterwards would miss a job whose Label just changed.
  [ ! -f "${target}" ] || launchctl unload "${target}" 2>/dev/null || true
  printf '%s\n' "${rendered}" > "${target}"
  launchctl load "${target}"
  echo "installed: ${name}"
done
