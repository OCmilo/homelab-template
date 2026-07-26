# Scheduled Jobs Registry

`jobs.json` is the source of truth for operational schedules across launchd,
container cron, and application-owned cron. It describes who owns each
schedule, the exact source and command, its expected timing, risk, and whether
execution telemetry is active.

Validate the registry without touching the live service:

```bash
python3 scripts/healthchecks-reconcile.py \
  --registry jobs/jobs.json \
  --validate-only
```

The live reconciliation runs inside the Healthchecks container so the
management API key never needs to leave `config/healthchecks`:

```bash
docker compose exec healthchecks \
  python /opt/homelab/scripts/healthchecks-reconcile.py
```

Every job carries a `module` naming the `COMPOSE_PROFILES` entry that owns it,
or `core` for jobs that run regardless. It may be a list when a job spans two
modules, in which case all of them must be enabled.

`scripts/install-jobs.sh` installs only the agents whose modules are enabled and
unloads the rest. The reconciler still upserts every job, but pauses the checks
of disabled ones — it never deletes, so skipping them outright would leave the
old checks alerting forever.

`monitoring` is one of `active`, `catalog-only`, or `muted`. Setting `muted` is
how you stop a job alerting while leaving it running: this file decides what
alerts, so pausing a check in the web UI is undone by the next reconcile.

Agents that are not timers carry `"schedule": {"type": "daemon"}`. They are
listed so module filtering can install and remove them, and they get no check:
a KeepAlive process has no per-run completion to report.

Reconciliation upserts by stable `id`, updates descriptions and schedules, and
generates the gitignored `config/healthchecks/ping-urls.env`. It does not delete
unmanaged checks. Jobs marked `catalog-only` are created paused because their
current application schedulers do not expose a reliable per-run completion
hook; showing them as healthy would be false.
