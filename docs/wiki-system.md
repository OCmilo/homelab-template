# Wiki system

Last verified: 2026-07-26

An Obsidian vault that maintains itself. You decide what goes in — a bookmark, a
clipped page, a podcast URL. Everything after that is bookkeeping done by an LLM
agent on a schedule: extracting the source, writing a summary page, creating or
updating the concept and entity pages it touches, assigning tags from a registry,
cross-linking, rebuilding the maps of content, and running a weekly lint pass.
The vault is plain markdown on disk, versioned in git, and replicated to every
device through CouchDB and obsidian-livesync, so the same file the agent edits on
the server is the file you edit on your phone.

The design principle is a division of labor: the human decides *what* is worth
keeping, the machine maintains *how it connects*. There is no auto-ingestion —
nothing enters the vault without an explicit human act. There is no review gate
either; the agent publishes directly, and the vault's git history is the undo.

Every LLM job is work-gated. If nothing is pending, the wrapper exits without
making an API call. Steady-state cost is a few dollars a month.

## Architecture

```
Obsidian (desktop, phone) ⇄ CouchDB :5984  ⇄ livesync-bridge ⇄ config/wiki-vault/
                                                                (plain markdown,
                                                                 git-versioned)
                                                                       ↑
                        host launchd jobs: wiki-agent.sh <skill> (Codex CLI)
                                           wiki-karakeep-pull.sh
                                           wiki-podcast-transcribe.sh
                                           wiki-ask-server.py (:8799, read-only)
```

Two containers, defined in `docker-compose.yml`:

- **couchdb** (`couchdb:3.5.2.1`, port 5984, named volume `couchdb-data`) is the
  obsidian-livesync replication backend. Its configuration comes from
  `./config/couchdb` mounted at `/opt/couchdb/etc/local.d`; credentials from
  `COUCHDB_USER` / `COUCHDB_PASSWORD`. A named volume is used deliberately —
  the database is write-heavy, and it is treated as rebuildable from the vault.
- **livesync-bridge** mirrors the CouchDB `wiki` database against the plain
  markdown tree at `./config/wiki-vault`, mounted at `/app/vault`. There is no
  published image; it is built from a pinned clone under `cache/build/`. It runs
  with `CHOKIDAR_USEPOLLING=true` and a 10s interval because inotify events do
  not cross a virtiofs bind mount from a Linux VM, and without polling the
  bridge only notices host-side vault changes on container restart.

Caddy exposes the sync endpoint at `livesync.${STACK_HOST}.${PRIVATE_DOMAIN}`,
reverse-proxying `couchdb:5984`. Nothing here is meant to be publicly reachable;
the assumption throughout is a private network or a mesh VPN.

Everything with a schedule runs on the **host**, not in a container, because the
agent needs Homebrew tools (`codex`, `yt-dlp`, `ffmpeg`, `pandoc`) and direct
filesystem access to the vault. The host scripts:

| Script | Role |
|---|---|
| `scripts/wiki-agent.sh` | Runs one LLM skill: work gate, lock, agent invocation, post-processing, vault commit, monitoring ping |
| `scripts/wiki-karakeep-pull.sh` | Pulls Karakeep bookmarks tagged `wiki` into `system/raw/` plus an inbox pointer |
| `scripts/wiki-podcast-transcribe.sh` | Transcribes queued podcast/video URLs into `system/raw/` |
| `scripts/wiki-ask-server.py` | HTTP bridge on port 8799 for the plugin's Ask and Ops drawers; read-only agent runs |
| `scripts/wiki-hierarchy-sync.py` | Deterministic `up:` frontmatter owner; runs after every skill |
| `scripts/wiki-graph-settings.py` | Deterministic; rebuilds `wiki/mocs/graph-settings.md` and the stable tag palette after `refresh-moc` |
| `scripts/wiki-log-order.py` | Restores chronological order in the `## runs` section of `system/log.md` |
| `scripts/wiki_usage.py` | Local JSONL token/cost ledger and OpenAI Costs API client |
| `scripts/wiki-plugin-publish.py` | Publishes the dashboard plugin to devices through CouchDB |

The scripts assume the repository is checked out at `~/homelab`, source
`~/homelab/.env` at startup, and the bash ones begin with
`eval "$(/usr/local/bin/brew shellenv)"`. Adjust that prefix if your Homebrew
lives elsewhere.

