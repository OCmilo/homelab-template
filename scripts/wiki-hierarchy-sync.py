#!/usr/bin/env python3
"""Script-owned `up:` frontmatter for the note hierarchy (docs/wiki-system.md).

concepts/entities -> subject MOCs, subject MOCs -> home, sources -> citing pages
(fallback: subject MOCs when nothing cites them yet). Idempotent: only the `up:`
line is ever touched; agents must never write it (AGENTS.md hard rule).
"""

import os
import re
from pathlib import Path

VAULT = Path(os.environ.get("WIKI_VAULT", str(Path.home() / "homelab" / "config" / "wiki-vault")))
WIKI = VAULT / "wiki"
MOCS = WIKI / "mocs"


def frontmatter_tags(text):
    match = re.search(r"^tags:\s*\[([^\]]*)\]", text, re.M)
    tags = match.group(1).split(",") if match else []
    return [tag.strip() for tag in tags if tag.strip()]


def moc_link(slug):
    return f'"[[wiki/mocs/{slug}|{slug}]]"'


def page_link(page):
    rel = page.relative_to(VAULT).with_suffix("")
    return f'"[[{rel}|{page.stem}]]"'


def subject_mocs(text, moc_slugs):
    tags = frontmatter_tags(text)
    subjects = [tags[0].split("/")[0]] if tags else []
    return [moc_link(subject) for subject in subjects if subject in moc_slugs]


def set_up(page, links):
    text = page.read_text()
    stripped = re.sub(r"^up: .*\n", "", text, count=1, flags=re.M)
    line = f"up: [{', '.join(links)}]\n" if links else ""
    updated = re.sub(r"^(type: [^\n]*\n)", lambda m: m.group(1) + line,
                     stripped, count=1, flags=re.M)
    changed = updated != text
    changed and page.write_text(updated)
    return changed


def main():
    moc_slugs = {page.stem for page in MOCS.glob("*.md")} - {"graph-settings"}
    citers = (
        sorted((WIKI / "concepts").glob("*.md"))
        + sorted((WIKI / "entities").glob("*.md"))
        + sorted((WIKI / "synthesis").glob("*.md"))
    )
    subject_pages = [page for page in sorted(MOCS.glob("*.md"))
                     if page.stem not in {"graph-settings", "home"}]
    sources = sorted((WIKI / "sources").glob("*.md"))

    def citing(source_stem):
        needle = f"[[wiki/sources/{source_stem}"
        return [page for page in citers if needle in page.read_text()]

    changed = (
        [page.name for page in citers
         if set_up(page, subject_mocs(page.read_text(), moc_slugs))]
        + [page.name for page in subject_pages if set_up(page, [moc_link("home")])]
        + [page.name for page in sources
           if set_up(page, [page_link(citer) for citer in citing(page.stem)]
                     or subject_mocs(page.read_text(), moc_slugs))]
    )
    print("up-sync updated:", changed or "nothing")


main()
