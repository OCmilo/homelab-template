#!/usr/bin/env bash
# Weekly vulnerability/misconfiguration scan for the Docker stack.
#
# Reports are written under config/trivy/ (gitignored, backed up by restic).
# The Trivy container is short-lived; it gets read-only Docker socket access
# only while the scan is running.
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
ENV_FILE="${HOMELAB}/.env"
LOG="${HOMELAB}/config/trivy/trivy.log"
REPORT_ROOT="${HOMELAB}/config/trivy/reports"
CACHE_DIR="${HOMELAB}/config/trivy/cache"

env_var() {
  local name=$1
  local default=${2:-}
  sed -n "s/^${name}=//p" "${ENV_FILE}" 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' | grep . || printf '%s' "${default}"
}

TRIVY_IMAGE="${TRIVY_IMAGE:-$(env_var TRIVY_IMAGE aquasec/trivy:0.72.0)}"
TRIVY_SEVERITY="${TRIVY_SEVERITY:-$(env_var TRIVY_SEVERITY CRITICAL)}"
TRIVY_IGNORE_UNFIXED="${TRIVY_IGNORE_UNFIXED:-$(env_var TRIVY_IGNORE_UNFIXED true)}"
TRIVY_TIMEOUT="${TRIVY_TIMEOUT:-$(env_var TRIVY_TIMEOUT 20m)}"
TRIVY_NOTIFY="${TRIVY_NOTIFY:-$(env_var TRIVY_NOTIFY true)}"
STACK_NAME="${STACK_NAME:-$(env_var STACK_NAME Homelab)}"

mkdir -p "$(dirname "${LOG}")" "${REPORT_ROOT}" "${CACHE_DIR}"
cd "${HOMELAB}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

telegram_send() {
  local text=$1
  local silent=${2:-false}
  local token chat topic
  [ "${TRIVY_NOTIFY}" = "true" ] || return 0
  token="$(env_var TELEGRAM_BOT_TOKEN)"
  chat="$(env_var TELEGRAM_CHAT_ID)"
  topic="$(env_var TELEGRAM_TOPIC_TRIVY 6)"
  [ -n "${token}" ] && [ -n "${chat}" ] || return 0
  curl -s -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    -d chat_id="${chat}" -d message_thread_id="${topic}" \
    -d disable_notification="${silent}" \
    -d text="${text}" \
    >/dev/null 2>&1 || true
}

send_findings_summary() {
  /usr/bin/python3 - "${report_dir}" "${TRIVY_SEVERITY}" "${ENV_FILE}" "${TRIVY_NOTIFY}" <<'PY'
import collections
import html
import json
import os
import pathlib
import re
import time
import sys
import urllib.parse
import urllib.request
import urllib.error

report_dir = pathlib.Path(sys.argv[1])
severity = sys.argv[2]
env_file = pathlib.Path(sys.argv[3])
notify = sys.argv[4] == "true"

env_text = env_file.read_text() if env_file.exists() else ""

def env_var(name, default=""):
    match = re.search(r"^{}=(.+)$".format(re.escape(name)), env_text, re.M)
    return match.group(1).strip().strip('"') if match else default

rows = []
for report in sorted((report_dir / "images").glob("*.json")):
    try:
        payload = json.loads(report.read_text())
    except json.JSONDecodeError:
        continue
    image = payload.get("ArtifactName") or report.stem
    for result in payload.get("Results", []):
        for vuln in result.get("Vulnerabilities", []) or []:
            fixed = vuln.get("FixedVersion") or "-"
            rows.append({
                "image": image,
                "package": vuln.get("PkgName") or "-",
                "severity": vuln.get("Severity") or "-",
                "installed": vuln.get("InstalledVersion") or "-",
                "fixed": fixed,
                "id": vuln.get("VulnerabilityID") or "-",
            })

def rows_from_report(path):
    path = pathlib.Path(path)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return []
    image = payload.get("ArtifactName") or path.stem
    found = []
    for result in payload.get("Results", []):
        for vuln in result.get("Vulnerabilities", []) or []:
            found.append({
                "image": image,
                "package": vuln.get("PkgName") or "-",
                "severity": vuln.get("Severity") or "-",
                "installed": vuln.get("InstalledVersion") or "-",
                "fixed": vuln.get("FixedVersion") or "-",
                "id": vuln.get("VulnerabilityID") or "-",
            })
    return found

def package_group_count(vuln_rows):
    return len({
        (row["package"], row["severity"], row["installed"], row["fixed"])
        for row in vuln_rows
    })

rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "UNKNOWN": 4}
rows.sort(key=lambda r: (
    rank.get(r["severity"], 9),
    r["image"],
    r["package"],
    r["id"],
))

