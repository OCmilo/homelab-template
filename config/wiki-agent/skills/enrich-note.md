Skill: enrich-note.

Find notes under wiki/ missing `enrichedAt` frontmatter. Ignore inbox/ (that
is ingest's job), system/raw/ (immutable), and any file named podcasts.md. For each
pending note, one at a time:

1. Tags: assign 1–4 tags, preferring existing entries in system/schema/tags.md. New
   tags only via the adversarial rules in AGENTS.md (argue against creating
   it first; if created, add a registry entry with a one-line definition and a
   system/log.md justification).
2. Backlinks: search the vault for 2–5 genuinely related existing pages; add
   or extend a "Related" section with wikilinks. Verified-exists rule applies:
   never link to a page you have not confirmed exists.
3. Frontmatter: complete missing fields per system/schema/conventions.md.
4. For concept and entity pages, ensure a `## Personal notes` heading exists
   immediately before `## Related`. If it already exists, do not edit, move,
   summarize, cite, or delete anything beneath it.
5. Stamp `enrichedAt` with the current UTC time (ISO 8601).

Do not rewrite body prose. Do not create new pages. Log each note processed at
the end of the `## runs` section in system/log.md (oldest to newest; never
insert directly below the heading). If there is nothing to do, log nothing and
finish.
