# #55 Make the NOTIFY wakeup and rate-limit tests deterministic

## Summary

Replace narrow wall-clock assertions in the job worker NOTIFY test and the auth rate-limit retry test. Keep each test focused on the behavior it protects while allowing for loaded CI runners.

## Acceptance criteria

- [ ] Both tests pass ten times in a row on CI without a re-run.
- [ ] The NOTIFY test still proves a wakeup happens without the slow poll.
- [ ] Each affected test passes twenty times in a row against disposable Postgres.
- [ ] The repository lint, typecheck, build, database-backed test, and database-free test gates pass.

## TODOs

- [ ] Rewrite the job worker test to prove NOTIFY handles the job before the ten-second poll fallback.
  - Validation: run the focused NOTIFY wakeup test against disposable Postgres.
- [ ] Give the blocking auth counter a CI-safe controlled lifetime while still proving the nonblocking counter cannot set `retryAfterSeconds`.
  - Validation: run the focused `retryAfter` test against disposable Postgres.
- [ ] Prove repeated and repository-wide stability, then record the real results here.
  - Validation: run each affected test twenty times, then run the full requested gate with and without `DATABASE_URL`.

## Notes

- This run is unattended. Reasonable test-only choices will be made without an approval pause.
- The NOTIFY test will retain a timeout only as a deadlock guard. A two-second guard remains well below its ten-second poll interval, so completion proves the notification caused the wakeup without treating 100 ms as a performance contract.
- The rate-limit test will widen its controlled blocking lifetime from ten seconds to five minutes. That remains below the fresh nonblocking counter's 900-second lifetime, preserves the causal assertion, and gives a loaded runner enough scheduling margin.
