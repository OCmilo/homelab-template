#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
CONFIG="$(pwd)/config/adguardhome-host/AdGuardHome.yaml"
PLIST_LABEL="system/com.homelab.adguardhome"

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  PASSWORD="$1"
else
  read -rsp "New AdGuard Home admin password: " PASSWORD
  echo
fi

if [[ -z "$PASSWORD" ]]; then
  echo "Password cannot be empty" >&2
  exit 1
fi

HTPASSWD="$(command -v htpasswd || true)"
if [[ -z "$HTPASSWD" ]]; then
  for candidate in /usr/sbin/htpasswd /usr/bin/htpasswd /usr/local/bin/htpasswd /opt/homebrew/bin/htpasswd; do
    if [[ -x "$candidate" ]]; then
      HTPASSWD="$candidate"
      break
    fi
  done
fi

if [[ -z "$HTPASSWD" ]]; then
  echo "htpasswd not found. Install it with: brew install httpd" >&2
  exit 1
fi

HASH="$($HTPASSWD -nbB admin "$PASSWORD" | sed 's/^admin://')"

# Preserve permissions/ownership.  The config is root-owned because AdGuard runs
# as a LaunchDaemon and binds privileged DNS port 53.
sudo python3 - "$CONFIG" "$HASH" <<'PYCONFIG'
from pathlib import Path
import sys
path = Path(sys.argv[1])
hash_value = sys.argv[2]
lines = path.read_text().splitlines()
out = []
in_users = False
in_admin = False
changed = False
for line in lines:
    stripped = line.strip()
    if stripped == "users:":
        in_users = True
        in_admin = False
        out.append(line)
        continue
    if in_users and stripped.startswith("- name:"):
        in_admin = stripped == "- name: admin"
        out.append(line)
        continue
    if in_users and in_admin and stripped.startswith("password:"):
        indent = line[:len(line)-len(line.lstrip())]
        out.append(f"{indent}password: {hash_value}")
        changed = True
        in_admin = False
        continue
    out.append(line)
if not changed:
    raise SystemExit("Could not find users -> admin -> password in AdGuard config")
path.write_text("\n".join(out) + "\n")
PYCONFIG

# Restart service to load the new password.
sudo launchctl kickstart -k "$PLIST_LABEL"

echo "AdGuard Home admin password updated for user: admin"
