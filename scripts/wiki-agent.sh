#!/usr/bin/env bash
# Wiki agent runner (docs/wiki-system.md).
# Usage: wiki-agent.sh <enrich-note|ingest-inbox|refresh-moc|lint-wiki> [--retry]
#        wiki-agent.sh ingest-inbox --source system/raw/YYYY/file.md
#
# Work-gating hard rule: no LLM call when nothing is pending. Each skill has a
# cheap filesystem pre-check; a skipped run still pushes a Kuma heartbeat.
# Every run that touches the vault is committed to the vault git history
# (git dir lives at config/wiki-vault.git, outside the synced tree).
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
cd "${HOMELAB}"
set -a; source .env; set +a

VAULT="${WIKI_VAULT:-${HOMELAB}/config/wiki-vault}"
SKILLS_DIR="${HOMELAB}/config/wiki-agent/skills"
POLICY="${SKILLS_DIR}/untrusted-content-policy.md"
STATE_DIR="${HOMELAB}/config/wiki-agent/state"
SKILL="${1:?skill name required}"
RUN_MODE="${2:-}"
FORCE_SOURCE=""

case "${RUN_MODE}" in
  ""|--retry) ;;
  --source)
    [ "${SKILL}" = "ingest-inbox" ] || {
      echo "--source is only valid for ingest-inbox" >&2; exit 2;
    }
    FORCE_SOURCE="${3:?relative raw source path required}"
    case "${FORCE_SOURCE}" in
      system/raw/[0-9][0-9][0-9][0-9]/*.md) ;;
      *) echo "invalid raw source path: ${FORCE_SOURCE}" >&2; exit 2 ;;
    esac
    [ -f "${VAULT}/${FORCE_SOURCE}" ] || {
      echo "raw source not found: ${FORCE_SOURCE}" >&2; exit 2;
    }
    ;;
  *) echo "unknown run mode: ${RUN_MODE}" >&2; exit 2 ;;
esac

mkdir -p "${STATE_DIR}"
CODEX_JSON=""
CODEX_ERROR=""

# Model tiering (spec: nano=enrich, mini=synthesis, 5.1=lint)
case "${SKILL}" in
  enrich-note)  MODEL="${WIKI_MODEL_ENRICH:-gpt-5.4-nano}" ;;
  ingest-inbox) MODEL="${WIKI_MODEL_SYNTH:-gpt-5.4-mini}" ;;
  refresh-moc)  MODEL="${WIKI_MODEL_SYNTH:-gpt-5.4-mini}" ;;
  lint-wiki)    MODEL="${WIKI_MODEL_LINT:-gpt-5.1}" ;;
  *) echo "unknown skill: ${SKILL}" >&2; exit 2 ;;
esac
KUMA_VAR="KUMA_PUSH_WIKI_AGENT_$(echo "${SKILL}" | tr 'a-z-' 'A-Z_')"
"${HOMELAB}/scripts/kuma-push.sh" "${KUMA_VAR}" start "${SKILL} started" || true

# Agent runner. Codex is the default and the only one whose flags are known
# here; any other CLI is driven through WIKI_AGENT_CMD, which receives the
# composed prompt on stdin and runs with the vault as its working directory.
# A custom runner owns its own model selection, sandboxing, and approval mode.
#
# GPT-5.4 nano supports ordinary Codex file/shell tools but not the Responses
# API's tool_search capability. Disable Codex integrations that use deferred
# tool discovery only for nano-backed runs. The enrichment worker needs the
# local shell/file tools, not apps, plugins, agents, or remote discovery.
# Build a non-empty command array. macOS's Bash 3.2 treats expansion of an
# empty array as an unset variable under `set -u`, which used to abort every
# non-nano run before Codex was invoked.
case "${WIKI_AGENT_RUNNER:-codex}" in
  codex)
    AGENT_CMD=(codex --ask-for-approval never)
    case "${MODEL}" in
      *-nano|*-nano-*) AGENT_CMD+=(
        --disable apps
        --disable plugins
        --disable remote_plugin
        --disable tool_suggest
        --disable multi_agent
      ) ;;
    esac
    AGENT_CMD+=(
      -c 'sandbox_workspace_write.network_access=false'
      -c 'web_search="disabled"'
      exec
      -C "${VAULT}"
      --model "${MODEL}"
      --sandbox workspace-write
      --ephemeral
      --skip-git-repo-check
      --json
      -
    )
    ;;
  *)
    read -ra AGENT_CMD <<< "${WIKI_AGENT_CMD:?WIKI_AGENT_CMD is required when WIKI_AGENT_RUNNER is not codex}"
    ;;
esac

fail() { "${HOMELAB}/scripts/kuma-push.sh" "${KUMA_VAR}" down "${SKILL} failed" || true; }
trap fail ERR

case "${SKILL}" in
  enrich-note|ingest-inbox)
    [ "${RUN_MODE}" = "--retry" ] || [ "${RUN_MODE}" = "--source" ] || sleep "${WIKI_SETTLE:-180}"
    ;;
esac

LOCK="${STATE_DIR}/run.lock"
find "${LOCK}" -maxdepth 0 -type d -mmin +120 -exec rmdir {} \; 2>/dev/null || true
TRIES=0
until mkdir "${LOCK}" 2>/dev/null; do
  TRIES=$((TRIES + 1))
  test "${TRIES}" -le 120 || { echo "wiki-agent: lock timeout" >&2; exit 1; }
  sleep 15
done
cleanup() {
  [ -z "${CODEX_JSON}" ] || rm -f "${CODEX_JSON}"
  [ -z "${CODEX_ERROR}" ] || rm -f "${CODEX_ERROR}"
  rmdir "${LOCK}" 2>/dev/null || true
}
trap cleanup EXIT

vgit() { git --git-dir="${WIKI_VAULT_GIT:-${HOMELAB}/config/wiki-vault.git}" --work-tree="${VAULT}" "$@"; }

# ---- work gating ------------------------------------------------------------
pending() {
  if [ -n "${FORCE_SOURCE}" ]; then
    printf '%s\n' "${VAULT}/${FORCE_SOURCE}"
    return
  fi
  case "${SKILL}" in
    enrich-note|ingest-inbox)
      WIKI_GATE_SKILL="${SKILL}" WIKI_GATE_VAULT="${VAULT}" python3 - <<'PY'
import glob, os
vault = os.environ["WIKI_GATE_VAULT"]
skill = os.environ["WIKI_GATE_SKILL"]
if skill == "enrich-note":
    for p in glob.glob(os.path.join(vault, "wiki", "**", "*.md"), recursive=True):
        if "enrichedAt:" not in open(p).read():
            print(p); break
else:
    hits = [p for p in glob.glob(os.path.join(vault, "inbox", "*.md"))
            if os.path.basename(p) != "podcasts.md"]
    hits += [r for r in glob.glob(os.path.join(vault, "system", "raw", "*", "*.md"))
             if not os.path.exists(os.path.join(vault, "wiki", "sources", os.path.basename(r)))]
    if hits: print(hits[0])
PY
      ;;
    refresh-moc|lint-wiki)
      # vault changed since this skill's last run
      HEAD="$(vgit rev-parse HEAD)"
      LAST="$(cat "${STATE_DIR}/${SKILL}.head" 2>/dev/null || true)"
      if [ "${HEAD}" != "${LAST}" ]; then echo "changed since ${LAST:-never}"; fi ;;
  esac
}

WORK="$(pending)"
if [ -z "${WORK}" ]; then
  echo "${SKILL}: nothing pending — no LLM call"
  "${HOMELAB}/scripts/kuma-push.sh" "${KUMA_VAR}" up "idle" || true
  exit 0
fi
echo "${SKILL}: pending work detected (${WORK})"

# ---- run --------------------------------------------------------------------
# Isolated CODEX_HOME: the host's default ~/.codex is logged in with a ChatGPT
# account, which overrides OPENAI_API_KEY and both misbills the runs and
# rejects some models. The wiki agent authenticates with the API key only.
export CODEX_HOME="${HOMELAB}/config/wiki-agent/codex-home"
mkdir -p "${CODEX_HOME}"
export OPENAI_API_KEY="${WIKI_OPENAI_API_KEY:-${KARAKEEP_OPENAI_API_KEY}}"
if [ ! -f "${CODEX_HOME}/auth.json" ]; then
  printf "%s" "${OPENAI_API_KEY}" | codex login --with-api-key
fi

# The prompt is assembled with `cat` inside `set +e` below, so a missing file
# would silently hand the model a truncated prompt — losing the untrusted-content
# defenses while still reporting a successful run.
for required in "${POLICY}" "${SKILLS_DIR}/${SKILL}.md"; do
  [ -s "${required}" ] || {
    echo "wiki-agent: missing or empty prompt file: ${required}" >&2
    fail
    exit 1
  }
done

CODEX_JSON="$(mktemp "${STATE_DIR}/codex-${SKILL}.XXXXXX.jsonl")"
CODEX_ERROR="$(mktemp "${STATE_DIR}/codex-${SKILL}.XXXXXX.error")"
RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
set +e
{
  cat "${POLICY}"
  printf '\n\n---\n\n'
  cat "${SKILLS_DIR}/${SKILL}.md"
  if [ -n "${FORCE_SOURCE}" ]; then
    printf '\n\n--- TRUSTED RUN SCOPE ---\n\n'
    printf 'Reprocess only `%s`. Its raw file is immutable. Audit and improve its existing source page and linked coverage even though they already exist.\n' "${FORCE_SOURCE}"
  fi
} | (cd "${VAULT}" && "${AGENT_CMD[@]}") > "${CODEX_JSON}" 2> "${CODEX_ERROR}"
CODEX_STATUS=$?
set -e
[ ! -s "${CODEX_ERROR}" ] || cat "${CODEX_ERROR}" >&2

if [ "${CODEX_STATUS}" -eq 0 ]; then
  USAGE_STATUS="completed"
else
  USAGE_STATUS="failed"
fi
python3 "${HOMELAB}/scripts/wiki_usage.py" record \
  --kind "${SKILL}" \
  --model "${MODEL}" \
  --json-log "${CODEX_JSON}" \
  --error-log "${CODEX_ERROR}" \
  --status "${USAGE_STATUS}" \
  --run-id "${RUN_ID}"
if [ "${CODEX_STATUS}" -ne 0 ]; then
  fail
  exit "${CODEX_STATUS}"
fi

python3 "${HOMELAB}/scripts/wiki-hierarchy-sync.py"
python3 "${HOMELAB}/scripts/wiki-log-order.py" "${VAULT}/system/log.md"
case "${SKILL}" in
  refresh-moc) python3 "${HOMELAB}/scripts/wiki-graph-settings.py" ;;
esac

# ---- commit + heartbeat -----------------------------------------------------
if ! vgit diff --quiet || [ -n "$(vgit status --porcelain)" ]; then
  vgit add -A
  vgit commit -qm "wiki-agent: ${SKILL} $(date -u +%FT%TZ)"
fi
vgit rev-parse HEAD > "${STATE_DIR}/${SKILL}.head"

"${HOMELAB}/scripts/kuma-push.sh" "${KUMA_VAR}" up "${SKILL} ok" || true
echo "${SKILL}: done"
