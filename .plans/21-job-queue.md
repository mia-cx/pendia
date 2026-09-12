# #21 Job queue

## Summary

Add Pendia's Postgres job queue using the existing jobs table and Drizzle on Bun.sql. Workers claim ready jobs, dispatch registered handlers, retry failures, and wake through NOTIFY with polling as a fallback. The worker and all roles run handlers. An admin service lists jobs.

Read CONTEXT.md, docs/spec/topology.md section Jobs, docs/adr/0013-own-postgres-job-queue.md, and docs/spec/plugin-api.d.ts before implementation. Follow apps/server/src/db and apps/server/README.md for database conventions.

## Acceptance criteria

- [x] Two workers claiming concurrently never take the same job.
- [x] A failing job retries with backoff and stops at max attempts with its error stored.
- [x] Run after delays a job until its time; priority orders ready jobs.
- [x] A concurrency key caps parallel jobs sharing it.
- [x] NOTIFY wakes an idle worker within 100 ms; without NOTIFY the poll still picks the job up.

## TODOs

- [x] Add enqueue, list, and atomic claim operations with shared disposable-database test support. Validate independent clients claiming concurrently, payload round-trips, descending priority, run-after eligibility, and schema test preservation. Validation results are in Notes.
- [x] Add completion and exponential retries with retained errors and attempt fencing. Validate increasing retry delays, no early retry, terminal failure at max attempts, success, and stale completion rejection.
- [x] Enforce a shared concurrency-key cap during claims. Validate racing clients against the same key, independent keys, unkeyed jobs, and capacity returning after completion or failure.
- [x] Add the typed handler registry and worker loop with NOTIFY and slow polling. Validate registered dispatch, unknown types staying queued, idle notification latency below 100 ms, polling without notification, retries, and graceful shutdown.
- [x] Start the worker in worker and all roles and drain it before database shutdown. Validate real registered handlers through role startup, no worker in other roles, and existing startup behavior.
- [x] Document queue use and run final repository validation. Validate frozen install, lint, typecheck, build, all tests against Postgres, and local skipping without DATABASE_URL. Record actual results below.

## Notes

- TODO 1 validation: Postgres queue and schema tests passed, 13 tests and 111 assertions. Server typecheck and focused Biome checks passed. Without DATABASE_URL, bun test passed 12 and skipped 13 with one message. With CI=true and no URL it failed as required. The first test execution was blocked by command permissions, so this TODO has green evidence but no observed red run.
- TODO 2 validation: red run failed all four new tests ("queue.fail is not a function", missing constructor throw) before implementation; after adding complete/fail, QueueOptions validation and the 60s cap, `bun test apps/server/src/jobs/queue.test.ts` passed 9 tests and 50 assertions against Postgres. `bun run --cwd apps/server check` and `bunx biome check apps/server/src/jobs` passed. Evidence: .devin/21-todo2-verification.log.
- TODO 3 validation: red run failed the three new tests (no limit validation, all 8 same-key jobs claimed, default cap ignored) before implementation; after adding `concurrencyLimit` and the running-count subquery (using the `from jobs as running_jobs` form because Drizzle renders a table alias without its base name), `bun test apps/server/src/jobs/queue.test.ts` passed 11 tests and 67 assertions against Postgres. `bun run --cwd apps/server check` and `bunx biome check apps/server/src/jobs` passed. Evidence: .devin/21-todo3-verification.log.
- TODO 4 validation: registry and worker dispatch each went red (module missing) then green; the remaining worker behaviors passed against the finished worker. `bun test apps/server/src/jobs` passed 18 tests and 87 assertions against Postgres; measured NOTIFY wake latency ~12 ms against the 100 ms bound, and the 200 ms poll claimed a directly inserted row without NOTIFY. `bun run --cwd apps/server check` and `bunx biome check apps/server/src/jobs` passed. Evidence: .devin/21-todo4-verification.log.
- TODO 5 validation: `bun test apps/server/src/roles.test.ts apps/server/src/index.test.ts apps/server/src/api.test.ts` passed 18 tests and 26 assertions against Postgres. Worker role runs handlers with no API server, all role migrates and serves /readyz while running jobs, api/transcoder/watcher leave jobs queued, and stop drains an active handler. `bun run --cwd apps/server check`, `bun run --cwd apps/server build` (bundled 123 modules, index.js 208.91 KB) and `bunx biome check` on the touched files passed. Evidence: .devin/21-todo5-verification.log.
- TODO 6 validation: Jobs section appended to apps/server/README.md. Final gate from repo root: `bun install --frozen-lockfile` clean (91 installs, no changes), `bun run lint` clean (46 files), `bun run check` 5/5 turbo tasks, `bun run build` 4/4, `bun test` with DATABASE_URL passed 44 tests and 203 assertions, `bun test` without DATABASE_URL passed 14 and skipped 30 with one message, `git diff --check` clean. Evidence: .devin/21-todo6-final-validation.log.

- Work only in this worktree on feat/21-job-queue. The parent committed the pre-existing .gitignore change as f9742ab. Never commit .devin.
- Each TODO includes its tests and one buildable commit with Refs #21. The plan is committed first.
- Public test boundaries are the queue service, worker lifecycle, and role startup. These implement the acceptance tests requested in the task. Database assertions use the admin listing service except schema-constraint tests.
- Keep the existing schema. Claims use SELECT FOR UPDATE SKIP LOCKED under a short transaction-scoped advisory lock. The lock serializes claim decisions across processes so concurrency counts cannot race. Handlers run after commit and remain parallel.
- Larger priority values run first. Equal priorities order by runAfter and UUID. Claims increment attempts. Failure queues a retry after 1 second times 2 raised to attempts minus 1, capped at 60 seconds. At maxAttempts it marks the job failed and keeps the error.
- The shared concurrency-key limit defaults to one and is a queue option. All workers for one queue must use the same limit. No key means no key-specific cap. Per-process worker parallelism is separate.
- Workers claim only registered types. The registry supports the five schema job types. Plugin cron scheduling remains with the future plugin host, per ADR 0013.
- Enqueue commits NOTIFY with the row. A listener is ready before the first drain. The fallback poll defaults to 5 seconds. Tests shorten explicit timing options but keep the notification test's poll far beyond its 100 ms deadline.
- No dashboard route, cron parser, lease recovery, heartbeat, new job columns, or additional Postgres client library belongs to this issue.
- Tests create and drop uniquely named databases on the supplied disposable server. A shared fixture prints one skip message without DATABASE_URL and throws in CI. Connection errors fail.
- Local Postgres uses pendia-test-pg-21 on port 55421 and DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55421/pendia. Remove that container after the final review validation.
- This run is unattended. Resolve ordinary design ambiguity here and continue. The parent merges the final pull request.
