# job-lease: #87 job leases, #65 scan-status indexes, #72 retryAfter flake

## Summary

A claimed job stays `running` forever when its holder dies (#87). Each claim now writes a fresh `claim_token` and a `lease_expires_at`. The holder renews the lease on a timer while its handler runs. A claim takes expired running jobs back as a new attempt, and a job that runs out of attempts that way fails with a lease error. Complete, fail and renew match the claim token, so an old holder's late answer changes nothing.

The same migration adds the two partial expression indexes that `libraryScanStatus` needs (#65).

The `retryAfter` test stores a whole-second `expiresAt`, so the `Math.ceil` bound cannot reach 301 (#72).

## Acceptance criteria

- [ ] A claimed job carries a lease that its holder renews while it runs. (#87)
- [ ] A job whose lease expires returns to the queue, or fails with a clear error, without a manual fix. (#87)
- [ ] A late answer from the old holder cannot settle the job after another claim took it. (#87)
- [ ] `jobs_scan_library_idx` and `jobs_scan_run_idx` exist on `jobs`. (#65)
- [ ] The `retryAfter` test asserts `<= 300` against a whole-second `expiresAt`. (#72)

## TODOs

- [ ] Schema and migration: `claim_token` and `lease_expires_at` on `jobs`, a running-lease index, and the two #65 scan indexes.
  - Validation: `bun run db:generate` output reviewed; migration applies on disposable Postgres.
- [ ] Queue: claim writes a token and lease and reclaims expired running jobs; complete, fail and renew match the token; exhausted expired jobs fail with a lease error; `hold` renews while a handler runs. Tests for reclaim, ignored late completion, and lease exhaustion.
  - Validation: `bun test apps/server/src/jobs` with `DATABASE_URL`.
- [ ] Worker and watcher: the worker runs handlers under `hold`; the watcher claim and report carry the claim token, and its scan heartbeat renews the lease.
  - Validation: `bun test apps/server/src/jobs apps/server/src/watcher` with `DATABASE_URL`.
- [ ] Docs: README jobs and watcher sections, topology spec columns.
  - Validation: read the rendered sections.
- [ ] #72: floor the stored `expiresAt` to whole seconds and restore the `<= 300` bound.
  - Validation: the focused test passes 20 times against disposable Postgres.
- [ ] Full gate: install, lint, check, build, tests with and without `DATABASE_URL`.

## Notes

- Test Postgres runs on 127.0.0.1:55574, not 55564: RootlessKit reported 55564 in use with nothing listening on it.
- `claim_token` is `uuid not null default gen_random_uuid()`, so the type is never null and existing rows backfill. `lease_expires_at` is `timestamptz not null default now()`, so rows running at migration time count as expired and the next claim takes them back.
- Only running jobs with a live lease count toward a concurrency key. Otherwise an expired job would block its own reclaim.
- Reclaiming a job records `Job lease expired.` as its error, the way a retried failure keeps its error.
- The watcher already posts a heartbeat every poll interval during a scan. That heartbeat now carries the job id and claim token and renews the lease; a 409 answer means the watcher lost the job.
