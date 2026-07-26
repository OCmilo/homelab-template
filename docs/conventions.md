# Operating conventions

Last verified: 2026-07-26

The rules that hold across the whole stack, independent of who runs it. Machine
facts (hostnames, IPs, personal accounts) live in the repo root `CLAUDE.md`;
this file is the part that travels.

## Hard rules

- NEVER run host-side (macOS) `sqlite3` against a live container database —
  virtiofs lock/cache incoherence corrupts it. Stop the service first or use
  `docker exec`. Write-heavy SQLite databases belong in named volumes (ext4
  inside the Colima VM), never on a macOS bind mount. The rule comes from an
  incident that corrupted two service databases outright.
- Do not add Linux GPU passthrough (`/dev/dri`): containers run inside the
  Colima VM and cannot reach VideoToolbox or the iGPU. Prefer Direct Play.
- Bind mounts from macOS `/tmp` are silently empty inside the VM — Colima does
  not mount it. Use `$HOME` paths.
- Uptime Kuma monitors must use the LAN IP and published port
  (`http://${LAN_IP}:<port>`): container-name URLs break when container IPs
  churn on recreate, and private domains do not resolve inside containers.
  Homepage widgets still use container-name URLs — they re-resolve per request,
  so churn is harmless there.
- All containers that touch media mount the SAME `/data` root (TRaSH Guides
  hardlink layout): downloads to `/data/torrents`, imports into
  `/data/media/{tv,movies}`. Never introduce per-app volumes that break
  hardlinks. If a "remote path mapping" ever seems necessary, the mounts are
  wrong.
- Remote access is Tailscale-only; nothing is forwarded on the router. Never
  propose exposing a service publicly.
- NEVER run `docker compose down -v` (or `--volumes`). It deletes all nine
  named volumes: Jellyfin's config and watch state, the Healthchecks database
  and its full ping history, Uptime Kuma's history, Karakeep's bookmarks and
  Meilisearch index, the CouchDB wiki backend, and Beszel's metrics. Plain
  `down`, `stop`, `restart` and `up --force-recreate` never touch volumes —
  only the explicit flag does. Two of these volumes used to be declared
  `external: true`, which made Compose skip them; that guard covered two of
  nine and is gone, so the rule replaces it. Recovery is the nightly export in
  `config/db-snapshots/` via restic, not the volume itself.

## Conventions

- All changes go through this repo: edit compose/config, then
  `docker compose up -d`. No manual `docker run`, no changes made only inside a
  container.
- Use `admin` as the standard username for application administrator accounts.
  Where a service demands an email address, use one address consistently.
- Declare every operational schedule in `jobs/jobs.json`. Healthchecks observes
  executions; launchd, container cron, and application schedulers remain the
  execution authorities. launchd jobs are templates in `jobs/launchd/` installed
  by `scripts/install-jobs.sh`.
- Secrets live in `.env` (gitignored); `.env.example` documents every variable
  with placeholder values only. Quote any value containing spaces — shell
  scripts source this file.
- `.env` is the only file an operator edits to shape an install. Machine facts,
  locale, currency and module selection belong there, never hardcoded in
  `docker-compose.yml`, the `Caddyfile` or `jobs/jobs.json`. A new deployment
  fact means a new documented variable, not a literal in YAML.
- Selecting services means editing `COMPOSE_PROFILES`, never deleting service
  blocks. Every service carries a profile except Caddy, Homepage and
  Healthchecks. A service whose `depends_on` target sits in another profile
  must list that profile too: Compose rejects the project outright rather than
  enabling the dependency.
- Anything that cannot exist on a fresh clone — a file holding credentials from
  another service, a build context fetched out of band — goes behind its own
  opt-in profile. A clean checkout must never fail `docker compose up -d` for
  structural reasons: a missing bind-mount source, an uncreated volume, an
  absent build context. Real credentials are a separate matter, and services
  that gate on them still will not become healthy — gluetun without a
  `NORDVPN_PRIVATE_KEY` is the one that takes four dependents down with it.
- Pin images with full version tags once a service is stable; note the reason in
  the commit message.
- Commit messages: conventional commits (feat/fix/chore), imperative mood.

## Common tasks

- Bring up / apply changes: `docker compose up -d`
- Logs: `docker compose logs -f <service>`, or Dozzle at
  `https://logs.${STACK_HOST}.${PRIVATE_DOMAIN}`
- Update images: bump the tag when Diun notifies, then
  `docker compose pull && docker compose up -d`
- Vulnerability scan: `TRIVY_NOTIFY=false scripts/trivy-scan.sh` writes reports
  under `config/trivy/reports/latest`; scheduled weekly by launchd.
- Scheduled jobs: validate with
  `python3 scripts/healthchecks-reconcile.py --registry jobs/jobs.json --validate-only`;
  reconcile with
  `docker compose exec healthchecks python /opt/homelab/scripts/healthchecks-reconcile.py`;
  install/refresh launchd agents with `scripts/install-jobs.sh`.
- Backups: nightly restic run via launchd (`scripts/backup-restic.sh`). It stops
  the stateful services for the volume exports plus the restic run (minutes, not
  seconds), snapshots to iCloud Drive, verifies with `restic check`, and
  optionally mirrors to Backblaze B2. No media content is backed up.
- Health check: every service should answer on its port from the LAN and via
  Tailscale before a change is considered done.

## Agent operating notes

- Read `docs/current-state.md` before making changes; it records the live
  deployed state and must be kept in sync after infra changes.
- Never commit `.env`, `config/`, `cache/`, service passwords, API keys, auth
  tokens, cookies, tracker credentials, or generated application databases.
- When documenting credentials or an API integration, use placeholders such as
  `<redacted>` or `<set in UI>`.
- Verify with `docker compose config` and service health checks before reporting
  success.