images = collections.OrderedDict()
for row in rows:
    images.setdefault(row["image"], []).append(row)

def short_image_name(image):
    tail = image.split("/")[-1]
    if "@sha256:" in tail:
        name, digest = tail.split("@sha256:", 1)
        return "{}@sha256:{}".format(name, digest[:12])
    return tail

grouped = []
for image, image_rows in images.items():
    groups = collections.defaultdict(list)
    for row in image_rows:
        key = (row["package"], row["severity"], row["installed"], row["fixed"])
        groups[key].append(row["id"])
    group_rows = []
    for (package, sev, installed, fixed), ids in groups.items():
        group_rows.append({
            "package": package,
            "severity": sev,
            "installed": installed,
            "fixed": fixed,
            "cve_count": len(ids),
            "sample_cves": sorted(ids)[:3],
        })
    group_rows.sort(key=lambda r: (-r["cve_count"], r["package"], r["fixed"]))
    grouped.append({
        "image": image,
        "short_image": short_image_name(image),
        "vulnerability_count": len(image_rows),
        "package_group_count": len(group_rows),
        "packages": group_rows,
    })

def text_line(value):
    return str(value).replace("\n", " ").strip()

report_lines = []
for image in grouped:
    report_lines.append("{} ({})".format(image["short_image"], image["image"]))
    report_lines.append("  package fix groups: {}".format(image["package_group_count"]))
    for pkg in image["packages"]:
        report_lines.append("  - {package}".format(package=text_line(pkg["package"])))
        report_lines.append("    severity: {severity}".format(severity=pkg["severity"]))
        report_lines.append("    installed: {installed}".format(installed=text_line(pkg["installed"])))
        report_lines.append("    fixed: {fixed}".format(fixed=text_line(pkg["fixed"])))
    report_lines.append("")

(report_dir / "findings-by-image.txt").write_text("\n".join(report_lines).rstrip() + "\n")
(report_dir / "findings.json").write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")
(report_dir / "findings-by-image.json").write_text(json.dumps(grouped, indent=2, sort_keys=True) + "\n")

current_by_image = {image["image"]: image for image in grouped}
current_rows_by_image = collections.defaultdict(list)
for row in rows:
    current_rows_by_image[row["image"]].append(row)

actionable = []
candidate_map = report_dir / "candidate-scans.tsv"
if candidate_map.exists():
    for line in candidate_map.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) != 5:
            continue
        current, kind, candidate, status, path = parts
        current_group = current_by_image.get(current)
        if not current_group:
            continue
        current_groups = current_group["package_group_count"]
        if status == "clean":
            candidate_groups = 0
            candidate_rows = []
        elif status == "findings":
            candidate_rows = rows_from_report(path)
            candidate_groups = package_group_count(candidate_rows)
        else:
            continue
        if candidate_groups != 0:
            continue
        actionable.append({
            "image": current,
            "short_image": current_group["short_image"],
            "kind": kind,
            "candidate": candidate,
            "candidate_short": short_image_name(candidate),
            "current_package_groups": current_groups,
            "candidate_package_groups": candidate_groups,
            "current_vulnerability_rows": len(current_rows_by_image[current]),
            "candidate_vulnerability_rows": len(candidate_rows),
            "packages": current_group["packages"],
        })

actionable.sort(key=lambda item: (
    item["candidate_package_groups"],
    item["current_package_groups"],
    item["short_image"],
))