## Vault layout

The vault is the product. Its structure is a contract that both the agent and
several deterministic scripts depend on.

```
config/wiki-vault/
├── AGENTS.md                  # standing rules; Codex auto-loads it from the cwd
├── inbox/                     # manual drops — processed and emptied by ingest
│   ├── podcasts.md            # SCRIPT-MANAGED queue, never agent content
│   └── research-gaps/         # HUMAN-OWNED, never processed by any agent
├── system/                    # machinery; you rarely open this
│   ├── index.md               # catalog of wiki pages, agent-maintained
│   ├── log.md                 # append-only operation log; needs a `## runs` heading
│   ├── ask-history.json       # Ask thread persistence, plugin-owned
│   ├── raw/YYYY/              # immutable source material, never edited after creation
│   ├── reports/               # weekly lint reports, <date>-lint.md
│   └── schema/
│       ├── tags.md            # the tag registry — starts EMPTY, grows bottom-up
│       ├── conventions.md     # frontmatter spec, naming, linking rules
│       ├── colors.json        # subject -> palette slot "1".."6", script-owned
│       ├── map.json           # vault layout the dashboard plugin reads
│       └── ask.json           # Ask server endpoints + research-gap folder
└── wiki/                      # the knowledge layer — the only folder you live in
    ├── concepts/              # ideas, patterns, practices
    ├── entities/              # proper nouns: people, orgs, products, models, tools
    ├── sources/               # one summary page per raw source
    ├── synthesis/             # saved Ask answers, human-kept
    └── mocs/                  # maps of content, one per subject, plus home.md
