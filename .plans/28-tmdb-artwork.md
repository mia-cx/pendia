# #28 TMDB provider, artwork store and artwork serving

## Summary

Add the in-tree TMDB provider for movies and connect it to scans through the provider-fetch job. Match by a stored TMDB provider id or by title and year above a confidence threshold. Persist matched metadata, Contributors, Credits and one selected poster. Store the original poster in the Item's colocated `.pendia` folder. Serve resized artwork with Sharp, an ETag, a process-local cache and the auth setting from the artwork spec.

## Acceptance criteria

- [ ] A scanned fixture movie receives TMDB metadata, credits and a poster; an ambiguous title lands in the unmatched state.
- [ ] Artwork is served resized with an ETag, and a repeat request hits the local cache.
- [ ] Anonymous artwork works by default and the toggle enforces auth.
- [ ] Provider calls are mocked in tests; the TMDB key lives in settings.

## TODOs

- [ ] 1. Add metadata and artwork settings plus persisted match state.
  - Add an Item metadata state with `pending`, `matched` and `unmatched` values. Generate and review the Drizzle migration.
  - Read the `metadata` settings row as `{ providerOrder, confidenceThreshold, libraries, tmdb }`. Missing library entries enable the ordered providers. An empty library list disables metadata for that library.
  - Add `artworkRequiresAuth`, defaulting to false, to the existing `auth` settings object.
  - Validation: disposable Postgres tests cover defaults, configured provider order, per-library enablement, the TMDB key, the confidence threshold and artwork auth validation. Run server typecheck and build.
- [ ] 2. Implement the TMDB movie provider on the plugin metadata contract.
  - Implement `MetadataProvider.search` and `MetadataProvider.fetch` for movies. Decode TMDB responses at the HTTP boundary without `any`.
  - Search by title and optional year. Derive confidence from normalized title and year agreement. Fetch details, credits, content rating, provider ids and original artwork URLs.
  - Validation: mocked HTTP tests cover request parameters, decoded matches, metadata, Contributors and Credits input, provider ids, artwork URLs and malformed or failed responses. Run server typecheck and build.
- [ ] 3. Match and persist movie metadata in provider order.
  - Add a metadata service that tries enabled providers in configured order. Use an existing provider id before search. Accept one unique best result only when it meets the configured threshold. Persist `unmatched` otherwise.
  - On a match, replace provider-owned Item metadata, provider ids and Credits transactionally. Reuse Contributors by exact name when possible.
  - Validation: disposable Postgres tests cover provider-id matching, title-year matching, provider order, disabled libraries, threshold rejection, ambiguous best results, idempotent Credits and unmatched state. Run server typecheck and build.
- [ ] 4. Connect scans to provider jobs and store poster originals colocated.
  - Parse Radarr provider suffixes into provider-id rows during a movie scan. Enqueue one provider-fetch job after each successful directory scan and register its built-in worker handler without overriding supplied handlers.
  - Download the selected poster through the injected provider HTTP client. Store its original bytes at `<canonical-folder>/.pendia/artwork/<artwork-id>` and persist the selected colocated artwork row.
  - Validation: a real scan fixture plus mocked provider HTTP calls receives metadata, Credits, provider ids and a poster in its Item folder. Job tests cover registration, retries through thrown failures and no provider call when the library disables providers. Run server typecheck and build.
- [ ] 5. Serve resized artwork with cache, ETag and optional auth.
  - Add Sharp at a pinned release older than seven days. Serve `GET /api/artwork/{id}?width=<pixels>` from the API role for selected colocated artwork.
  - Validate width and storage paths. Resize without enlargement. Return an ETag and honor `If-None-Match`. Cache resized bytes per process and invalidate them when the original changes.
  - Allow anonymous requests by default. When `artworkRequiresAuth` is true, require the existing bearer token or session cookie.
  - Validation: real HTTP and Sharp tests cover dimensions, ETag and 304 behavior, one resize across repeat requests, cache invalidation, invalid input, anonymous default and enforced auth. Run server typecheck and build.
- [ ] 6. Complete acceptance coverage and run final repository checks.
  - Review each acceptance criterion against public-boundary tests. Document settings, matching, the provider-fetch job, the colocated artwork layout and the artwork route in `apps/server/README.md`.
  - Run from the repository root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55428/pendia bun test`, and `env -u DATABASE_URL bun test`.
  - Confirm database tests fail in CI without `DATABASE_URL`. Remove only the task's disposable Postgres container after the review loop ends.
  - Validation: all commands pass, local database omission prints the existing single skip message, and Notes record real results and blockers.

## Notes

- This run is unattended. The lead owns design, review, commits, pushes, comments and the pull request. The authorized SWE-2 sidekick implements each TODO and runs its focused checks. No other agent or CLI worker runs.
- Work stays in `/home/mia/mia-cx/pendia/.worktrees/tmdb` on `feat/28-tmdb-artwork`. Each TODO gets one buildable commit with `Refs #28`. Never commit `.devin`.
- Test seams are metadata settings, the plugin `MetadataProvider` contract, metadata application, queue dispatch and the artwork HTTP route. These are the repository's public module boundaries. This unattended plan fixes those seams before tests are written.
- The repository does not name a settings JSON shape. Use the `metadata` row with `providerOrder: string[]`, `confidenceThreshold: number`, `libraries: Record<libraryId, string[]>`, and `tmdb: { apiKey: string } | null`. Defaults are `['tmdb']`, `0.9`, inherited ordered providers per library and no key. An explicit empty library list disables providers.
- The repository does not name the auth field. Use `artworkRequiresAuth: boolean`, default false, because it states the enforced behavior directly.
- A unique highest-confidence result at or above the threshold matches. Tied best results are ambiguous and become `unmatched`, even above the threshold.
- TMDB folder ids take the exact-match path. Other parsed provider ids remain stored, but this slice has no provider that can resolve them.
- The colocated storage key is library-relative and remains under `<canonical-folder>/.pendia/artwork/`. Configured-path and S3 backends remain future work, as issue #28 asks for the colocated backend.
- The artwork route uses the artwork row id. Width is a required positive integer capped at 4096. Sharp preserves the source format and never enlarges it.
- Local Postgres uses the requested `pendia-test-pg-28` container and port 55428. Tests create disposable databases and leave the named database untouched.
- Before filing and before every review push, rebase on `origin/main`. Resolve conflicts in favor of merged code. Never force-push.
- Initial repository state is clean at `0e8ac31`, equal to `origin/main`. Issue #25 is closed and its scan pipeline is present.
