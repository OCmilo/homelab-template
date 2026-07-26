# Homelab stack

An AI agent working in this repo should read [`docs/conventions.md`](docs/conventions.md)
first: it holds the hard rules (Colima/SQLite, hardlink layout, VPN namespace,
no public exposure) and the conventions for changes, jobs, and secrets.
[`docs/setup.md`](docs/setup.md) covers standing the stack up from scratch, and
[`docs/README.md`](docs/README.md) indexes the rest.

## Machine facts belong here

This file is where a fork records its own environment — hostname, LAN and
Tailscale addresses, repo path, storage layout, admin identities, which optional
modules are enabled. Nothing machine-specific belongs in `docker-compose.yml`,
`Caddyfile`, `scripts/`, or `.env.example`: those are parameterized through
`.env` (`STACK_HOST`, `STACK_NAME`, `LAN_IP`, `TAILSCALE_IP`, `DATA_ROOT`, and
the rest) so the stack stays portable.

Replace this section with your own:

- Hardware, OS, and where Docker runs (Colima profile).
- Host and addresses used for SSH and remote access.
- Repo path and `${DATA_ROOT}`.
- Which modules you run (video, books, documents, bookmarks, wiki, finance).
- Anything an agent must confirm with you before touching (keys, router,
  partitioning).

## Stack summary

See the root `README.md` for what each service does, and `docker-compose.yml`
for the authoritative list. Keep a short summary here once you have pruned the
services you do not want.
