Skill: refresh-moc — maintain the bird's-eye layer (Maps of Content).

1. For each subject tag (a tag used as the FIRST tag of pages) with 3 or
   more pages, ensure
   wiki/mocs/<subject>.md exists and reflects current content:
   - grouped links to the subject's concepts/entities/sources with one-line
     descriptions, ordered by importance. Descriptions state what the page is
     about directly; they never say "the source/article/page says";
   - an "Open threads" section: contradictions noted in pages, plus relevant
     "wanted pages" from system/log.md;
   - a Mermaid mindmap or graph of the subject's core concept relations
     (```mermaid block — Obsidian renders it natively).
2. Update wiki/mocs/home.md: links to all subject MOCs plus the 5 most
   recently changed pages.
3. Prune MOC links to pages that no longer exist.

Do not create MOCs for tags with fewer than 3 pages. Log changes at the end of
the `## runs` section in system/log.md (oldest to newest; never insert directly
below the heading). NEVER create or edit *.canvas files, graph-settings.md,
library.base, or system/schema/colors.json — a deterministic script rebuilds
the visual layer from the vault tree after this run.

Every sentence you produce is wiki prose: the "Writing style — no AI slop"
rules in AGENTS.md apply to summaries, key claims, and page bodies alike.
