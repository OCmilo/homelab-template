# Setup

Last verified: 2026-07-26

How to stand this stack up on a fresh machine. Written for someone starting
from nothing; the original deployment runs on an Intel MacBook Pro under macOS
with Colima, and everything here assumes that shape unless noted.

Work through the phases in order — later phases depend on earlier ones. Nothing
here is destructive to a machine that already runs other software, but the
stack expects to own ports 80, 443, and (if you install AdGuard Home) 53.

## 0. What you need first

- A Mac with Homebrew. Apple Silicon works; the media services are Direct
  Play-first because containers inside the Colima VM cannot reach VideoToolbox
  or Quick Sync, so hardware transcoding is not available to Jellyfin.
- A domain you control, with API credentials for a DNS provider Caddy can use
  for DNS-01 challenges. The bundled Caddy image is built with the Porkbun
  plugin (`docker/caddy/Dockerfile`); swap the plugin and the `tls` block in
  `Caddyfile` if you use another registrar. Certificates are issued without any
  inbound port being open — public DNS only ever sees a temporary
  `_acme-challenge` TXT record.
- Disk space for media, plus somewhere for backups (iCloud Drive by default,
  optionally a Backblaze B2 bucket).
- Optional but assumed by parts of the stack: a Tailscale account (remote
  access), a WireGuard-capable VPN provider for downloads (gluetun is
  configured for NordVPN, and supports many others), an OpenAI API key (wiki
  agent, Karakeep AI tagging), a Telegram bot (notifications).

Nothing is exposed to the public internet. Remote access is Tailscale-only, and
no ports are forwarded on the router.

## 1. Host tooling

```bash
brew install colima docker docker-compose git
brew services start colima
colima start --cpu 4 --memory 8 --disk 100 --vm-type vz
```

The reference machine runs 4 CPUs / 8 GiB / 100 GiB on the `vz` backend.
Downsizing to 2 CPUs / 6 GiB caused service instability, so treat those numbers
as a floor rather than a suggestion.

Colima gotchas that will bite you later if you forget them:

- macOS `/tmp` is **not** mounted into the VM. A bind mount of `/tmp/foo`
  silently mounts an empty directory. Keep every mount under `$HOME`.
- Write-heavy SQLite databases must live in named volumes (ext4 inside the VM),
  never on a macOS bind mount. Two databases were corrupted learning this (the
  upstream repo keeps the postmortem at
  `docs/postmortems/2026-07-06-sqlite-over-colima.md`). The compose file already
  follows the rule — do not "simplify" those volumes.
- Over non-interactive SSH the Docker credential helper is unavailable; for
  anonymous pulls use `DOCKER_CONFIG=$(mktemp -d)` together with
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

Install Tailscale if you want remote access, and log in on the host and on your
client devices.

## 2. Clone and configure

```bash
git clone <this-repo> ~/homelab
cd ~/homelab
cp .env.example .env
```

Then edit `.env`. Every variable is documented inline; the ones that decide the
shape of your install are at the top:

- `STACK_HOST` — the subdomain label everything lives under. With
  `STACK_HOST=homelab` and `PRIVATE_DOMAIN=example.com`, Jellyfin is at
  `https://jellyfin.homelab.example.com`.
- `STACK_NAME` — human-readable name used in dashboards and notifications.
  Quote it if it contains spaces: shell scripts source this file.
- `LAN_IP` / `TAILSCALE_IP` — this machine's addresses. They end up in service
  allowed-host lists, so get them right or Paperless and friends will reject
  requests.
- `DATA_ROOT` — where media lives. Everything that touches media mounts this
  single root so hardlinks work (see step 3).
- `PUID` / `PGID` — `id -u` and `id -g` for the user that owns the files.

Generate the secrets as you go; each entry says how (`openssl rand -hex 32`,
`LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 32`, and so on). Never
commit `.env`, and never put real values in `.env.example`.

The NordVPN WireGuard private key is not shown in their dashboard; derive it
from an access token with `scripts/set-nordvpn-key.sh`, which reads the token
without echoing it and writes the derived key into `.env`.

### Things that assume the reference layout

Four assumptions are baked in deeply enough that changing them means editing
code, not configuration. Read these before you deviate:

- **The repo defaults to `~/homelab`.** `scripts/install-jobs.sh` stamps the
  real checkout path into the launchd agents, so those work anywhere, but the
  host scripts fall back to `~/homelab` when `HOMELAB` is unset. Export
  `HOMELAB=/your/path` (or clone to `~/homelab`) before running them.
- **The compose project is named `homelab`.** Two volumes are declared
  `external: true` with literal names (`homelab_jellyfin-config`,
  `homelab_healthchecks-data`), and `scripts/backup-restic.sh` exports several
  volumes by their `homelab_` prefix. Cloning into a differently named directory
  changes the prefix and breaks both. Create the external volumes before the
  first `up`:
  `docker volume create homelab_jellyfin-config && docker volume create homelab_healthchecks-data`.
- **Two dependencies are fetched out of band.** `scripts/install-adguardhome-host.sh`
  expects the AdGuard Home binary at `bin/AdGuardHome` (download the build for
  your architecture — the URL in the script is `darwin_amd64`), and
  `livesync-bridge` builds from a clone in `cache/build/livesync-bridge`
  because upstream publishes no image.
- **Locale defaults are European.** Paperless OCR is `por+spa+eng`, Ghostfolio
  reports in EUR, schedules assume `Europe/Madrid`, and subtitle translation has
  a fixed target language. Change them in `docker-compose.yml`, `jobs/jobs.json`,
  and `.env` as needed.

## 3. Storage layout

Create the media root with the TRaSH Guides layout:

