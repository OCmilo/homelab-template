#!/usr/bin/env python3
"""Rebuild graph-settings.md and the stable tag palette from the vault tree. No LLM.

Tags are flat; a page's PRIMARY subject is its first tag. Colors are stable:
system/schema/colors.json maps each subject to a palette slot ("1".."6") on
first sight and never reassigns. Canvas boards were removed 2026-07-17 by user
verdict — any stray *.canvas under wiki/mocs is pruned here.
"""
import json
import os
import re
from pathlib import Path

VAULT = Path(os.environ.get("WIKI_VAULT", str(Path.home() / "homelab" / "config" / "wiki-vault")))
MOCS = VAULT / "wiki" / "mocs"
COLORS_FILE = VAULT / "system" / "schema" / "colors.json"
COLOR_NAMES = {"1": "nebula pink #ff6b9d", "2": "solar amber #ffa657", "3": "starlight gold #e3c567", "4": "aurora mint #3ddbb4", "5": "ion blue #4cc9f0", "6": "nebula violet #a78bfa"}


def frontmatter_tags(text):
    found = re.search(r"^tags:\s*\[([^\]]*)\]", text, re.M)
    raw = found.group(1) if found else ""
    return [tag.strip() for tag in raw.split(",") if tag.strip()]


def read_pages(folder):
    return [(page, page.read_text()) for page in sorted((VAULT / "wiki" / folder).glob("*.md"))]


def assign_colors(subjects):
    colors = json.loads(COLORS_FILE.read_text()) if COLORS_FILE.exists() else {}
    free = [c for c in COLOR_NAMES if c not in colors.values()]
    missing = [s for s in subjects if s not in colors]
    colors.update(zip(missing, free + list(COLOR_NAMES) * 3))
    COLORS_FILE.write_text(json.dumps(colors, indent=2, sort_keys=True) + "\n")
    return colors


def write_if_changed(path, content):
    unchanged = path.exists() and path.read_text() == content
    path.write_text(content)
    return None if unchanged else path.name


def graph_settings(subjects, colors):
    groups = "\n".join(f"- `tag:#{s}` -> {COLOR_NAMES[colors[s]]}" for s in subjects)
    return f"""---
type: moc
tags: []
created: 2026-07-16
enrichedAt: 2026-07-17T00:00:00Z
status: auto
sources: []
---
# Graph Settings

Script-generated (scripts/wiki-graph-settings.py) from system/schema/colors.json —
same palette as the Wiki Dashboard plugin. One-time setup per device,
Graph view -> gear:

1. Filters -> paste into the search box (shows only wiki pages, no
   system/inbox machinery):

   `path:wiki`

2. Groups -> add each query below with its color:

{groups}

## Extended Graph — prettier native graph (desktop only)

Optional, Mac only (plugin is desktop-only): install "Extended Graph" to get
tag arcs, node shapes, and saved graph states on top of the core Graph view.

## LiveSync customization sync — stop repeating this setup

Optional: makes plugin installs/settings propagate through CouchDB so new
devices skip manual installs. The pane is HIDDEN by default. On EACH device,
in Self-hosted LiveSync settings:

1. "Setup" tab -> "Enable extra and advanced features" -> turn on
   "Enable advanced features" (reveals the "Customisation sync" tab).
2. "Customisation sync" tab -> set a unique "Device name" (mac, iphone, ...),
   then enable "Enable customisation sync" and "Scan customisation
   automatically".
3. Publish from a fully set-up device via the Customization sync dialog
   (ribbon icon / command palette), then Apply on the others. Skip
   desktop-only plugins (extended-graph) and workspace/app config on phones.
"""


def primary_subject(text):
    tags = frontmatter_tags(text)
    return tags[0].split("/")[0] if tags else None


def main():
    concepts = read_pages("concepts")
    sources = read_pages("sources")
    subjects = sorted({s for _, t in concepts + sources if (s := primary_subject(t))})
    colors = assign_colors(subjects)
    written = write_if_changed(MOCS / "graph-settings.md", graph_settings(subjects, colors))
    pruned = sorted(MOCS.glob("*.canvas"))
    [canvas.unlink() for canvas in pruned]
    print("updated:", [written] if written else "nothing", "| pruned:", [canvas.name for canvas in pruned] or "-")


main()
