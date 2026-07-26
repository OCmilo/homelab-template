#!/usr/bin/env python3
"""Configure Radarr/Sonarr to avoid oversized, hard-to-stream releases."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

SERVICES = {
    "radarr": {
        "config": ROOT / "config/radarr/config.xml",
        "url": "http://127.0.0.1:7878",
        "profile_id": 5,
        "cutoff": 1003,
        "allowed_quality_ids": {3, 4, 5, 6, 7, 9, 14, 15, 16, 17, 18, 19},
        "size_caps": {
            4: (0, 25, 12),
            5: (0, 25, 12),
            6: (0, 25, 12),
            14: (0, 25, 12),
            3: (0, 45, 24),
            7: (0, 45, 24),
            9: (0, 45, 24),
            15: (0, 45, 24),
            16: (0, 80, 45),
            17: (0, 80, 45),
            18: (0, 80, 45),
            19: (0, 80, 45),
            30: (0, 55, 30),
            31: (0, 110, 60),
        },
    },
    "sonarr": {
        "config": ROOT / "config/sonarr/config.xml",
        "url": "http://127.0.0.1:8989",
        "profile_id": 5,
        "cutoff": 1003,
        "allowed_quality_ids": {3, 4, 5, 6, 7, 9, 14, 15, 16, 17, 18, 19},
        "size_caps": {
            4: (2, 25, 12),
            5: (2, 25, 12),
            6: (2, 25, 12),
            14: (2, 25, 12),
            3: (2, 45, 24),
            7: (2, 45, 24),
            9: (2, 45, 24),
            15: (2, 45, 24),
            16: (2, 80, 45),
            17: (2, 80, 45),
            18: (2, 80, 45),
            19: (2, 80, 45),
            20: (2, 55, 30),
            21: (2, 110, 60),
        },
    },
}

PROFILE_NAME = "UHD -> 1080p -> 720p (4K capped)"
REJECT_FORMATS = {
    "3D",
    "BR-DISK",
    "Extras",
    "LQ",
    "LQ (Release Title)",
    "Reject Dolby Vision without HDR10 fallback",
    "Reject dubbed releases",
    "Reject hardcoded subtitles",
}
FORMAT_SCORES = {
    "Prefer HEVC/x265": 100,
    "Prefer HDR10/HDR10+": 50,
    "Prefer Surround/Atmos": 20,
    "Repack/Proper": 5,
    "Repack2": 6,
    "Repack3": 7,
    "WEB Tier 01": 15,
    "WEB Tier 02": 10,
    "WEB Tier 03": 5,
}


def api_key(path: Path) -> str:
    return ET.parse(path).findtext("ApiKey", "").strip()


def request(method: str, url: str, key: str, payload: object | None = None) -> object:
    data = None
    headers = {"X-Api-Key": key}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {exc.code}: {detail}") from exc

    if not body:
        return {}
    return json.loads(body)


def set_allowed(item: dict, allowed_quality_ids: set[int]) -> bool:
    if item.get("items"):
        allowed = False
        for child in item["items"]:
            allowed = set_allowed(child, allowed_quality_ids) or allowed
        item["allowed"] = allowed
        return allowed

    quality_id = item.get("quality", {}).get("id")
    allowed = quality_id in allowed_quality_ids
    item["allowed"] = allowed
    return allowed


def configure_quality_definitions(service: str, cfg: dict, key: str) -> list[str]:
    definitions = request("GET", f"{cfg['url']}/api/v3/qualitydefinition", key)
    changed = []
    for definition in definitions:
        quality_id = definition["quality"]["id"]
        if quality_id not in cfg["size_caps"]:
            continue

        min_size, max_size, preferred_size = cfg["size_caps"][quality_id]
        definition["minSize"] = min_size
        definition["maxSize"] = max_size
        definition["preferredSize"] = preferred_size
        request(
            "PUT",
            f"{cfg['url']}/api/v3/qualitydefinition/{definition['id']}",
            key,
            definition,
        )
        changed.append(definition["title"])

    return changed


def configure_profile(service: str, cfg: dict, key: str) -> dict:
    profile = request(
        "GET",
        f"{cfg['url']}/api/v3/qualityprofile/{cfg['profile_id']}",
        key,
    )

    profile["name"] = PROFILE_NAME
    profile["upgradeAllowed"] = True
    profile["cutoff"] = cfg["cutoff"]
    profile["minFormatScore"] = 0
    profile["cutoffFormatScore"] = 0
    profile["minUpgradeFormatScore"] = 1

    for item in profile["items"]:
        set_allowed(item, cfg["allowed_quality_ids"])

    for item in profile.get("formatItems", []):
        name = item.get("name")
        if name in REJECT_FORMATS:
            item["score"] = -10000
        elif name in FORMAT_SCORES:
            item["score"] = FORMAT_SCORES[name]

    return request(
        "PUT",
        f"{cfg['url']}/api/v3/qualityprofile/{cfg['profile_id']}",
        key,
        profile,
    )


def main() -> int:
    for service, cfg in SERVICES.items():
        key = api_key(cfg["config"])
        if not key:
            print(f"{service}: missing API key", file=sys.stderr)
            return 1

        changed_defs = configure_quality_definitions(service, cfg, key)
        profile = configure_profile(service, cfg, key)
        print(
            f"{service}: profile {profile['id']} is '{profile['name']}', "
            f"cutoff={profile['cutoff']}, size caps updated for {len(changed_defs)} qualities"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
