#!/usr/bin/env python3
"""Upsert Sonarr's file-level anime import parsing guard connection."""

from __future__ import annotations

import json
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config/sonarr/config.xml"
BASE_URL = "http://127.0.0.1:8989/api/v3"
NAME = "Anime numbered-extra import guard"
CONTAINER_SCRIPT = "/custom-scripts/sonarr-anime-import-guard.sh"


def request(method: str, path: str, key: str, payload: object | None = None) -> object:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"X-Api-Key": key}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read()
    return json.loads(body) if body else {}


def main() -> int:
    key = ET.parse(CONFIG).findtext("ApiKey", "").strip()
    if not key:
        raise RuntimeError("Sonarr API key is missing")

    payload = {
        "name": NAME,
        "implementation": "CustomScript",
        "configContract": "CustomScriptSettings",
        "onGrab": False,
        "onDownload": True,
        "onUpgrade": True,
        "onRename": False,
        "onHealthIssue": False,
        "onApplicationUpdate": False,
        "onManualInteractionRequired": False,
        "onEpisodeFileDelete": False,
        "onSeriesAdd": False,
        "onSeriesDelete": False,
        "onHealthRestored": False,
        "includeHealthWarnings": False,
        "tags": [],
        "fields": [
            {"name": "path", "value": CONTAINER_SCRIPT},
            {"name": "arguments", "value": ""},
        ],
    }

    connections = request("GET", "/notification", key)
    existing = next((item for item in connections if item["name"] == NAME), None)
    if existing:
        payload["id"] = existing["id"]
        result = request("PUT", f"/notification/{existing['id']}", key, payload)
        action = "updated"
    else:
        result = request("POST", "/notification", key, payload)
        action = "created"

    print(f"Sonarr connection {result['id']} {action}: {result['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
