#!/usr/bin/env bash
# Render the launchd job templates (jobs/launchd/*.plist) into
# ~/Library/LaunchAgents and (re)load any that changed. Templates use
# @@HOME@@ where the user home belongs — launchd cannot expand env vars in
# ProgramArguments, so paths are stamped at install time. Safe to re-run.
set -euo pipefail

HOMELAB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "${AGENTS_DIR}"

for template in "${HOMELAB}"/jobs/launchd/*.plist; do
  name="$(basename "${template}")"
  target="${AGENTS_DIR}/${name}"
  rendered="$(sed "s|@@HOME@@|${HOME}|g" "${template}")"
  if [ -f "${target}" ] && [ "${rendered}" = "$(cat "${target}")" ]; then
    echo "unchanged: ${name}"
    continue
  fi
  printf '%s\n' "${rendered}" > "${target}"
  launchctl unload "${target}" 2>/dev/null || true
  launchctl load "${target}"
  echo "installed: ${name}"
done
