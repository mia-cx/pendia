# Pendia server

## Database

Run these commands from the repository root. This separate Compose project starts only disposable Postgres on port 55433.

```sh
docker compose -p pendia-db-test -f compose.yaml -f compose.test.yaml up -d --wait postgres
DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55433/pendia bun test
docker compose -p pendia-db-test -f compose.yaml -f compose.test.yaml down -v
```

Tests create and drop unique databases on that server. They leave the database named in DATABASE_URL intact.
The test role needs CREATEDB and permission to install pg_trgm and btree_gist. The Compose role has these permissions.
Missing DATABASE_URL skips database tests locally and fails in CI. Connection errors always fail.

After changing the Drizzle schema, generate the next migration:

```sh
bun run --cwd apps/server db:generate
```

Review and commit the SQL and metadata under apps/server/drizzle together.
Hand-written SQL handles the boundary validator, File and Stream origin rules, source timeline agreement and episode-range exclusion.
It also limits SET NULL to version_id on progress.
Timeline boundaries are immutable. Different boundaries need a new timeline row.
Preserve these rules when a generated migration changes their constraints.

The api and all roles apply pending migrations before listening. Other roles do not migrate.
The runner reserves one Postgres connection and holds a shared advisory lock through migrations and built-in group seeding.
Concurrent runners wait their turn. Repeated runs are no-ops. Migration failure stops startup.

Source and dist resolve apps/server/drizzle. Compiled distributions need the drizzle directory beside the binary.
The Dockerfile packages these assets. Compose checks readiness after startup completes.

## Jobs

Register module handlers with `jobRegistry.register(type, handler)` from `src/jobs/registry.ts` before startup.
The handler receives its typed payload and the claimed job. Register one handler for each supported job type.
The worker and all roles run registered handlers. Other roles leave queued jobs alone.
The api and all roles migrate first. A standalone worker needs an already migrated database.

Use `createJobQueue(db).enqueue(payload, options)` from `src/jobs/queue.ts` to enqueue work.
Options are priority, maxAttempts, runAfter, and concurrencyKey. The type comes from the payload.
Higher priority runs first. Equal priorities order by runAfter and then id.
`listJobs(db, { state, type, limit, offset })` lists jobs for the admin, newest first, with a default limit of 100.

Claims use FOR UPDATE SKIP LOCKED under a short shared advisory lock. Handlers run outside the transaction.
The key limit defaults to one. All workers sharing a queue must use the same concurrencyLimit option.
Jobs without a key have no key-specific cap. Worker concurrency defaults to four.

Claims increment attempts. Failures retry after one second, then two, doubling to a sixty-second cap.
The default maxAttempts is three. Exhausted jobs stay failed with their error stored.
Completion and failure only update the matching running attempt. A later successful attempt retains the previous error.

Enqueue commits the row and NOTIFY together. LISTEN wakes idle workers; a five-second poll catches missed notifications and future jobs.
A local timer wakes the worker when its failed job becomes eligible again.
`startJobWorker` accepts concurrency, pollIntervalMs, queueOptions, and onError options.
`startPendia` accepts workerOptions and an optional registry for an embedded server.
On SIGTERM, shutdown stops new claim loops and drains active handlers before closing Postgres.
Abrupt process loss does not recover running jobs in this slice. Handlers must be safe to retry after a reported failure.
Plugin cron scheduling belongs to the plugin host, not this queue.
