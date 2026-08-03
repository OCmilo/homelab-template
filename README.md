# homelab-template

A complete, opinionated homelab stack as code: a Docker Compose service set, a
declarative scheduled-job framework, monitoring, backups, and the docs that
explain why each piece is shaped the way it is. Fork it, point it at a domain
you control, and run it on a Mac.

The stack is built for a single Mac running Colima. Every service is reachable
at `https://<service>.<STACK_HOST>.<your-domain>` over your LAN or Tailscale,
with real certificates and no ports forwarded to the internet.

Nothing here is a demo. It is the generic half of a running system, and several
of the configuration choices below look the way they do because the original
broke and taught someone a lesson. Those rules are carried in
[`docs/conventions.md`](docs/conventions.md).

## What's included

**Video.** Jellyfin for playback. Sonarr, Radarr, and Bazarr for series,
movies, and subtitles. Prowlarr for indexers, with FlareSolverr behind it.
qBittorrent for downloads. Jellyseerr for requests. Maintainerr for rule-based
library cleanup, Decluttarr for stuck-queue janitorial work, and Recyclarr for
weekly TRaSH Guides custom-format sync into Sonarr and Radarr.

**Books and audiobooks.** Shelfmark for search and requests, routed into two
destinations: Calibre-Web Automated ingests ebooks into a Calibre library,
Audiobookshelf serves audiobooks and podcasts.

**Documents.** Paperless-ngx with OCR and auto-tagging, backed by Redis, with a
consume folder for scans.

**Bookmarks.** Karakeep for saved links, RSS, and full-text search, with
Meilisearch for the index and a headless Chrome container for page archiving.
Optional AI tagging when an OpenAI key is present.

**Wiki.** CouchDB as the sync backend for an Obsidian vault via
obsidian-livesync, plus a `livesync-bridge` container that mirrors the database
to plain Markdown on disk so scripts and agents can work on real files. On top
of that sits an optional LLM agent (`scripts/wiki-agent.sh`) that ingests an
inbox, enriches notes, refreshes maps of content, and lints the vault on a
schedule; a podcast/video transcription intake; a Karakeep-to-vault pull; and
an Obsidian plugin (`obsidian/wiki-dashboard`) with a read-only "ask the wiki"
bridge.

**Finance.** Firefly III as the cash-flow ledger, the Firefly Data Importer for
Enable Banking (PSD2) and CSV/OFX imports, and a small cron container for
Firefly housekeeping and nightly autoimport. Ghostfolio (Postgres + Redis) for
net worth and positions, with an IBKR Flex sync container and a script that
pushes Firefly cash balances into it. Host scripts handle merchant
normalization, category learning from past filings, uncategorized-transaction
alerts, rule drift detection against a checked-in `rules.json`, and a weekly
Telegram budget digest.

**Monitoring.** Healthchecks as the scheduled-job catalog and execution
dashboard. Uptime Kuma for service and endpoint checks. Beszel (hub plus local
agent over a Unix socket) for host and container metrics. Dozzle for live
container logs. Homepage as the front door.

**Infrastructure.** Caddy, built with the Porkbun DNS plugin, terminating HTTPS
for every service. gluetun holding a WireGuard tunnel that qBittorrent,
Prowlarr, FlareSolverr, and Shelfmark run inside. AdGuard Home installed as a
native macOS launchd daemon (not a container) so it can bind port 53, with a
helper script to install it and another to keep macOS from claiming that port.
Nightly restic backups to iCloud Drive with an optional encrypted Backblaze B2
mirror, and a weekly Trivy scan of every pinned image with results posted to
Telegram.

## Design decisions

These are the parts worth adopting even if you throw away half the services.

**One `/data` mount, TRaSH layout.** Downloads and media live under a single
`DATA_ROOT` that is mounted at the same path in every container that touches
it. That is what makes hardlinks and atomic moves work instead of silently
degrading into slow copies. Splitting `/data` into per-app volumes is the most
common way people break this, so the compose file mounts the root and the
comments say why.