action_lines = []
for item in actionable:
    action_lines.append("{} -> {}".format(item["short_image"], item["candidate_short"]))
    action_lines.append("  action: {}".format(
        "repull same tag" if item["kind"] == "same-tag" else "evaluate/bump image tag"))
    action_lines.append("  candidate: {}".format(item["candidate"]))
    action_lines.append("  package fix groups: {} -> 0".format(
        item["current_package_groups"]))
    for pkg in item["packages"][:5]:
        action_lines.append("  - {package}".format(package=text_line(pkg["package"])))
        action_lines.append("    severity: {severity}".format(severity=pkg["severity"]))
        action_lines.append("    installed: {installed}".format(installed=text_line(pkg["installed"])))
        action_lines.append("    fixed: {fixed}".format(fixed=text_line(pkg["fixed"])))
    remaining = item["current_package_groups"] - min(5, len(item["packages"]))
    if remaining > 0:
        action_lines.append("    plus {} more package fix group(s)".format(remaining))
    action_lines.append("")

(report_dir / "actionable-upgrades.txt").write_text("\n".join(action_lines).rstrip() + "\n")
(report_dir / "actionable-upgrades.json").write_text(json.dumps(actionable, indent=2, sort_keys=True) + "\n")

if not notify:
    sys.exit(0)

token = env_var("TELEGRAM_BOT_TOKEN")
chat = env_var("TELEGRAM_CHAT_ID")
topic = env_var("TELEGRAM_TOPIC_TRIVY", "6")
if not token or not chat:
    sys.exit(0)

def post_message(text, parse_mode="HTML", silent=False, attempts=4):
    data = {
        "chat_id": chat,
        "message_thread_id": topic,
        "disable_notification": "true" if silent else "false",
        "text": text,
    }
    if parse_mode:
        data["parse_mode"] = parse_mode
    encoded = urllib.parse.urlencode(data).encode()
    url = "https://api.telegram.org/bot{}/sendMessage".format(token)
    for attempt in range(attempts):
        try:
            urllib.request.urlopen(url, data=encoded, timeout=15)
            return
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < attempts - 1:
                try:
                    payload = json.loads(exc.read().decode())
                    retry_after = int(payload.get("parameters", {}).get("retry_after", 3))
                except Exception:
                    retry_after = 3
                time.sleep(retry_after + 1)
                continue
            raise
    raise RuntimeError("Telegram send failed after retries")

if not rows:
    text = "{} Trivy scan found no {} vulnerabilities.\nReport: {}".format(
        env_var("STACK_NAME", "Homelab"), severity, report_dir / "summary.txt")
    post_message(html.escape(text), silent=True)
    sys.exit(0)

if not actionable:
    sys.exit(0)

messages = []
header = (
    "<b>Trivy actionable image updates</b>\n"
    "{count} candidate image update(s) clear current {severity} findings.\n"
    "Showing only images where a repull/upgrade candidate scans clean for this policy.\n"
    "Full report: <code>{report}</code>"
).format(
    severity=html.escape(severity),
    count=len(actionable),
    report=html.escape(str(report_dir / "actionable-upgrades.txt")),
)
messages.append(header)

current = []
current_len = 0
max_len = 3400
for item in actionable:
    lines = [
        "<b>{}</b>".format(html.escape(item["short_image"])),
        "Candidate: <code>{}</code>".format(html.escape(item["candidate"])),
        "Action: {}".format(
            "repull same tag" if item["kind"] == "same-tag" else "evaluate/bump image tag"),
        "Package fix groups: <code>{} -> 0</code>".format(
            item["current_package_groups"]),
    ]
    for pkg in item["packages"][:3]:
        lines.extend([
            "- <b>{}</b>".format(html.escape(text_line(pkg["package"]))),
            "  Severity: <code>{}</code>".format(html.escape(pkg["severity"])),
            "  Installed: <code>{}</code>".format(html.escape(text_line(pkg["installed"]))),
            "  Fixed: <code>{}</code>".format(html.escape(text_line(pkg["fixed"]))),
        ])
    remaining = item["current_package_groups"] - min(3, len(item["packages"]))
    if remaining > 0:
        lines.append("  Plus {} more package fix group(s) in the report".format(remaining))
    block = "\n".join(lines)
    projected = current_len + len(block) + 2
    if current and projected > max_len:
        messages.append("\n\n".join(current))
        current = []
        current_len = 0
    current.append(block)
    current_len += len(block) + 2
