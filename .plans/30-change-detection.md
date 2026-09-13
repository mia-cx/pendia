# #30 Change detection: arr webhooks, nightly and startup walk

## Summary

Add Sonarr and Radarr webhook change signals, coalesce them into directory scan jobs, reconcile moves and deletes without losing progress, and run a directory-mtime repair pass at startup and every 24 hours. Keep the existing authenticated manual scan.

## Acceptance criteria

- [ ] Recorded Sonarr and Radarr payloads produce the right add, move and delete events, tested from fixtures.
- [ ] A rename keeps the Item's progress; a delete removes the Version and the Item when it was the last one.
- [ ] A burst of events for one directory becomes one scan job.
- [ ] The walk finds a file added out of band on a fixture tree.
- [ ] A wrong secret answers 401.

## TODOs

- [x] Record Sonarr and Radarr webhook fixtures and translate import, rename, file delete and item delete payloads into typed change events.
  - Validation: `bun test apps/server/src/libraries/servarr.test.ts`
- [x] Accept Sonarr and Radarr webhooks through API-key secrets in the URL and coalesce each directory's events for 10 seconds into one scan job.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/webhooks.test.ts`
- [ ] Apply queued add, move and delete changes during directory scans, persist provider ids, preserve Item progress on rename and remove the last empty Item on delete.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/changes.test.ts apps/server/src/libraries/scan.test.ts`
- [ ] Add the directory-mtime repair pass and run it after startup and every 24 hours while retaining the manual scan.
  - Validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/repair.test.ts apps/server/src/api/libraries.test.ts`
- [ ] Document webhook setup, change reconciliation and repair scheduling in the server README.
  - Validation: `bun run lint && bun run check`
- [ ] Run the complete repository validation and record the real results below.
  - Validation: `bun install --frozen-lockfile`; `bun run lint`; `bun run check`; `bun run build`; `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test`; `bun test`

## Notes

- TODO 1 validated: `bun test apps/server/src/libraries/servarr.test.ts` → 11 pass, 0 fail, 24 expect() calls; `bun run --cwd apps/server check` → clean (tsc --noEmit, no errors).
- TODO 2 validated: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55430/pendia bun test apps/server/src/libraries/webhooks.test.ts` → 9 pass, 0 fail, 40 expect() calls; `bun run --cwd apps/server check` → clean; `bunx biome check` on webhooks.ts, webhooks.test.ts, api.ts, index.ts, operations.ts → clean after one format pass.
- The unattended run cannot confirm test seams. Tests use the public payload translators, HTTP webhook handler, queued scan handler, repair pass and existing library API.
- Webhook routes are `/api/webhooks/sonarr/<secret>` and `/api/webhooks/radarr/<secret>`. Only a live API-key token is accepted as the secret. Session tokens are rejected.
- The 10 second debounce is process-local until it writes one durable scan job. Shutdown flushes accepted events before closing the database.
- “Nightly” uses one 24 hour interval from startup. The startup pass runs in the background so API readiness does not wait for the walk.
- The repository has no Servarr research file. Fixtures follow the current upstream `WebhookBase`, payload and renamed-file classes referenced by Sonarr and Radarr source.
- The branch starts from `0e8ac31c3bc26dc280efd84e09df04752b634de1` with a clean worktree.