**Downloads live in the VPN namespace.** gluetun owns the network namespace;
qBittorrent, Prowlarr, FlareSolverr, and Shelfmark join it with
`network_mode: service:gluetun` and publish no ports of their own. If the
tunnel drops, gluetun's killswitch takes their connectivity with it — there is
no configuration mistake that leaks traffic, because those containers have no
other route out.

**Private HTTPS, nothing forwarded.** Caddy issues certificates over DNS-01
against your registrar's API, so no inbound port ever needs to be open. Public
DNS sees only temporary `_acme-challenge` records; the service names themselves
resolve through your own DNS (AdGuard on the LAN, Tailscale MagicDNS remotely).
Remote access is Tailscale, not a public endpoint.

**Write-heavy SQLite never sits on a Colima bind mount.** Uptime Kuma,
Karakeep, Healthchecks, Beszel, CouchDB, and the Jellyfin config all use named
Docker volumes, which are ext4 inside the VM. This is not a preference: host
and guest SQLite do not share locks coherently across the virtiofs mount, and
two databases were corrupted the day that was discovered. The backup script works
around it by exporting consistent copies from inside the VM and by stopping the
bind-mounted SQLite services for the few seconds the snapshot takes, rather
than reading live database files from the host.

**Jobs are declared, not discovered.** `jobs/jobs.json` is the single source of
truth for every scheduled job: stable id, which scheduler owns it, source file,
command, cron expression or interval, expected duration, grace period, risk,
and whether execution telemetry is live.
`scripts/healthchecks-reconcile.py` turns that registry into Healthchecks
checks. The split matters: launchd, container cron, and application schedulers
stay the execution authority, and Healthchecks only observes. It gets no Docker
socket and cannot run anything. Jobs whose scheduler emits no per-run
completion hook are registered `catalog-only` and created paused, because
showing them green would be a lie.

**Images are pinned.** Every service pins a tag or a digest. Nothing
auto-pulls; review updates during planned maintenance. Trivy scans what is
actually running once a week.

## Requirements

- A Mac (Apple Silicon or Intel) running macOS, with Homebrew, Colima, and the
  Docker CLI plus Compose plugin.
- A domain you control, with a Porkbun account and API credentials — Caddy uses
  them for DNS-01 certificate issuance. Another DNS provider means rebuilding
  the Caddy image with a different `caddy-dns` plugin.
- Storage for media. The internal disk works to start; an external APFS volume
  is the usual next step. Media itself is deliberately not backed up.
- Optional: Tailscale, for remote access without exposing anything.
- Optional: a WireGuard VPN provider for the download path. The compose file is
  wired for NordVPN; gluetun supports many others, and switching means changing
  a few environment variables.
- Optional: an OpenAI API key, for Karakeep's AI tagging and the wiki agent,
  transcription, and ask features.
- Optional: a Telegram bot and a forum-style group, for backup, scan, and
  finance notifications.

## Get started

Setup is documented end to end in [`docs/setup.md`](docs/setup.md) — prepare
the host, create the volumes, fill in `.env`, bring up the first services,
bootstrap Healthchecks, and install the scheduled jobs. Start there rather than
running `docker compose up` and working backwards.

## What you'll want to change

- **`.env`, and only `.env`.** Copy `.env.example` and work through it. It is
  the single file you edit: `docker-compose.yml`, the `Caddyfile` and
  `jobs/jobs.json` all read from it. `STACK_HOST`, `STACK_NAME`, and
  `PRIVATE_DOMAIN` define every URL in the stack and the names on the
  certificates. `DATA_ROOT`, `TZ`, `PUID`/`PGID`, `LAN_IP`, `LAN_SUBNET`, and
  `TAILSCALE_IP` describe your machine and network.
- **Which services you actually want.** The compose file is a menu, not a
  contract, and `COMPOSE_PROFILES` is how you order from it. List the modules
  you want — `video`, `books`, `documents`, `bookmarks`, `wiki`, `finance`,
  `monitoring` — and the rest never start. Caddy, Homepage and Healthchecks are
  always on. Nothing needs deleting from any YAML file.
