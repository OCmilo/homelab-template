#!/bin/bash
# Asserts what the seatbelt profile denies. Costs nothing and calls no model:
# every check is a real syscall under the real profile.
#
# This exists because the profile shipped once with three grants that readmitted
# what it was advertised to exclude, and with a commit message claiming a denial
# that never held. Prose about a sandbox is worth nothing; these are the claims.
#
#   scripts/test-sandbox-profile.sh
set -uo pipefail

HOMELAB="${HOMELAB:-${HOME}/homelab}"
VAULT="${WIKI_VAULT:-${HOMELAB}/config/wiki-vault}"
AGENTCONFIG="${HOMELAB}/config/wiki-agent/opencode"
PROFILE="${AGENTCONFIG}/sandbox.sb"
OPENCODE_BIN="${WIKI_OPENCODE_BIN:-/usr/local/bin/opencode}"
OCLIB="$(dirname "$(dirname "$(readlink -f "${OPENCODE_BIN}")")")"

PASS=0
FAIL=0

sb() {
  /usr/bin/sandbox-exec \
    -D VAULT="${VAULT}" \
    -D SKILLS="${HOMELAB}/config/wiki-agent/skills" \
    -D AGENTCONFIG="${AGENTCONFIG}" \
    -D OCLIB="${OCLIB}" \
    -D OCSTATE="${HOME}/.local/share/opencode" \
    -D OCLOCALSTATE="${HOME}/.local/state/opencode" \
    -D OCCACHE="${HOME}/.cache/opencode" \
    -D OCCONFIG="${HOME}/.config/opencode" \
    -D USERHOME="${HOME}" \
    -D USERTEXTENCODING="${HOME}/.CFUserTextEncoding" \
    -D VAULTPLUGINS="${VAULT}/.opencode" \
    -f "${PROFILE}" "$@"
}

check() {
  local expect="$1" label="$2"; shift 2
  local got=allowed
  "$@" >/dev/null 2>&1 || got=denied
  printf '  %-8s %-52s ' "${expect}" "${label}"
  [ "${got}" = "${expect}" ] && { echo ok; PASS=$((PASS + 1)); } \
                            || { echo "FAILED (got ${got})"; FAIL=$((FAIL + 1)); }
}

echo "== reads that must be refused =="
check denied "~/.env (every credential on the host)"      sb /usr/bin/wc -l "${HOMELAB}/.env"
check denied "~/.ssh private key"                          sb /usr/bin/wc -l "${HOME}/.ssh/id_ed25519"
check denied "codex auth.json"                             sb /usr/bin/wc -l "${AGENTCONFIG}/../codex-home/auth.json"
check denied "shell rc outside the vault"                  sb /usr/bin/wc -l "${HOME}/.zshrc"
check denied "/etc/passwd"                                 sb /usr/bin/grep -c root /etc/passwd

echo "== writes that must be refused =="
check denied "plugin dir inside the vault (auto-executed)" sb /bin/mkdir -p "${VAULT}/.opencode/plugins"
check denied "global opencode config (auto-executed)"      sb /usr/bin/touch "${HOME}/.config/opencode/.probe"
check denied "anywhere in \$HOME"                          sb /usr/bin/touch "${HOME}/.sandbox-probe"
check denied "the permission map it runs under"            sb /usr/bin/touch "${AGENTCONFIG}/opencode.json"

echo "== sockets that must be refused =="
check denied "colima docker socket (would be host root)"   sb /usr/bin/curl -s --max-time 5 \
  --unix-socket "${HOME}/.colima/default/docker.sock" http://localhost/version

echo "== access the agent genuinely needs =="
check allowed "read a vault page"                          sb /bin/ls "${VAULT}/wiki"
check allowed "write inside the vault"                     sb /usr/bin/touch "${VAULT}/.sandbox-probe"
rm -f "${VAULT}/.sandbox-probe"
check allowed "read the skill prompts"                     sb /bin/ls "${HOMELAB}/config/wiki-agent/skills"
check allowed "read the permission map"                    sb /usr/bin/wc -l "${AGENTCONFIG}/opencode.json"
check allowed "reach the model endpoint over TCP 443"      sb /usr/bin/curl -s --max-time 20 \
  -o /dev/null https://api.openai.com/v1/models

rmdir "${VAULT}/.opencode/plugins" "${VAULT}/.opencode" 2>/dev/null
rm -f "${HOME}/.config/opencode/.probe" "${HOME}/.sandbox-probe"

echo
echo "passed ${PASS}, failed ${FAIL}"
[ "${FAIL}" -eq 0 ]