```

`AGENTS.md` must stay at the vault root — Codex loads it from the working
directory, and it carries the standing rules (layout contract, tag creation
rules, protected sections, writing style). Skills carry per-job workflows;
`AGENTS.md` carries everything that is true on every run.

### Rules that are load-bearing

**`system/raw/` is immutable.** Files land there once and are never edited. Every
`wiki/sources/` page corresponds to a raw file of the same basename — that
correspondence is literally how the ingest work gate detects pending work.

**`inbox/podcasts.md` is script state, not content.** It is a checklist of
`- [ ] <url>` lines. The transcriber flips processed lines to `- [x]` and failed
ones to `- [!]` with the error in an HTML comment. Both the ingest gate and the
ingest skill exclude it by name. An agent that "tidies" this file breaks intake.

**`inbox/research-gaps/` is human-owned.** The dashboard's Ask drawer writes
inert notes here when an answer reports missing coverage. The ingest gate globs
`inbox/*.md` non-recursively, so these files never trigger a run, and the ingest
skill is explicitly told never to process, rewrite, or delete them. They stay
inert until you supply real source material through a normal intake path.

**`up:` frontmatter is script-owned.** `wiki-hierarchy-sync.py` is the only
writer. Agents are contract-forbidden from touching it; lint may flag it but
never edits it.

**`## Personal notes` is human-owned.** Concept and entity pages carry this
heading immediately before `## Related`. The agent creates the heading when
absent and never reads, edits, moves, summarizes, cites, or deletes anything
beneath it.

**`wiki/synthesis/` bodies are human-kept.** Pages saved from an Ask answer carry
`type: synthesis` and `status: edited`; agents may complete frontmatter and
Related links but never rewrite the body.

**Script-generated files agents must not write:** `wiki/mocs/graph-settings.md`,
`system/schema/colors.json`, any `*.canvas` under `wiki/mocs/`, and
`library.base` if you use Obsidian Bases.

### Note format

```markdown
---
type: concept                       # source | entity | concept | moc | synthesis
up: ["[[wiki/mocs/ml|ml]]"]         # script-owned, inserted after `type:`
tags: [ml, transformers, training]  # FLAT, no slashes; first tag = primary subject
created: 2026-07-16
enrichedAt: 2026-07-16T09:00:00Z    # absent = pending enrichment (the idempotency stamp)
status: auto                        # auto | edited
sources: ["[[wiki/sources/2026-07-16-some-article|some-article]]"]
---
```

Conventions: kebab-case filenames, one concept per page, wikilinks written as
full vault path with alias (`[[wiki/concepts/foo|foo]]`), no naked URLs in
`wiki/` (URLs live in raw frontmatter and source pages), and a hard
verified-exists rule — the agent never links to a page it has not confirmed
exists. Non-English material stays in its original language under `system/raw/`;
everything under `wiki/` is written in English with `language: <iso>` recorded on
the source page.

`wiki-hierarchy-sync.py` inserts `up:` immediately after the `type:` line, so a
page without a `type:` frontmatter key never receives one. It links
concepts/entities/synthesis to the MOC of their first tag (only if that MOC
exists), subject MOCs to `home`, and sources to the pages that cite them, falling
back to subject MOCs when nothing cites them yet. Because `up:` values are real
wikilinks, Obsidian's native graph gains a hub-and-spoke shape:
home → MOC → concept → source.

## The agent and its skills

Skills are plain markdown prompt files in `config/wiki-agent/skills/`. The
wrapper composes each run as the untrusted-content policy, a separator, then the
skill file, and pipes it to the agent CLI with the vault as the working
directory.

**The hard rule is work gating: no skill invokes the LLM when there is no pending
work.** The gate is a local filesystem check costing zero tokens. When it finds
nothing, the wrapper reports an idle heartbeat and exits 0.

| Skill | Default model | Gate |
|---|---|---|
| `enrich-note` | `WIKI_MODEL_ENRICH`, default `gpt-5.4-nano` | any file under `wiki/**` whose text lacks the string `enrichedAt:` |
| `ingest-inbox` | `WIKI_MODEL_SYNTH`, default `gpt-5.4-mini` | any `inbox/*.md` other than `podcasts.md`, or any `system/raw/*/*.md` with no same-named page in `wiki/sources/` |
| `refresh-moc` | `WIKI_MODEL_SYNTH`, default `gpt-5.4-mini` | vault git HEAD differs from the HEAD recorded at this skill's last successful run |
| `lint-wiki` | `WIKI_MODEL_LINT`, default `gpt-5.1` | same HEAD comparison |
| `answer-question` | `WIKI_MODEL_SYNTH` | not scheduled; invoked on demand by the Ask server |

Note what the gate does *not* do: there is no `modified > enrichedAt`
comparison. A note edited after enrichment never re-triggers enrichment.

**ingest-inbox** is the substantial one. For each inbox file it either processes
the raw source a pointer note references (then deletes the pointer), moves a
clipped page's body into `system/raw/YYYY/`, files a human-written note into
`wiki/`, or logs a bare-URL stub as a failed intake and leaves it alone. For each
raw source without a source page it builds a private coverage map of the
source's central thesis, durable ideas, explanatory lenses, domains, and named
actors; writes `wiki/sources/<date>-<slug>.md` with a 150–400 word summary and
key claims; then creates or updates 1–6 concept pages plus an entity page for
every named actor that clears the bar (specific, attributable claims — a passing
list mention stays plain text). A substantive source that introduces an uncovered
durable idea must create at least one concept page; a run that creates none must
name in the log the exact existing page that already covers each central
candidate. Updating means integrating: contradictions are stated explicitly with
both citations, never silently overwritten. It ends by updating `system/index.md`
and appending to `system/log.md`. It never touches `wiki/mocs/`.

**enrich-note** works one note at a time: 1–4 tags preferring the registry,
2–5 verified backlinks in a `Related` section, missing frontmatter completed,
the `## Personal notes` heading ensured, and an `enrichedAt` UTC stamp. It does
not rewrite body prose and does not create pages.

**refresh-moc** maintains the bird's-eye layer. For every subject tag with three
or more pages it keeps `wiki/mocs/<subject>.md` current: grouped links with
one-line descriptions ordered by importance, an "Open threads" section built from
contradictions and wanted pages in the log, and a Mermaid mindmap of the
subject's core relations (Obsidian renders these natively). It refreshes
`wiki/mocs/home.md` with links to all subject MOCs plus the five most recently
changed pages, and prunes links to pages that no longer exist. Tags below three
pages get no MOC.