if current:
    messages.append("\n\n".join(current))

for message in messages:
    post_message(message)
    time.sleep(1.2)
PY
}

fail() {
  local message=$1
  echo "$(timestamp) trivy scan FAILED: ${message}" | tee -a "${LOG}" >&2
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_TRIVY down "${message}"
  telegram_send "${STACK_NAME} Trivy scan FAILED: ${message}. See config/trivy/trivy.log"
  exit 1
}

"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_TRIVY start "trivy scan started"

sanitize() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

candidate_latest_ref() {
  local image_ref=$1
  local repo=${image_ref%@*}
  repo=${repo%:*}
  [ "${repo}" != "${image_ref}" ] || return 1
  printf '%s:latest' "${repo}"
}

image_is_local_build() {
  grep -Fqx "$1" "${local_build_images}"
}

scan_candidate() {
  local current_ref=$1
  local candidate_ref=$2
  local kind=$3
  local safe_current safe_candidate output rc
  safe_current="$(sanitize "${current_ref}")"
  safe_candidate="$(sanitize "${candidate_ref}")"
  output="${report_dir}/candidates/${safe_current}__${kind}__${safe_candidate}.json"

  if docker run --rm \
      -v "${CACHE_DIR}:/root/.cache/trivy" \
      -v "${report_dir}/candidates:/reports" \
      "${TRIVY_IMAGE}" image \
        --quiet \
        --skip-version-check \
        --disable-telemetry \
        --cache-dir /root/.cache/trivy \
        --timeout "${TRIVY_TIMEOUT}" \
        --image-src remote \
        --scanners vuln \
        --severity "${TRIVY_SEVERITY}" \
        "${ignore_unfixed_arg[@]}" \
        --exit-code 1 \
        --format json \
        --output "/reports/$(basename "${output}")" \
        "${candidate_ref}" >> "${LOG}" 2>&1; then
    printf '%s\t%s\t%s\tclean\t%s\n' "${current_ref}" "${kind}" "${candidate_ref}" "${output}" >> "${candidate_map}"
  else
    rc=$?
    if [ "${rc}" -eq 1 ] && [ -s "${output}" ]; then
      printf '%s\t%s\t%s\tfindings\t%s\n' "${current_ref}" "${kind}" "${candidate_ref}" "${output}" >> "${candidate_map}"
    else
      candidate_scan_errors=1
      printf '%s\t%s\t%s\terror\t%s\n' "${current_ref}" "${kind}" "${candidate_ref}" "${output}" >> "${candidate_map}"
      echo "Candidate scan ERROR ${candidate_ref} (trivy exit ${rc}; report: ${output})" >> "${summary}"
    fi
  fi
}

ignore_unfixed_arg=()
if [ "${TRIVY_IGNORE_UNFIXED}" = "true" ]; then
  ignore_unfixed_arg=(--ignore-unfixed)
fi

run_id="$(date '+%Y%m%d-%H%M%S')"
report_dir="${REPORT_ROOT}/${run_id}"
mkdir -p "${report_dir}/images"
mkdir -p "${report_dir}/candidates"

image_list="${report_dir}/compose-images.txt"
docker compose config --images | sort -u > "${image_list}" || fail "could not list compose images"
[ -s "${image_list}" ] || fail "compose image list was empty"

local_build_images="${report_dir}/compose-local-build-images.txt"
docker compose config --format json |
  jq -r '.services[] | select(.build != null) | .image' | sort -u > "${local_build_images}" ||
  fail "could not list Compose-built images"

{
  echo "$(timestamp) trivy scan start: ${run_id}"
  echo "trivy image: ${TRIVY_IMAGE}"
  echo "severity: ${TRIVY_SEVERITY}; ignore_unfixed: ${TRIVY_IGNORE_UNFIXED}"
} >> "${LOG}"

summary="${report_dir}/summary.txt"
candidate_map="${report_dir}/candidate-scans.tsv"
: > "${candidate_map}"
{
  echo "${STACK_NAME} Trivy scan ${run_id}"
  echo "Severity: ${TRIVY_SEVERITY}"
  echo "Ignore unfixed: ${TRIVY_IGNORE_UNFIXED}"
  echo
  echo "Images:"
} > "${summary}"

