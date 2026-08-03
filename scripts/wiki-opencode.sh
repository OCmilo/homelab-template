#!/bin/bash
# Runs opencode against the vault under a seatbelt profile.
#
#   wiki-opencode.sh <agent> <provider/model>   # prompt on stdin, JSON on stdout
#
# Both callers (wiki-agent.sh and wiki-ask-server.py) go through here so the
# confinement cannot be forgotten at one call site and not the other.
set -euo pipefail

AGENT="${1:?agent name required}"
MODEL="${2:?provider-qualified model required}"

HOMELAB="${HOMELAB:-${HOME}/homelab}"
VAULT="${WIKI_VAULT:-${HOMELAB}/config/wiki-vault}"
SKILLS="${HOMELAB}/config/wiki-agent/skills"
AGENTCONFIG="${HOMELAB}/config/wiki-agent/opencode"
PROFILE="${AGENTCONFIG}/sandbox.sb"
PERMISSIONS="${AGENTCONFIG}/opencode.json"
OPENCODE_BIN="${WIKI_OPENCODE_BIN:-/usr/local/bin/opencode}"
OCLIB="$(dirname "$(dirname "$(readlink -f "${OPENCODE_BIN}")")")"

for required in "${PROFILE}" "${PERMISSIONS}" "${OPENCODE_BIN}"; do
  [ -e "${required}" ] || { echo "wiki-opencode: missing ${required}" >&2; exit 1; }
done

# Bun opens far more descriptors than the macOS default soft limit of 256, and
# launchd hands daemons the same 256. Over the limit opencode aborts outright
# rather than degrading, so the failure is intermittent and scales with how
# many files the skill touches. The hard limit is unlimited; raise the soft one.
ulimit -n 4096 2>/dev/null || true
[ "$(ulimit -n)" -ge 4096 ] ||
  echo "wiki-opencode: fd limit is $(ulimit -n), runs touching many files may abort" >&2

# opencode creates these on first use; the profile grants them by name, and a
# missing directory would be denied rather than created.
for state in "${HOME}/.local/share/opencode" "${HOME}/.local/state/opencode" \
             "${HOME}/.cache/opencode" "${HOME}/.config/opencode"; do
  mkdir -p "${state}"
done

# The vault is the only directory the profile lets opencode work in, so the
# wrapper enters it rather than trusting the caller to. Starting anywhere else
# is denied at the first read, which bun reports as a "low max file
# descriptors" error naming an unrelated cause.
cd "${VAULT}"

# env -i rather than inheriting: wiki-agent.sh does `set -a; source .env`, which
# exports all 65 keys in that file — Restic, Telegram, Porkbun, NordVPN, the Ask
# token. No filesystem policy can hide an environment from the process that owns
# it, so the only fix is not to hand it over. opencode gets the four variables it
# needs and nothing else.
#
# The prompt moves from stdin to argv here. opencode reads stdin even when
# given a prompt argument and blocks until EOF, so $(cat) both supplies the
# argument and drains the pipe that would otherwise deadlock the run.
PROMPT="$(cat)"

exec /usr/bin/env -i \
  HOME="${HOME}" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  TERM="${TERM:-dumb}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:?OPENAI_API_KEY is required}" \
  OPENCODE_CONFIG="${PERMISSIONS}" \
  /usr/bin/sandbox-exec \
  -D VAULT="${VAULT}" \
  -D SKILLS="${SKILLS}" \
  -D AGENTCONFIG="${AGENTCONFIG}" \
  -D OCLIB="${OCLIB}" \
  -D OCSTATE="${HOME}/.local/share/opencode" \
  -D OCLOCALSTATE="${HOME}/.local/state/opencode" \
  -D OCCACHE="${HOME}/.cache/opencode" \
  -D OCCONFIG="${HOME}/.config/opencode" \
  -D USERHOME="${HOME}" \
  -D USERTEXTENCODING="${HOME}/.CFUserTextEncoding" \
  -D VAULTPLUGINS="${VAULT}/.opencode" \
  -f "${PROFILE}" \
  "${OPENCODE_BIN}" run \
    --agent "${AGENT}" \
    --format json \
    --auto \
    --model "${MODEL}" \
    "${PROMPT}"