**lint-wiki** produces `system/reports/<date>-lint.md` with twelve checks:
broken links and orphans; contradictions; stale time-sensitive claims;
tag hygiene against the registry; duplicate concept or entity pages; wikilinks
not written in full-path-with-alias form; `up:` anomalies; entity coverage
(proper nouns recurring across two or more sources with no entity page — the
backstop for the fact that ingest works source-by-source and cannot see
aggregates); wanted-page hygiene; writing-style violations including
source-centered narration and missing `## Personal notes`; stale synthesis pages
whose cited pages have changed since; and prompt-injection residue. It fixes
mechanically-safe issues directly — clearly-moved link targets, `system/index.md`
drift, a missing empty `## Personal notes` heading — and leaves everything
judgment-based as a recommendation. Report references are plain backticked paths,
never wikilinks, because a tapped link to a missing page creates a junk note.

**answer-question** answers strictly from `wiki/` pages, starting from
`system/index.md`. Every claim carries a full-path wikilink citation; a claim
with no citable page does not go in the answer. When coverage is missing it ends
with a `Not in the wiki:` line naming exactly what is uncovered — the plugin
parses that line to offer the research-gap action.

### Run mechanics

`scripts/wiki-agent.sh <skill> [--retry]`, plus
`scripts/wiki-agent.sh ingest-inbox --source system/raw/YYYY/file.md` for a
trusted reprocess of one existing source. Those three are the only accepted
modes.

For `enrich-note` and `ingest-inbox` a normal run first sleeps `WIKI_SETTLE`
(default 180s) so a burst of device syncs batches into a single run; `--retry`
and `--source` skip the delay. All skills then serialize through a stale-safe
lock directory at `config/wiki-agent/state/run.lock`, reclaimed automatically
after 120 minutes, with the waiter giving up after 30 minutes.

Codex runs with `--ask-for-approval never`, `--sandbox workspace-write`,
`--ephemeral`, `--skip-git-repo-check`, `--json`,
`sandbox_workspace_write.network_access=false`, and `web_search="disabled"`.
Nano-tier models additionally disable Codex's apps, plugins, remote plugins,
tool suggestions, and multi-agent integrations, because nano does not support
the Responses API `tool_search` capability while enrichment only needs local
file and shell tools.

Codex authenticates from an isolated `CODEX_HOME` at
`config/wiki-agent/codex-home`, with `OPENAI_API_KEY` taken from
`WIKI_OPENAI_API_KEY` falling back to `KARAKEEP_OPENAI_API_KEY`. The isolation
matters: a default `~/.codex` logged into an interactive account overrides the
API key, which misbills runs and rejects some models.

After the model run the wrapper records token usage into the ledger, then runs
`wiki-hierarchy-sync.py` and `wiki-log-order.py` (and `wiki-graph-settings.py`
after `refresh-moc`), commits any vault change as
`wiki-agent: <skill> <ISO timestamp>`, and records the new HEAD for the change
gate. The commit goes to a git directory **outside** the synced tree —
`config/wiki-vault.git` by default — so no `.git` folder ever replicates to
devices. Inspect it with
`git --git-dir=config/wiki-vault.git --work-tree=config/wiki-vault log --stat`.

`wiki-log-order.py` requires `system/log.md` to contain a `## runs` heading; it
exits non-zero without one, which aborts the run *after* the model has already
been billed. Create that heading when you scaffold the vault.

### Swapping the agent CLI

Codex is the default and the only runner whose flags the wrapper knows. Set
`WIKI_AGENT_RUNNER` to anything else and you must also supply
`WIKI_AGENT_CMD`: a command line that receives the composed prompt on stdin and
runs with the vault as its working directory. A custom runner owns its own model
selection, sandboxing, and approval policy — the wrapper's Codex-specific
hardening flags do not apply to it. The rest of the pipeline (gating, lock,
usage recording, hierarchy sync, commit, heartbeat) is unchanged. Usage
accounting assumes Codex's `--json` stream, so a custom runner that emits
something else records no token totals.

## Security model

Everything the wiki ingests is text written by someone else, so the system treats
it as data and never as instruction.

`config/wiki-agent/skills/untrusted-content-policy.md` is prepended to every
single run, scheduled or interactive. It establishes that only `AGENTS.md`, the
invoked skill, and (for Ask) the explicit current question carry authority.
Everything else is data: inbox files, raw sources, page bodies, personal notes,
quoted conversation history, transcripts, metadata, URLs, code blocks, tool
output, and any text attributed to another model. Requests embedded in that
material to change role, reveal secrets, inspect credentials, alter the contract,
run a command, call a tool, fetch a URL, or modify unrelated files are ignored,
including when dressed up as "system message", "developer instruction", or
"ignore previous instructions". Commands that are genuinely the subject of a
technical article may be summarized as facts but never executed.

