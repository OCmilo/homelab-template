#!/usr/bin/env python3
"""Regenerate harness vault-data.js from a real vault.

Usage: regen-vault-data.py [vault-path]
Defaults to $WIKI_VAULT, then the server's config/wiki-vault. The output feeds
harness.html, which stubs the Obsidian API for browser-based plugin work.
"""
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_VAULT = Path.home() / "homelab" / "config" / "wiki-vault"
VAULT = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WIKI_VAULT", DEFAULT_VAULT))
OUT = Path(__file__).resolve().parent / "vault-data.js"

data = {}
for file in sorted((VAULT / "wiki").rglob("*.md")):
    rel = file.relative_to(VAULT).as_posix()
    text = file.read_text()
    links = sorted({f"{m}.md" for m in re.findall(r"\[\[(wiki/[^\]|#]+)", text)})
    front = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    tags = []
    if front:
        tag_match = re.search(r"^tags:\s*\[([^\]]*)\]", front.group(1), re.M)
        tags = [t.strip() for t in tag_match.group(1).split(",")] if tag_match else []
    data[rel] = {"basename": file.stem, "links": links, "subjects": tags}

OUT.write_text("const VAULT_DATA = " + json.dumps(data, indent=1) + ";\n")
print(f"{len(data)} pages -> {OUT}")