findings=0
scan_errors=0
candidate_scan_errors=0
image_count=0

while IFS= read -r image_ref; do
  [ -n "${image_ref}" ] || continue
  image_count=$((image_count + 1))
  safe_name="$(sanitize "${image_ref}")"
  output="${report_dir}/images/${safe_name}.json"

  if docker run --rm \
      -v "${CACHE_DIR}:/root/.cache/trivy" \
      -v /var/run/docker.sock:/var/run/docker.sock:ro \
      -v "${report_dir}/images:/reports" \
      "${TRIVY_IMAGE}" image \
        --quiet \
        --skip-version-check \
        --disable-telemetry \
        --cache-dir /root/.cache/trivy \
        --timeout "${TRIVY_TIMEOUT}" \
        --image-src docker \
        --scanners vuln \
        --severity "${TRIVY_SEVERITY}" \
        "${ignore_unfixed_arg[@]}" \
        --exit-code 1 \
        --format json \
        --output "/reports/${safe_name}.json" \
        "${image_ref}" >> "${LOG}" 2>&1; then
    echo "OK   ${image_ref}" >> "${summary}"
  else
    rc=$?
    findings=1
    if [ "${rc}" -ne 1 ] || [ ! -s "${output}" ]; then
      scan_errors=1
    fi
    echo "FAIL ${image_ref} (trivy exit ${rc}; report: ${output})" >> "${summary}"
    if ! image_is_local_build "${image_ref}"; then
      scan_candidate "${image_ref}" "${image_ref}" "same-tag"
      latest_ref="$(candidate_latest_ref "${image_ref}" || true)"
      if [ -n "${latest_ref}" ] && [ "${latest_ref}" != "${image_ref}" ]; then
        scan_candidate "${image_ref}" "${latest_ref}" "latest"
      fi
    else
      echo "SKIP remote candidate scans for Compose-built image ${image_ref}" >> "${summary}"
    fi
  fi
done < "${image_list}"

config_report="${report_dir}/config-misconfig.json"
echo >> "${summary}"
if docker run --rm \
    -v "${CACHE_DIR}:/root/.cache/trivy" \
    -v "${HOMELAB}:/repo:ro" \
    -v "${report_dir}:/reports" \
    "${TRIVY_IMAGE}" config \
      --quiet \
      --skip-version-check \
      --disable-telemetry \
      --cache-dir /root/.cache/trivy \
      --timeout "${TRIVY_TIMEOUT}" \
      --severity "${TRIVY_SEVERITY}" \
      --skip-dirs /repo/config \
      --skip-dirs /repo/cache \
      --skip-dirs /repo/backups \
      --skip-dirs /repo/bin \
      --skip-files /repo/.env \
      --exit-code 1 \
      --format json \
      --output /reports/config-misconfig.json \
      /repo >> "${LOG}" 2>&1; then
  echo "Config: OK" >> "${summary}"
else
  rc=$?
  findings=1
  if [ "${rc}" -ne 1 ] || [ ! -s "${config_report}" ]; then
    scan_errors=1
  fi
  echo "Config: FAIL (trivy exit ${rc}; report: ${config_report})" >> "${summary}"
fi

ln -sfn "${report_dir}" "${REPORT_ROOT}/latest"

if [ "${scan_errors}" -ne 0 ] || [ "${candidate_scan_errors}" -ne 0 ]; then
  tail -n 20 "${summary}" >> "${LOG}"
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_TRIVY down "scan errors"
  telegram_send "${STACK_NAME} Trivy scan had scan errors. See ${summary}"
  exit 2
fi

if [ "${findings}" -ne 0 ]; then
  tail -n 20 "${summary}" >> "${LOG}"
  send_findings_summary ||
    echo "$(timestamp) WARNING: trivy findings summary notification failed" >> "${LOG}"
  "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_TRIVY up "scan completed with findings"
  exit 1
fi

echo "$(timestamp) trivy scan ok: ${image_count} images; report ${summary}" >> "${LOG}"
send_findings_summary ||
  echo "$(timestamp) WARNING: trivy clean-scan notification failed" >> "${LOG}"
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_TRIVY up "scan clean: ${image_count} images"