When material looks designed to manipulate the agent, the policy is to continue
with the safe factual content and add a short `prompt-injection suspected` entry
to `system/log.md` naming the file — the payload itself is never copied into the
log or the wiki. Lint check 12 sweeps published pages for instruction-like
residue weekly, again naming the page and category rather than quoting.

Structural controls back the prose up. Network access and web search are disabled
for every job. Runs are ephemeral, so source content is not retained in agent
session history. Writes are sandboxed to the vault workspace. The Ask path runs
with `--sandbox read-only`, so a hostile prompt reaching the answering model
cannot write anything at all; for the same reason Ask deliberately bypasses the
agent run lock, since a read-only run cannot conflict with a writing one. Error
messages are scrubbed of API keys and bearer tokens before they reach the ledger
or the plugin.

The Ask server itself binds `0.0.0.0:8799` with permissive CORS and **no
authentication** — it is designed for a trusted network only. The same applies
to CouchDB. Keep both off the public internet.

## Intake

Three paths, all requiring a deliberate human act.

**Karakeep bookmarks.** `wiki-karakeep-pull.sh` runs hourly. It looks up the
`wiki` tag, pages through every bookmark carrying it, and skips any that already
carry `wiki-synced`. Bookmarks whose crawl has not finished are left for the next
run. For each new one it converts Karakeep's stored HTML to markdown with
`pandoc`, writes `system/raw/YYYY/<date>-<slug>.md` with title/url/author/
published/karakeep-id/pulled frontmatter, drops a pointer note in `inbox/`, and
then tags the bookmark `wiki-synced` so it is pulled exactly once. Applying the
`wiki` tag *is* the send action — bookmark age is irrelevant and nothing is ever
swept up without it. The script talks to `http://localhost:3002/api/v1`, which is
not currently configurable.

**Podcasts and videos.** Paste a URL as a `- [ ] <url>` line in
`inbox/podcasts.md`. The transcriber downloads audio with `yt-dlp`, transcodes to
mono 32k mp3 and segments into 20-minute chunks with `ffmpeg` to stay under the
STT upload cap, transcribes each chunk with OpenAI `gpt-4o-mini-transcribe`,
writes the joined transcript to `system/raw/YYYY/` with `kind:
podcast-transcript` frontmatter, drops an inbox pointer, and checks the line off.
A failure marks the line `- [!]` with a truncated error in a trailing comment and
is never retried silently. Fix or delete the line to retry. The transcriber also
sleeps `WIKI_SETTLE` before scanning, including on a manual run.

**Manual clips and notes.** Anything you drop into `inbox/` yourself. Obsidian's
Web Clipper is the usual route; a clipped page with a source URL in frontmatter
and an article-length body is recognized as a source, while a note you wrote
yourself is filed into `wiki/` as its own content. A stub containing only a URL
is logged as a failed intake and left in place — fetching is the pull scripts'
job, not the agent's.

Because launchd `WatchPaths` fire on `inbox/` changes, a clip made on a phone
reaches the host through the bridge as a filesystem event and triggers ingest
within seconds — after the settle delay.

## The Wiki Dashboard plugin

`obsidian/wiki-dashboard/` is a first-party Obsidian plugin (id `wiki-dashboard`,
`isDesktopOnly: false`) that renders the bird's-eye view *inside* the Obsidian
client rather than in a separate web app. Source lives in `src/`, bundled to
`main.js` by esbuild (`npm run build`). `harness.html` plus
`regen-vault-data.py` stub the Obsidian API so the exact plugin file can be
iterated on in a browser.

It opens a full-canvas view with three modes:

- **Map** — a radial layout: home at the centre, subject MOCs on the first ring,
  concepts and entities on the second, sources near the rim close to the pages
  that cite them. Node size scales with link degree, recently-edited notes get a
  pulsing ring, orphans sit at the rim. Search flies the camera to matches;
  double-clicking a node enters a focus re-layout around it.
- **Sunburst** — three concentric rings (subjects / kinds / pages) with slice
  angle proportional to page share. Page slices open the drawer, subject slices
  toggle the tag filter.
