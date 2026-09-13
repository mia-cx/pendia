# #30 Change detection: arr webhooks, nightly and startup walk

## Summary

Add Sonarr and Radarr webhook change signals, coalesce them into directory scan jobs, reconcile moves and deletes without losing progress, and run a directory-mtime repair pass at startup and every 24 hours. Keep the existing authenticated manual scan.

## Acceptance criteria

- [x] Recorded Sonarr and Radarr payloads produce the right add, move and delete events, tested from fixtures.
- [x] A rename keeps the Item's progress; a delete removes the Version and the Item when it was the last one.
- [x] A burst of events for one directory becomes one scan job.
- [x] The walk finds a file added out of band on a fixture tree.
- [x] A wrong secret answers 401.

## TODOs

- [x] Record Sonarr and Radarr webhook fixtures and translate import, rename, file delete and item delete payloads into typed change events.
  - Validation: `bun test apps/server/src/libraries/servarr.test.ts`
- [x] Accept Sonarr and Radarr webhooks through API-key secrets in the URL and coalesce each directory's events for 10 seconds into one scan job.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/webhooks.test.ts`
- [x] Apply queued add, move and delete changes during directory scans, persist provider ids, preserve Item progress on rename and remove the last empty Item on delete.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/changes.test.ts apps/server/src/libraries/scan.test.ts`
- [x] Add the directory-mtime repair pass and run it after startup and every 24 hours while retaining the manual scan.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/repair.test.ts apps/server/src/api/libraries.test.ts`
- [x] Document webhook setup, change reconciliation and repair scheduling in the server README.
  - Validation: `bun run lint && bun run check`
- [x] Run the complete repository validation and record the real results below.
  - Validation: `bun install --frozen-lockfile`; `bun run lint`; `bun run check`; `bun run build`; `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test`; `bun test`

## Notes

- TODO 1 validated: `bun test apps/server/src/libraries/servarr.test.ts` → 11 pass, 0 fail, 24 expect() calls; `bun run --cwd apps/server check` → clean (tsc --noEmit, no errors).
- TODO 2 validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/webhooks.test.ts` → 9 pass, 0 fail, 40 expect() calls; `bun run --cwd apps/server check` → clean; `bunx biome check` on webhooks.ts, webhooks.test.ts, api.ts, index.ts, operations.ts → clean after one format pass.
- TODO 3 validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/changes.test.ts apps/server/src/libraries/scan.test.ts apps/server/src/libraries/jobs.test.ts apps/server/src/libraries/walker.test.ts` → 29 pass, 0 fail, 162 expect() calls; `bun run --cwd apps/server check` → clean; `bunx biome check` on changes.ts, changes.test.ts, scan.ts, scan.test.ts, jobs.ts, walker.ts, walker.test.ts → clean after one format pass.
- TODO 4 validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/repair.test.ts apps/server/src/libraries/walker.test.ts apps/server/src/api/libraries.test.ts` → 24 pass, 0 fail, 116 expect() calls; `bun run --cwd apps/server check` → clean; `bunx biome check` on repair.ts, repair.test.ts, walker.ts, walker.test.ts, index.ts → clean after one format pass; full `bun test apps/server/src/libraries/` + api libraries run → 74 pass, 0 fail, 384 expect() calls.
- TODO 5 validated: `bun run lint` → `biome check .` clean, 128 files; `bun run check` → `turbo run check` 6 tasks successful, 0 errors or warnings.
- TODO 6 validated: `bun install --frozen-lockfile` → 116 installs across 219 packages, no changes; `bun run lint` → `biome check .` clean, 128 files, no fixes; `bun run check` → `turbo run check` 6 tasks successful, svelte-check 0 errors and 0 warnings; `bun run build` → `turbo run build` 4 tasks successful; `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test` → 525 pass, 0 fail, 1744 expect() calls across 38 files in 66.60s; `env -u DATABASE_URL bun test` → 358 pass, 167 skip, 0 fail, 704 expect() calls, with the one skip message "Skipping database tests: set DATABASE_URL to a test Postgres server." No warnings beyond expected role lifecycle logs. The first database run exposed two branch-caused failures fixed here: shutdown now stops the API listener first but awaits its drain after the event broker so an open event stream cannot deadlock stop, and two repair tests now snapshot the queue after stop before asserting no growth.
- PR #61 review fixes validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test` on servarr, webhooks, changes, repair, jobs, scan and walker test files → 69 pass, 0 fail, 329 expect() calls; `bun run --cwd apps/server check` → clean; `bun run lint` → `biome check .` clean, 130 files, after one format pass on 4 files. Fixed review failure modes: `MissingLibraryPathError` now scopes missing paths as root, requested or entry so scans rethrow unavailable roots and vanished entries instead of deleting rows; SeriesDelete and MovieDelete honor `deletedFiles: false` and reject non-boolean values; the debouncer drains active submissions during close; failed delayed enqueues retain and retry the ordered batch until close; a move reconciles a destination Item scanned during the rename debounce; repair tracks enqueued job ids and re-enqueues failed or missing jobs; manual root scans fan out to Item folders missing from the walk.
- PR #61 review follow-up validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/walker.test.ts apps/server/src/libraries/changes.test.ts apps/server/src/libraries/scan.test.ts` → 34 pass, 0 fail, 190 expect() calls; `bun run --cwd apps/server check` → clean; `bun run lint` → `biome check .` clean, 144 files, after one format pass on walker.test.ts. Fixed review failure mode: `resolveEntry` re-stats the root on any descendant ENOENT and upgrades the error to root scope when the root vanished or was replaced (dev or ino changed), so a TOCTOU root loss cannot be misclassified as a deleted Item folder.
- Shows/keyframe integration after rebase onto merged #58 and #59: `scanShowDirectory` takes `ScanDirectoryOptions`, applies queued changes inside the locked transaction, resolves Show Items by folder and provider ids with the movie conflict rule, deletes an emptied show subtree, and cleans Version-emptied leaf Items; Sonarr file events queue the top-level show folder and a database-backed endpoint test proves a Sonarr Download scans end to end. Validated: webhooks, changes, jobs, scan and walker tests → 59 pass, 0 fail, 426 expect() calls; `bun run --cwd apps/server check` → clean; `bun run lint` → clean, 157 files, after one format pass.
- The unattended run cannot confirm test seams. Tests use the public payload translators, HTTP webhook handler, queued scan handler, repair pass and existing library API.
- Webhook routes are `/api/webhooks/sonarr/<secret>` and `/api/webhooks/radarr/<secret>`. Only a live API-key token is accepted as the secret. Session tokens are rejected.
- The 10 second debounce is process-local until it writes one durable scan job. Shutdown flushes accepted events before closing the database.
- “Nightly” uses one 24 hour interval from startup. The startup pass runs in the background so API readiness does not wait for the walk.
- The repository has no Servarr research file. Fixtures follow the current upstream `WebhookBase`, payload and renamed-file classes referenced by Sonarr and Radarr source.
- The branch starts from `0e8ac31c3bc26dc280efd84e09df04752b634de1` with a clean worktree.