- **Which jobs you need.** Nothing: each entry in `jobs/jobs.json` names the
  module (or modules) that own it. `scripts/install-jobs.sh` installs only the
  agents whose modules are all enabled and unloads the rest, and the reconciler
  pauses the checks of anything switched off rather than leaving them to alert.
- **Telegram routing.** The stack assumes one bot posting into a forum-style
  supergroup with a closed General topic, so every message carries a thread id.
  Set them in `.env`: `TELEGRAM_TOPIC_TRIVY`, `TELEGRAM_TOPIC_BACKUP`,
  `TELEGRAM_TOPIC_SYSTEM`, `TELEGRAM_TOPIC_FINANCE`.
  Leave them unset to post to General, or point them all at one topic.
- **Locale-shaped defaults.** Paperless OCR languages, the Ghostfolio sync
  currency, the registry timezone in `jobs/jobs.json`, and the subtitle
  translation target language are all set for one household. Change them.
- **Branding.** `assets/homepage-brand/` holds the favicon and touch-icon set
  mounted into Homepage. Replace the files, then recreate the container so
  Docker reattaches the current inodes.

## Scope and limits

Read this part before you commit a weekend to it.

**macOS and Colima first.** Scheduled jobs are launchd plists and AdGuard Home
is installed as a macOS LaunchDaemon. Host scripts resolve Homebrew from either
the Apple Silicon or the Intel prefix, so both work, but nothing here targets
Linux without work.

**The repo is expected at `~/homelab`.** Host scripts and the rendered launchd
plists resolve paths from `$HOME/homelab`. Cloning somewhere else means editing
those paths.

**The compose project name matters.** Named volumes take the project name as
their prefix, and `scripts/backup-restic.sh` looks them up by the literal
`homelab_` prefix. Cloning into a differently named directory breaks that.

**Some pieces need a manual fetch.** The AdGuard Home binary is downloaded by
hand into `bin/`. The `livesync-bridge` image has no upstream publication and
is built from a pinned clone you place under `cache/build/` — which is why it
sits behind its own `wiki-bridge` profile rather than blocking the first `up`.

**The finance and wiki modules assume you run those applications.** The Firefly
scripts assume Firefly is populated and that you use its rules and categories;
the Enable Banking path assumes an account with a PSD2 provider and consents
that expire every 90 days; the IBKR sync assumes an Interactive Brokers Flex
Query. The wiki agent assumes you use Obsidian, that the `codex` CLI is
installed on the host, and that you are willing to pay for model calls. The
checked-in Firefly rules and merchant map ship empty — export your own with
`scripts/firefly-rules-sync.py --export` once your rules exist.

**No multi-user or hardening story.** Services are single-user, most have
signups disabled, and there is no SSO, no per-service authorization model, and
no network segmentation beyond the VPN namespace. The security posture is
"nothing is exposed to the internet". If you publish any of this, you are on
your own.

**No GPU transcoding.** Colima gives containers no `/dev/dri` passthrough, so
Jellyfin transcodes on CPU. Direct play on the LAN is the assumption.

**Backups cover state, not media.** restic snapshots the repo checkout,
service configuration, database exports, and the Calibre library. Movies, TV,
audiobooks, and torrents are not backed up — they are considered replaceable.
Restores have been exercised; the restore paths are documented per service.

**Your secrets and your downloads are yours.** `.env` is gitignored and stays
that way; the encryption password for the restic repository must live somewhere
that is not this machine, because losing it loses every backup. What you point
the indexers and download client at is your responsibility and subject to the
laws where you live.

## Docs and license

[`docs/README.md`](docs/README.md) indexes everything and records which file is
authoritative for which fact — a rule worth keeping, since duplicated
documentation is how the original drifted. The pieces most worth reading before
you change anything are
[`docs/conventions.md`](docs/conventions.md),
[`docs/job-monitoring.md`](docs/job-monitoring.md), and
[`jobs/README.md`](jobs/README.md).

MIT licensed. See [LICENSE](LICENSE).
