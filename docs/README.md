# Docs index

Start with the root `README.md` (what the stack is), then [setup.md](setup.md)
to stand it up, then [conventions.md](conventions.md) for the rules that keep it
working.

## The documents

| Doc | What it is |
|---|---|
| [setup.md](setup.md) | Standing the stack up on a fresh machine, phase by phase |
| [conventions.md](conventions.md) | Hard rules, conventions, common tasks — the operating manual |
| [job-monitoring.md](job-monitoring.md) | Scheduled-job monitoring: Healthchecks setup, instrumentation, restore |
| [wiki-system.md](wiki-system.md) | The wiki module: sync spine, vault layout, agent skills, Obsidian plugin |

## Who is authoritative for what

One home per fact. Docs link instead of copying — copies are how drift starts.

- Scheduled jobs (ids, schedules, grace, risk): `jobs/jobs.json`. Prose about
  the system: job-monitoring.md.
- Container stack (services, images, ports, volumes): `docker-compose.yml`.
- Clean URLs: `Caddyfile`. DNS rewrites live in AdGuard or your resolver.
- Environment variables: `.env.example` — every key, placeholders only.
- Wiki agent behavior: `config/wiki-agent/skills/*` plus the vault's own
  `AGENTS.md`; wiki-system.md describes them, they decide.
- Machine facts (hostnames, addresses, personal accounts): your `AGENTS.md`.
  Nothing machine-specific belongs in compose, Caddyfile, scripts, or
  `.env.example`.

## Conventions

- Every doc carries a `Last verified: YYYY-MM-DD` line near the top — the date
  someone last checked its claims against a running system, not the last edit.
- Specs that ship get their status updated to as-built; dead plans move to a
  history section rather than lingering as instructions.
- Incidents get a postmortem named `YYYY-MM-DD-slug.md` under `docs/postmortems/`;
  durable rules from them belong in config or scripts with a comment citing the
  postmortem. This template ships the rules, not the incident history behind
  them.
