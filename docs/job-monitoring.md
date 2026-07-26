# Scheduled Job Monitoring

Last verified: 2026-07-26

## Decision

Use self-hosted Healthchecks as the single scheduled-job catalog and execution
dashboard. It is BSD-3-Clause open source, free to self-host, scheduler
agnostic, and has a substantially simpler UI than a workflow scheduler.

Healthchecks observes jobs; it does not execute them. This preserves the
correct execution boundary:

- launchd owns host jobs that need Homebrew, iCloud, the macOS filesystem, or
  the user's Colima context;
- container cron owns the Firefly maintenance jobs;
- the Ghostfolio sync, Diun, and Recyclarr retain their application-owned
  schedules;
- repository scripts remain authoritative for job behavior;
- `jobs/jobs.json` is authoritative for inventory and monitoring metadata.

This avoids a Docker socket mount. Healthchecks needs only inbound HTTP pings
and its own database. It has no ability to create containers or execute host
commands.

## What the dashboard means

An active check can show its declared schedule, timezone, grace period, current
status, last and next expected execution, start-to-finish duration, and ping
history. Jobs post a start signal, then a success or failure signal with a
short text body.

A `catalog-only` check is deliberately paused. It makes an application-owned
schedule visible without pretending Healthchecks can see runs that the
application does not report. Diun and Recyclarr start in this state.

Healthchecks cannot discover arbitrary internal application timers
passively. A schedule gains real execution history only after the owning
application, wrapper, or hook emits telemetry.

## Declarative registry

`jobs/jobs.json` contains every user-configured operational cron or launchd
timer currently in use. Each entry has:

- stable ID and display name;
- schedule authority and source file;
- command and purpose;
- cron expression or interval, always interpreted in `Europe/Madrid`;
- expected duration and missed-run grace;
- risk classification;
- active or catalog-only monitoring state.

There is no per-job ping variable: the job's stable ID doubles as its
Healthchecks check slug, and the reconciler writes a single shared
`HEALTHCHECKS_PING_KEY` into `config/healthchecks/ping-urls.env`.

Validate locally:

```bash
python3 scripts/healthchecks-reconcile.py \
  --registry jobs/jobs.json \
  --validate-only
```

Reconcile the live project:

```bash
docker compose exec healthchecks \
  python /opt/homelab/scripts/healthchecks-reconcile.py
```

The reconciler uses Management API v3, upserts by stable slug, pauses
catalog-only jobs, and writes `config/healthchecks/ping-urls.env`. It will not
delete unmanaged checks.

## Runtime and access

- Image: `healthchecks/healthchecks:v4.2`, pinned by multi-architecture digest.
- Private UI: `https://jobs.${STACK_HOST}.${PRIVATE_DOMAIN}`.
- Local-only port: `http://127.0.0.1:8008`.
- Database: SQLite in the `homelab_healthchecks-data` Colima named volume.
- Runtime secrets: `config/healthchecks` and `/data/secret-key`; all are
  gitignored.
- Registration is closed.
- Login: `${HEALTHCHECKS_ADMIN_EMAIL}` — use one canonical administrator
  identity for every service that demands an email address. Store the password
  in a password manager, not in this repo.
- Homepage receives only a project-scoped read-only API key through
  `config/healthchecks/homepage.env`.

The same-host launchd scripts ping loopback so they do not depend on private
DNS. Container jobs use `http://healthchecks:8000`. Browsers use Caddy HTTPS.

## Bootstrap

The signing key must exist in the named volume before first start:

```bash
docker volume create homelab_healthchecks-data
docker run --rm -u root -v homelab_healthchecks-data:/data alpine:3.22 \
  sh -c 'chown 999:999 /data && umask 077 && \
  head -c 48 /dev/urandom | base64 > /data/secret-key && \
  chown 999:999 /data/secret-key'
docker compose up -d healthchecks caddy
```

Create the administrator and project with a temporary password:

```bash
docker compose exec \
  -e HEALTHCHECKS_ADMIN_EMAIL="${HEALTHCHECKS_ADMIN_EMAIL}" \
  -e HEALTHCHECKS_ADMIN_PASSWORD='<temporary-password>' \
  healthchecks python /opt/homelab/scripts/healthchecks-bootstrap.py
```

Then reconcile, recreate Homepage so it reads its generated widget key, and
recreate the instrumented container schedulers so they read the ping key:

```bash
docker compose exec healthchecks \
  python /opt/homelab/scripts/healthchecks-reconcile.py
docker compose up -d --force-recreate homepage firefly-cron ghostfolio-ibkr-sync
```

Change the temporary password immediately after the first remote login.

## Instrumentation

The twelve legacy-named host jobs call `scripts/kuma-push.sh`, which sends
Healthchecks start/success/failure signals. The first argument is the legacy
Kuma env-var name callers still pass; it only selects the check slug. The
helper reads the project ping key from `config/healthchecks/ping-urls.env`
and builds `/ping/<key>/<job id>`; job ids are the Healthchecks check slugs.
It never logs the key.

Three Firefly host jobs (merchant normalization, category learning,
uncategorized alert) skip the shim and ping Healthchecks directly through
`scripts/firefly_lib.py`, using the same ping-key file and the loopback base
URL `http://127.0.0.1:8008`.

The Firefly and Ghostfolio container scripts send the same signals directly
with their container-network base URL (`http://healthchecks:8000`). Ping
failures are non-fatal: monitoring must never turn a successful business job
into a failed job.

Scheduled-job telemetry lives entirely in Healthchecks; Uptime Kuma is for
service and endpoint monitoring only. If you migrate from a Kuma-based setup,
retire its scheduled-job push monitors once Healthchecks has burned in.

## Backup and restore

The nightly backup stops Healthchecks during the database quiesce window and
exports the complete named volume to
`config/db-snapshots/healthchecks-volume_data.tgz` before restic runs.

Restore into an empty named volume:

```bash
docker compose stop healthchecks
docker volume create homelab_healthchecks-data
docker run --rm -u root \
  -v homelab_healthchecks-data:/data \
  -v "$PWD/config/db-snapshots:/snap:ro" \
  alpine:3.22 sh -c \
  'tar xzf /snap/healthchecks-volume_data.tgz -C /data && chown -R 999:999 /data'
docker compose up -d healthchecks
```

The generated API key and ping-key file (`ping-urls.env`) under
`config/healthchecks` are also covered by restic. If they are lost, rerun
bootstrap to rotate the API keys and then reconcile to regenerate
`ping-urls.env`.