- **Pulse** — a twelve-month calendar heatmap of page activity.

Shared chrome: a search field, subject chips with counts and facet popovers, and
a slide-in drawer that renders any note with Obsidian's own MarkdownRenderer plus
tag chips and backlinks. The theme is detected from the active Obsidian theme and
the tag palette is theme-reactive, while the slot assignment in
`system/schema/colors.json` stays theme-independent.

Two toolbar buttons open non-map drawers. **Ask** is a threaded Q&A panel:
question form, live elapsed status, follow-ups against the last four turns, a
"New conversation" reset, answers rendered as markdown with clickable citation
chips that open the cited page in the drawer, and per-conversation history
persisted in `system/ask-history.json` so it syncs across devices. Two actions
appear on an answer: "Save as synthesis page" writes a `type: synthesis`,
`status: edited` page under the configured synthesis folder with the question in
frontmatter and the primary tag inferred from the cited pages; and, when the
answer carries a `Not in the wiki:` line, a zero-cost research-gap action writes
an inert note into the configured `inbox/research-gaps/` folder with the missing
coverage, an empty candidate-sources section, and a personal-notes section.
**Ops** shows authoritative OpenAI spend, cost by workflow, pending counts
(inbox, unprocessed raw sources, research gaps), the manual credit balance with
"Add credits" and "Set exact balance" actions, and a "Needs attention" list of
failed runs with retry buttons.

The plugin hardcodes no vault layout. It reads structure from
`system/schema/map.json` — `root`, `exclude`, per-folder roles and sizes under
`folders`, the `home` page, `pulse.dateFields` for the heatmap, and
`synthesisSave` for the save target — the palette from
`system/schema/colors.json`, and its server endpoints from
`system/schema/ask.json` (`endpoints`, plus `researchGaps.folder` and
`researchGaps.type`). Because these schema files live in the vault, they sync to
every device along with the content. There is no built-in default endpoint list:
without `ask.json`, Ask and Ops have nowhere to call.

### Distribution

Devices get the plugin through LiveSync's Customization Sync, which stores plugin
files in CouchDB as base64 split across content-addressed leaf documents. Device
profiles are snapshots owned by their clients, so writing directly into a device
profile is immediately undone by that client's next scan.
`scripts/wiki-plugin-publish.py` instead maintains a dedicated remote-only
profile named `homelab-release`, then reads every file back out of CouchDB and
verifies it byte-for-byte against the local build.

```bash
(cd obsidian/wiki-dashboard && npm run build) && scripts/wiki-plugin-publish.py
```

Then, on each device, apply the `homelab-release` profile from the Customization
Sync dialog. Publishing needs `COUCHDB_USER`, `COUCHDB_PASSWORD`, optionally
`WIKI_COUCHDB_URL` (default `http://127.0.0.1:5984`) and `WIKI_COUCHDB_DB`
(default `wiki`).

The publisher copies the document shape from an existing profile document the
first time it writes a given plugin id. It looks for that donor under the profile
name `mac`, so a device profile called `mac` must already have published *some*
plugin. If you rename the plugin or adopt it under a different id, set
`WIKI_TEMPLATE_PLUGIN_ID` to the previous id for the first publish so the donor
document can be found; unset it afterwards. Removing a plugin later requires
deleting its stale `ix:` documents from CouchDB by hand — the dialog does not
retract them.

## Configuration

All keys live in `.env`; `.env.example` carries placeholders.

