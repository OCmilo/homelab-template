#!/usr/bin/env bash
# Derive the NordVPN WireGuard (NordLynx) private key from a NordVPN access token
# and write it into ~/homelab/.env. Token is read hidden and never stored.
# Get a token at: Nord Account -> NordVPN -> "Set up NordVPN manually" -> generate token.
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

read -rsp "NordVPN access token: " TOKEN
echo

KEY="$(curl -fsS -u "token:${TOKEN}" \
  https://api.nordvpn.com/v1/users/services/credentials \
  | grep -o '"nordlynx_private_key":"[^"]*"' | cut -d'"' -f4)"

if [ -z "${KEY}" ]; then
  echo "FAILED: no key returned — token wrong, expired, or no active NordVPN subscription." >&2
  exit 1
fi

if grep -q '^NORDVPN_PRIVATE_KEY=' "${ENV_FILE}"; then
  sed -i '' "s#^NORDVPN_PRIVATE_KEY=.*#NORDVPN_PRIVATE_KEY=${KEY}#" "${ENV_FILE}"
else
  printf '\nNORDVPN_PRIVATE_KEY=%s\n' "${KEY}" >> "${ENV_FILE}"
fi

echo "OK: WireGuard key written to .env (${#KEY} chars)."
