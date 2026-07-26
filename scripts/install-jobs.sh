#!/usr/bin/env bash
# Render the launchd job templates (jobs/launchd/*.plist) into
# ~/Library/LaunchAgents and (re)load any that changed. Templates use
# @@HOME@@/homelab where this checkout lives — launchd cannot expand env vars
# in ProgramArguments, so paths are stamped at install time. Safe to re-run.
set -euo pipefail

HOMELAB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "${AGENTS_DIR}"

# Which modules are switched on lives in .env alongside the compose profiles,
# so enabling a module installs its jobs and disabling one uninstalls them.
# Only plists the registry knows about are filtered: an agent with no entry is
# left alone rather than read as "belongs to a disabled module".
DISABLED_PLISTS="$(python3 "${HOMELAB}/scripts/disabled-plists.py" "${HOMELAB}")"

for template in "${HOMELAB}"/jobs/launchd/*.plist; do
  name="$(basename "${template}")"
  target="${AGENTS_DIR}/${name}"
  # A job whose module is off must not linger as a loaded agent that fails on
  # every run, so disabling a module actively removes what it installed.
  if printf '%s\n' "${DISABLED_PLISTS}" | grep -qxF -- "${name}"; then
    [ ! -f "${target}" ] || { launchctl unload "${target}" 2>/dev/null || true; rm -f "${target}"; echo "removed: ${name} (module disabled)"; }
    continue
  fi
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