```bash
mkdir -p "${DATA_ROOT}"/{torrents/{movies,tv},media/{movies,tv,audiobooks,podcasts,ebooks},incoming/{scans,ebooks}}
```

The single `/data` mount is the load-bearing decision here: qBittorrent writes
to `/data/torrents`, Sonarr and Radarr import into `/data/media/...`, and both
see the same filesystem, so imports are hardlinks rather than copies. If you
ever find yourself configuring a "remote path mapping" in an *arr, your mounts
are wrong.

## 4. Bring up the core

Start small and verify, rather than starting all forty containers at once:

```bash
docker compose up -d caddy homepage
```

Point your DNS at the machine — either AdGuard Home rewrites (step 7) or
Tailscale split DNS — and confirm `https://homepage.${STACK_HOST}.${PRIVATE_DOMAIN}`
answers with a valid certificate. Certificate issuance can take a minute on
first run while the DNS-01 challenge propagates.

Then bring up the rest:

```bash
docker compose up -d
```

Services with credentials to configure in their own UI on first run: Sonarr,
Radarr, Prowlarr, Bazarr, Jellyseerr, Maintainerr, qBittorrent, Jellyfin,
Karakeep, Paperless, Firefly III, Ghostfolio, Beszel, Uptime Kuma.

The downloads group (qBittorrent, Prowlarr, FlareSolverr, Shelfmark) runs inside
gluetun's network namespace. Consequences worth internalizing: those containers
have no ports of their own (everything is published on `gluetun`), they reach
each other over `localhost`, and everything else reaches them as
`gluetun:<port>`. Container-name DNS does not work inside that namespace. If
the tunnel drops, gluetun's killswitch takes their connectivity with it — which
is the point.

## 5. Scheduled jobs

`jobs/jobs.json` is the registry of every operational schedule, whatever runs
it. Healthchecks observes executions; launchd, container cron, and application
schedulers stay the execution authorities.

Validate the registry, then create the checks:

```bash
python3 scripts/healthchecks-reconcile.py --registry jobs/jobs.json --validate-only
docker compose exec \
  -e HEALTHCHECKS_ADMIN_PASSWORD='<temporary-password>' \
  healthchecks python /opt/homelab/scripts/healthchecks-bootstrap.py
docker compose exec healthchecks python /opt/homelab/scripts/healthchecks-reconcile.py
```

Bootstrap creates the administrator, project, and API keys under
`config/healthchecks/` (gitignored). It requires the password to be passed in —
change it in the UI after first login. Reconcile upserts checks by stable id and
writes `config/healthchecks/ping-urls.env`, which the job scripts read to find
their ping URLs. It never deletes checks it does not manage.

Install the launchd agents:

```bash
scripts/install-jobs.sh
```

The plists in `jobs/launchd/` are templates containing `@@HOME@@`; the installer
stamps your home directory, writes them to `~/Library/LaunchAgents/`, and loads
anything that changed. It is safe to re-run — unchanged jobs are skipped — and
you should re-run it after pulling changes that touch a plist. Delete the jobs
you do not want from `jobs/launchd/` and `jobs/jobs.json` before installing.

## 6. Backups

`scripts/backup-restic.sh` snapshots stack state (not media) to a restic
repository in iCloud Drive, verifies it with `restic check`, and optionally
mirrors to Backblaze B2 (`scripts/init-restic-b2.sh` initializes that mirror
once). It stops the stateful services for the volume exports and the restic run
— minutes, not seconds — so it is scheduled overnight.

Set `RESTIC_PASSWORD` before the first run and keep a copy somewhere off this
machine. Without it the snapshots are unreadable, and no amount of access to
the files will change that.

## 7. Optional: AdGuard Home for LAN DNS

AdGuard Home runs natively rather than in Docker so it can bind port 53
reliably:

```bash
scripts/reserve-port-53-for-adguard.sh   # stops Colima forwarding VM port 53
scripts/install-adguardhome-host.sh      # installs + starts the launchd service
scripts/set-adguard-password.sh          # sets the admin password
```

Then add DNS rewrites for `*.${STACK_HOST}.${PRIVATE_DOMAIN}` pointing at
`LAN_IP`, and point your router or clients at this machine for DNS. Devices on
Tailscale can use split DNS instead.

## 8. Optional modules

Each of these is self-contained; skip any you do not want by removing its
services from `docker-compose.yml` and its jobs from `jobs/jobs.json`.

- **Finance** — Firefly III, its data importer, and Ghostfolio, plus the
  categorization and sync tooling in `scripts/firefly-*.py` and
  `scripts/ghostfolio-*`. Rules are config-as-code in
  `config/firefly/rules.json` (`scripts/firefly-rules-sync.py` exports, diffs,
  and applies). Design and pipeline: `docs/finance-stack.md`.
- **Wiki** — CouchDB + livesync-bridge + the wiki agent jobs + the Obsidian
  `wiki-dashboard` plugin. Full module documentation, including vault layout and
  first-run steps: `docs/wiki-system.md`.
- **Documents** — Paperless-ngx with OCR. Drop files into
  `${DATA_ROOT}/incoming/scans` or use the mobile share sheet.
- **Books** — Shelfmark for search and requests, Calibre-Web Automated for the
  ebook library, Audiobookshelf for audiobooks. Flow:
  `docs/book-audiobook-flow-spec.md`.

## 9. Verify

A change is done when the service answers on its port from the LAN and through
Tailscale. Beyond that:

```bash
docker compose config          # renders? then your .env is complete
docker compose ps              # everything up and healthy
scripts/install-jobs.sh        # all jobs report "unchanged"
TRIVY_NOTIFY=false scripts/trivy-scan.sh   # first vulnerability baseline
```

Read `docs/conventions.md` before making changes — the rules there exist because
breaking them broke something once.
