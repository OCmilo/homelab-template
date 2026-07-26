#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BIN="$ROOT/bin/AdGuardHome"
WORK_DIR="$ROOT/config/adguardhome-host"
CONFIG="$WORK_DIR/AdGuardHome.yaml"
PLIST="/Library/LaunchDaemons/com.homelab.adguardhome.plist"
OLD_PLIST="/Library/LaunchDaemons/AdGuardHome.plist"

if [[ ! -x "$BIN" ]]; then
  echo "Missing $BIN. Download AdGuardHome_darwin_amd64.zip from AdGuardTeam/AdGuardHome releases first." >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

sudo "$BIN" -w "$WORK_DIR" -c "$CONFIG" --check-config

# Remove the upstream installer plist if a previous attempt created it.  On macOS
# it can fail with launchctl error 5 when installed from outside /Applications.
if [[ -f "$OLD_PLIST" ]]; then
  sudo launchctl bootout system "$OLD_PLIST" 2>/dev/null || true
  sudo rm -f "$OLD_PLIST"
fi

sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo tee "$PLIST" >/dev/null <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.homelab.adguardhome</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>-w</string>
    <string>$WORK_DIR</string>
    <string>-c</string>
    <string>$CONFIG</string>
    <string>--web-addr</string>
    <string>0.0.0.0:8081</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$WORK_DIR/AdGuardHome.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$WORK_DIR/AdGuardHome.stderr.log</string>
</dict>
</plist>
PLIST_EOF

sudo chown root:wheel "$PLIST"
sudo chmod 644 "$PLIST"
sudo launchctl bootstrap system "$PLIST"
sudo launchctl enable system/com.homelab.adguardhome
sudo launchctl kickstart -k system/com.homelab.adguardhome

printf "AdGuard Home should be available at: http://<this-host-lan-ip>:8081\n"
printf "Admin password file: %s\n" "$WORK_DIR/admin-password.txt"
