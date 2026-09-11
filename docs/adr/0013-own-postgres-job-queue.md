---
status: accepted
date: 2026-09-11
---

# A job queue of Pendia's own on Postgres

pg-boss and graphile-worker are the obvious choices. Both run on the `pg` driver, which would sit next to Bun.sql as a second Postgres client with its own pool, and neither offers the per-library concurrency cap that keeps probes from flooding NFS. Pendia keeps one jobs table claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, with priority, attempts, run after and a concurrency key. About a hundred lines that the team understands fully.

## Consequences

Features a library would have given for free, such as a dashboard or cron expressions, are added only when a job needs them. Scheduled plugin jobs use `Bun.cron` inside the host instead.
