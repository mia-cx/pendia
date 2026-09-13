# #55 Make the NOTIFY wakeup and rate-limit tests deterministic

## Summary

Replace narrow wall-clock assertions in the job worker NOTIFY test and the auth rate-limit retry test. Keep each test focused on the behavior it protects while allowing for loaded CI runners.

## Acceptance criteria

- [ ] Both tests pass ten times in a row on CI without a re-run.
- [x] The NOTIFY test still proves a wakeup happens without the slow poll.
- [x] Each affected test passes twenty times in a row against disposable Postgres.
- [x] The repository lint, typecheck, build, database-backed test, and database-free test gates pass.

## TODOs

- [x] Rewrite the job worker test to prove NOTIFY handles the job before the ten-second poll fallback.
  - Validation: run the focused NOTIFY wakeup test against disposable Postgres.
- [x] Give the blocking auth counter a CI-safe controlled lifetime while still proving the nonblocking counter cannot set `retryAfterSeconds`.
  - Validation: run the focused `retryAfter` test against disposable Postgres.
- [x] Prove repeated and repository-wide stability, then record the real results here.
  - Validation: run each affected test twenty times, then run the full requested gate with and without `DATABASE_URL`.

## Notes

- This run is unattended. Reasonable test-only choices will be made without an approval pause.
- The NOTIFY test will retain a timeout only as a deadlock guard. A two-second guard remains well below its ten-second poll interval, so completion proves the notification caused the wakeup without treating 100 ms as a performance contract.
- The rate-limit test will widen its controlled blocking lifetime from ten seconds to five minutes. That remains below the fresh nonblocking counter's 900-second lifetime, preserves the causal assertion, and gives a loaded runner enough scheduling margin.
- `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55455/pendia bun test apps/server/src/jobs/worker.test.ts -t "wakes an idle worker through NOTIFY before the poll fallback"`: 1 pass, 7 filtered out, 0 fail.
- `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55455/pendia bun test apps/server/src/auth/rate-limit.test.ts -t "retryAfter comes only from the counters actually blocking"`: 1 pass, 7 filtered out, 0 fail.
- Worker focused loop: 20/20 fresh `bun test` invocations passed, 0 failed (`/tmp/issue55-worker-20.log`).
- Rate-limit focused loop: 20/20 fresh `bun test` invocations passed, 0 failed (`/tmp/issue55-rate-limit-20.log`).
- `bun install --frozen-lockfile`: exit 0, checked 116 installs across 219 packages, no changes (`/tmp/issue55-bun-install.log`).
- `bun run lint`: exit 0, Biome checked 89 files, no fixes applied (`/tmp/issue55-lint.log`).
- `bun run check`: exit 0, 6/6 turbo tasks successful (3 cached), 3.039s; svelte-check 0 errors, 0 warnings (`/tmp/issue55-check.log`).
- `bun run build`: exit 0, 4/4 turbo tasks successful (3 cached), 1.943s (`/tmp/issue55-build.log`).
- `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55455/pendia bun test`: exit 0, 392 pass, 0 fail, 1199 expect() calls, 25 files, 47.14s (`/tmp/issue55-db-test.log`).
- `bun test` without `DATABASE_URL`: exit 0, 276 pass, 116 skip, 0 fail, 475 expect() calls, 25 files, 147ms (`/tmp/issue55-no-db-test.log`).
- The ten-consecutive-CI criterion is supported by twenty consecutive local fresh-process passes plus the deterministic assertion design; no GitHub-hosted runs have occurred yet. GitHub-hosted CI remains pending until the PR is filed.
- Codex review flagged that warmup completion plus a fixed sleep did not prove the worker had parked in `wait()`, so the test now resolves an `idle` promise when a `setTimeout` spy observes the ten-second poll timer installed after the warmup handler ran.
- Worker focused loop after idle synchronization: 20/20 fresh `bun test` invocations passed, 0 failed (`/tmp/issue55-worker-20-idle-sync.log`).
- `bun run lint` (review baseline): exit 0, Biome checked 89 files, no fixes applied (`/tmp/issue55-review-lint.log`).
- `bun run check` (review baseline): exit 0, 6/6 turbo tasks successful (3 cached), 3.011s; svelte-check 0 errors, 0 warnings (`/tmp/issue55-review-check.log`).
- `bun run build` (review baseline): exit 0, 4/4 turbo tasks successful (3 cached), 1.758s (`/tmp/issue55-review-build.log`).
- `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55455/pendia bun test` (review baseline): exit 0, 392 pass, 0 fail, 1199 expect() calls, 25 files, 45.06s (`/tmp/issue55-review-db-test.log`).
- `bun test` without `DATABASE_URL` (review baseline): exit 0, 276 pass, 116 skip, 0 fail, 475 expect() calls, 25 files, 148ms (`/tmp/issue55-review-no-db-test.log`).