| Variable | Required | Meaning |
|---|---|---|
| `COUCHDB_USER`, `COUCHDB_PASSWORD` | yes | CouchDB admin credentials; also used by the plugin publisher |
| `KARAKEEP_API_TOKEN` | for Karakeep intake | Karakeep API key (Settings → API Keys) |
| `WIKI_OPENAI_API_KEY` | one of the two | OpenAI key for agent runs and transcription |
| `KARAKEEP_OPENAI_API_KEY` | one of the two | fallback key when `WIKI_OPENAI_API_KEY` is unset |
| `WIKI_VAULT` | no | vault path; default `~/homelab/config/wiki-vault` |
| `WIKI_VAULT_GIT` | no | vault git dir; default `~/homelab/config/wiki-vault.git` |
| `WIKI_MODEL_ENRICH` | no | default `gpt-5.4-nano` |
| `WIKI_MODEL_SYNTH` | no | default `gpt-5.4-mini`; also the Ask model |
| `WIKI_MODEL_LINT` | no | default `gpt-5.1` |
| `WIKI_AGENT_RUNNER` | no | default `codex`; any other value requires `WIKI_AGENT_CMD` |
| `WIKI_AGENT_CMD` | with a custom runner | command line receiving the prompt on stdin |
| `WIKI_SETTLE` | no | pre-run settle seconds, default 180 |
| `WIKI_COUCHDB_URL`, `WIKI_COUCHDB_DB` | no | plugin publisher target; defaults `http://127.0.0.1:5984` and `wiki` |
| `WIKI_TEMPLATE_PLUGIN_ID` | first publish under a new id | donor plugin id for the profile document shape |
| `OPENAI_ADMIN_KEY` | for authoritative spend | organization Admin key for the read-only Costs API; a project key cannot read org costs |
| `WIKI_OPENAI_COST_PROJECT_ID` | no | narrows Costs API totals to one project |
| `WIKI_USD_TO_EUR` | no | display conversion rate in the ledger, default 1.0 |
| `WIKI_PRICE_<MODEL>_<PART>_USD_PER_MTOK` | no | per-model price overrides, e.g. `WIKI_PRICE_GPT_5_4_MINI_INPUT_USD_PER_MTOK` |

Note that `wiki_usage.py` resolves the vault from the default path rather than
`WIKI_VAULT`, so the pending counts shown in the Ops drawer only reflect a vault
at the default location.

### Scheduled jobs

Templates live in `jobs/launchd/`, use `@@HOME@@` where the home directory
belongs, and are stamped and loaded by `scripts/install-jobs.sh` (idempotent,
safe to re-run). `jobs/jobs.json` is the authoritative registry of schedules,
grace periods, and risk classification.

| Job | Command | Schedule | Event trigger |
|---|---|---|---|
| `wiki-inbox-ingestion` | `wiki-agent.sh ingest-inbox` | 12h fallback | WatchPaths on `inbox/` |
| `wiki-note-enrichment` | `wiki-agent.sh enrich-note` | 12h fallback | WatchPaths on `wiki/concepts` and `wiki/sources` |
| `wiki-map-of-content-refresh` | `wiki-agent.sh refresh-moc` | daily 07:00 | — |
| `wiki-lint` | `wiki-agent.sh lint-wiki` | weekly Sunday 05:00 | — |
| `karakeep-wiki-intake` | `wiki-karakeep-pull.sh` | hourly | — |
| `wiki-podcast-transcription` | `wiki-podcast-transcribe.sh` | 6h fallback | WatchPaths on `inbox/podcasts.md` |
| `com.homelab.wiki-ask` | `wiki-ask-server.py` | `RunAtLoad` + `KeepAlive` | — |

The six scheduled jobs report start, success, and failure through
`scripts/kuma-push.sh`, which maps each caller to a Healthchecks check slug and
pings a shared ping key. A skipped, work-gated run still pings success with the
message `idle`, so silence always means a genuine problem. The Ask server is a
long-lived daemon, not a scheduled job, so it has no registry entry.

## Setup

1. **Start the sync spine.** Write `config/couchdb/local.ini` with
   `require_valid_user`, CORS origins for `app://obsidian.md` and
   `capacitor://localhost`, and the enlarged document/request limits
   obsidian-livesync's documentation calls for. Set `COUCHDB_USER` and
   `COUCHDB_PASSWORD`, then `docker compose up -d couchdb`. Verify with
   `curl -su "$COUCHDB_USER:$COUCHDB_PASSWORD" http://<host>:5984/_up`.
   Add the Caddy vhost and a DNS entry for
   `livesync.${STACK_HOST}.${PRIVATE_DOMAIN}`.

2. **Scaffold the vault.** Create the directory tree above at
   `config/wiki-vault/`. Write `AGENTS.md` at the root with your standing rules.
   Create `system/log.md` containing a `## runs` heading, an empty
   `system/index.md`, an empty `system/schema/tags.md` (the registry is meant to
   start empty and grow bottom-up under adversarial justification), and
   `system/schema/conventions.md`. Write `system/schema/map.json` describing your
   folder roles and `system/schema/ask.json` with
   `{"endpoints": ["http://<host>:8799"], "researchGaps": {"folder":
   "inbox/research-gaps", "type": "research-gap"}}`. Initialize the external git
   dir:
   `git --git-dir=config/wiki-vault.git --work-tree=config/wiki-vault init`,
   then commit the scaffold.

