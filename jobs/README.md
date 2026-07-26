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

Reconciliation upserts by stable `id`, updates descriptions and schedules, and
generates the gitignored `config/healthchecks/ping-urls.env`. It does not delete
unmanaged checks. Jobs marked `catalog-only` are created paused because their
current application schedulers do not expose a reliable per-run completion
hook; showing them as healthy would be false.
