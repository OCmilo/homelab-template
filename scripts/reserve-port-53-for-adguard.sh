#!/usr/bin/env bash
set -euo pipefail

LIMA_YAML="$HOME/.colima/_lima/colima/lima.yaml"

if [[ ! -f "$LIMA_YAML" ]]; then
  echo "Colima Lima config not found at $LIMA_YAML" >&2
  exit 1
fi

python3 - "$LIMA_YAML" <<PY
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
marker = "portForwards:\n"
ignore = """portForwards:
    # Homelab: do not forward the VM internal dnsmasq port 53 to macOS.
    # This leaves host/LAN port 53 available for native AdGuard Home.
    - guestIP: 0.0.0.0
      guestPort: 53
      hostIP: 0.0.0.0
      hostPort: 53
      proto: any
      ignore: true
    - guestIP: 127.0.0.1
      guestPort: 53
      hostIP: 127.0.0.1
      hostPort: 53
      proto: any
      ignore: true
"""
if "do not forward the VM internal dnsmasq port 53" not in s:
    if marker not in s:
        raise SystemExit("portForwards marker not found")
    s = s.replace(marker, ignore, 1)
    p.write_text(s)
    print(f"patched {p}")
else:
    print(f"already patched {p}")
PY

if lsof -nP -iTCP:53 -iUDP:53 2>/dev/null | grep -q limactl; then
  echo "Port 53 is still held by limactl. Run: colima stop && colima start && cd ~/homelab && docker compose up -d"
else
  echo "Port 53 is free for AdGuard Home."
fi
