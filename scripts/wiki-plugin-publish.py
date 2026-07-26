#!/usr/bin/env python3
"""Publish the tracked Wiki Dashboard bundle as a LiveSync release profile.

LiveSync stores plugin files as base64 text split across content-addressed
leaf documents. Device profiles are snapshots owned by their clients, so writing
to `mac` or `iphone` is immediately undone by those clients' automatic scans.
This publisher instead maintains a dedicated remote-only profile which clients
can apply from the Customization Sync dialog, then reconstructs every file from
CouchDB to verify it byte-for-byte.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from wiki_usage import HOMELAB, load_env


PLUGIN = HOMELAB / "obsidian" / "wiki-dashboard"
FILES = ("main.js", "manifest.json", "styles.css")
PLUGIN_ID = json.loads((PLUGIN / "manifest.json").read_text())["id"]
# A renamed plugin has no profile document under its new id yet; point this at
# the previous id once to donate the document shape.
TEMPLATE_PLUGIN_ID = os.environ.get("WIKI_TEMPLATE_PLUGIN_ID") or PLUGIN_ID
RELEASE_PROFILE = "homelab-release"
TEMPLATE_PROFILE = "mac"
PREFIX = ":CONFIG\u200bmigrated\u200b-\n\n0\n\u200b\n\u200c"
MAX_CHUNK_BYTES = 400


def base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = alphabet[remainder] + result
    return result or "0"


def chunks(text: str) -> list[str]:
    result = []
    current = ""
    size = 0
    for char in text:
        char_size = len(char.encode())
        if current and size + char_size > MAX_CHUNK_BYTES:
            result.append(current)
            current = ""
            size = 0
        current += char
        size += char_size
    current and result.append(current)
    return result


class Couch:
    def __init__(self, env: dict[str, str]):
        self.base = env.get("WIKI_COUCHDB_URL", "http://127.0.0.1:5984").rstrip("/")
        self.db = env.get("WIKI_COUCHDB_DB", "wiki")
        auth = f"{env['COUCHDB_USER']}:{env['COUCHDB_PASSWORD']}".encode()
        self.auth = "Basic " + base64.b64encode(auth).decode()

    def request(self, method: str, doc_id: str, payload: dict | None = None) -> dict:
        encoded = urllib.parse.quote(doc_id, safe="")
        url = f"{self.base}/{self.db}/{encoded}"
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={"Authorization": self.auth, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    def get(self, doc_id: str) -> dict:
        return self.request("GET", doc_id)

    def put(self, doc_id: str, payload: dict) -> dict:
        return self.request("PUT", doc_id, payload)


def leaf_id(data: str) -> str:
    digest = hashlib.sha256(data.encode()).digest()[:12]
    return "h:" + base36(int.from_bytes(digest, "big"))


def publish_leaf(couch: Couch, data: str) -> str:
    doc_id = leaf_id(data)
    payload = {"_id": doc_id, "data": data, "type": "leaf"}
    try:
        couch.put(doc_id, payload)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
        existing = couch.get(doc_id)
        if existing.get("data") != data or existing.get("type") != "leaf":
            raise RuntimeError(f"content-address collision for {doc_id}")
    return doc_id


def decode(couch: Couch, parent: dict) -> bytes:
    packed = "".join(couch.get(child)["data"] for child in parent["children"])
    if not packed.startswith(PREFIX):
        raise RuntimeError(f"unexpected LiveSync payload header for {parent['_id']}")
    encoded = packed[len(PREFIX):]
    return base64.b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4))


def main() -> int:
    couch = Couch(load_env())
    now = int(time.time() * 1000)
    built = {}
    for filename in FILES:
        source = (PLUGIN / filename).read_bytes()
        packed = PREFIX + base64.b64encode(source).decode()
        children = [publish_leaf(couch, chunk) for chunk in chunks(packed)]
        built[filename] = (source, packed, children)

    for filename in FILES:
        doc_id = f"ix:{RELEASE_PROFILE}/plugin_main/{PLUGIN_ID}%{filename}"
        try:
            parent = couch.get(doc_id)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            template_id = (
                f"ix:{TEMPLATE_PROFILE}/plugin_main/{TEMPLATE_PLUGIN_ID}%{filename}"
            )
            template = couch.get(template_id)
            parent = {
                key: value
                for key, value in template.items()
                if key not in {"_id", "_rev"}
            }
            parent["_id"] = doc_id
        source, packed, children = built[filename]
        parent.update(
            {
                "path": (
                    f"ix:{RELEASE_PROFILE}/PLUGIN_MAIN/"
                    f"{PLUGIN_ID}%{filename}"
                ),
                "children": children,
                "mtime": now,
                "size": len(packed.encode()),
                "type": "plain",
                "eden": {},
            }
        )
        couch.put(doc_id, parent)
        remote = couch.get(doc_id)
        if decode(couch, remote) != source:
            raise RuntimeError(f"verification failed for {doc_id}")
        print(
            f"published {RELEASE_PROFILE}/{filename} "
            f"({len(source)} bytes, {len(children)} chunks)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