3. **Start the bridge.** Build the livesync-bridge image from a pinned clone,
   write `config/livesync-bridge/config.json` pairing the CouchDB `wiki`
   database with the `/vault` mount, then `docker compose up -d livesync-bridge`.

4. **Onboard devices.** Install Obsidian and the Self-hosted LiveSync plugin,
   point it at the Caddy URL with the CouchDB credentials and database `wiki`,
   and choose live sync mode. Test both directions: an edit on a device should
   appear in `config/wiki-vault/` within a minute, and vice versa. LiveSync
   resolves conflicts by newest edit without prompting; the vault git history is
   the recovery path.

5. **Install the dashboard.** Build the plugin, run
   `scripts/wiki-plugin-publish.py`, and apply the `homelab-release` profile from
   the Customization Sync dialog on each device. Customization Sync is hidden
   until you enable advanced features in the LiveSync settings and give each
   device a unique name. On the very first publish under a fresh plugin id you
   will need `WIKI_TEMPLATE_PLUGIN_ID` pointed at a plugin id that already has a
   profile document.

6. **Install the host tooling.** `brew install codex yt-dlp ffmpeg pandoc`, fill
   in the remaining `.env` keys, then run each script once by hand:
   `scripts/wiki-karakeep-pull.sh`, then `scripts/wiki-agent.sh ingest-inbox`,
   then `enrich-note`, `refresh-moc`, and `lint-wiki`. Read the resulting vault
   diff before trusting the schedule. When the output looks right, run
   `scripts/install-jobs.sh`.

7. **Verify the loop end to end.** Tag a bookmark `wiki`; within roughly an hour
   it should exist as a summarized, tagged, cross-linked source page with at
   least one concept page, on every device, with no further manual step. Run a
   skill twice in a row and confirm the second run is a no-op — that is the work
   gate and the `enrichedAt` stamp doing their job.

Back up `config/wiki-vault/` and `config/wiki-vault.git` with whatever you
already use. The CouchDB volume needs no special handling: it is rebuildable by
wiping the database, re-uploading the vault through the bridge, and re-pairing
devices.

## Cost and the usage ledger

Three model tiers, chosen for the shape of each job: a nano model for
enrichment, which is mostly mechanical bookkeeping over one note at a time; a
mini model for ingest and MOC refresh, which need real synthesis; and a
full-size model for the weekly lint, which reasons across the whole vault at
once. Transcription uses `gpt-4o-mini-transcribe`.

Default prices in `wiki_usage.py`, in USD per million tokens
(input / cached input / output):

| Model | Input | Cached input | Output |
|---|---|---|---|
| `gpt-5.4-nano` | 0.20 | 0.02 | 1.25 |
| `gpt-5.4-mini` | 0.75 | 0.075 | 4.50 |
| `gpt-5.1` | 1.25 | 0.125 | 10.00 |

Anything else falls back to configurable defaults of 2.50 / 0.25 / 15.00, and
every individual figure can be overridden from `.env`. At a curation rate of a
handful of sources a week the total lands around five dollars a month, dominated
by ingest and lint; it scales with how much you feed it, not with vault size.

`wiki_usage.py` maintains a local JSONL ledger under
`config/wiki-agent/state/usage.jsonl`, appending one deduplicated, flock-guarded
event per run with token counts, computed cost, and the savings attributable to
cached input. Failures are recorded even when a run produced no token totals, so
a credit exhaustion or an API outage shows up rather than vanishing; unresolved
failures persist across month boundaries until a successful run of the same kind
clears them. Everything here is local — metering a run costs no network request.

The ledger's figures are estimates. With `OPENAI_ADMIN_KEY` set, the Ops drawer
also fetches authoritative current-month spend from the organization Costs API,
grouped by line item and split into agent/Ask usage, transcription, and other,
cached for five minutes with an explicit refresh available. Attribution is
model-based, so it can only separate services that use distinguishable models
until you give each service its own project key. Credit balance is a manual,
timestamped snapshot because there is no balance endpoint to read; neither the
balance nor the estimate gates any job.
