# #29 TVDB provider and weekly refresh

## Summary

Add the in-tree TVDB provider on the plugin `MetadataProvider` contract for shows, seasons and episodes. Show scans parse folder provider ids and enqueue the same provider-fetch job movies use. One provider-fetch job for a Show matches the Show, then its Seasons and Episodes, and stores each Item's primary artwork: a poster for Shows and Seasons, a thumb for Episodes. After every Show fetch, a continuing Show keeps exactly one provider-fetch queued a week ahead; any other status keeps none. Admins get a manual refresh procedure that queues one Item's fetch on demand.

## Acceptance criteria

- [ ] A scanned fixture show receives show, season and episode metadata and artwork.
- [ ] The refresh job is scheduled weekly for continuing shows only.
- [ ] Manual refresh re-fetches one show on demand.

## TODOs

- [ ] 1. Share the provider HTTP and JSON decoding helpers.
  - Move TMDB's bounded JSON request, decoders and title normalization into `metadata/provider-http.ts`, parameterized by the provider label so error messages stay `TMDB ...`.
  - Validation: `tmdb.test.ts` passes unchanged; server check and build.
- [ ] 2. Implement the TVDB provider for shows, seasons and episodes.
  - Extend the plugin contract in both `plugin-api.d.ts` copies: `search` takes an optional `show` context (parent Show provider ids, season and episode numbers); `MetadataResult` gains optional `releaseDate`, `lastAirDate` and `status`.
  - `metadata/tvdb.ts`: log in once per provider instance with the API key and optional PIN. Shows match by IMDb remote id, then title and year search with TMDB's confidence rules. Seasons and Episodes match by number in the official (aired) order. Fetch decodes series extended records, official seasons and paged episodes, caching them per instance so one Show job costs a few requests. A 404 resolves null.
  - Validation: mocked HTTP tests cover login, search, numbers, fetch shapes, caching, artwork, credits, status and malformed or failed responses; check and build.
- [ ] 3. Persist Show, Season and Episode metadata.
  - `applyMetadata` passes the Show context to Season and Episode searches and writes `releaseDate`, `lastAirDate` and `status` into the kind tables in the same transaction. Default provider order becomes `["tmdb", "tvdb"]`.
  - Validation: disposable Postgres tests cover Season and Episode matching by number, kind-table fields, and unchanged movie behavior.
- [ ] 4. Run Show trees through provider-fetch.
  - Shared `{tvdb-…}` folder id parsing for movies and shows; show scans fill folder ids and enqueue provider-fetch for pending Shows like movie scans.
  - The provider-fetch handler builds TVDB from the `tvdb` and `tvdb-pin` provider keys, matches the Show, then its Seasons and Episodes, and stores each Item's primary artwork. A failure in the tree marks the Show pending and throws for a retry. Storing a `tvdb` key requeues unmatched Shows.
  - Validation: a scanned fixture show with mocked TVDB and image HTTP receives Show, Season and Episode metadata and artwork (AC 1).
- [ ] 5. Schedule the weekly refresh for continuing Shows.
  - After every Show fetch, success or failure, a continuing Show keeps one queued provider-fetch a week ahead and any other status keeps none. Scans and manual refreshes only coalesce onto due jobs.
  - Validation: Postgres tests cover the continuing, ended and repeat-run cases (AC 2).
- [ ] 6. Add the manual refresh procedure.
  - `items.refresh` at `POST /items/{id}/refresh` requires `manage-libraries` on the Item's Library and queues a provider-fetch ahead of background work, or returns the due one already queued.
  - Validation: API tests cover the job, coalescing, permissions and a missing Item; running the job re-fetches the Show (AC 3).
- [ ] 7. Document and run the full gate.
  - README: TVDB keys, Show matching, the Show tree job, weekly refresh and manual refresh.
  - Run `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55529/pendia bun test` and `bun test` without `DATABASE_URL`.

## Notes

- Unattended run. Worktree `/home/mia/mia-cx/pendia/.worktrees/tvdb`, branch `feat/29-tvdb`, base `main` at `08aa982`. Test Postgres `pendia-test-pg-29` on port 55529. `TMPDIR=/home/mia/.cache/pendia-tmp/29`.
- API shapes come from the TVDB v4 OpenAPI file (version 4.7.10). Artwork type ids 2, 3 and 23 are series poster, background and clear logo.
- Seasons and Episodes use the official (aired) season type, because Sonarr names files in aired order.
- One provider-fetch job per Show, not per Episode. The provider caches the series record and its episode pages for that job, so a weekly refresh costs one login, one series request and one request per 500 episodes.
- Names and overviews come from the TVDB base records, in the series' primary language. Pendia has no metadata language setting yet.
- The PIN lives in the provider key store as `tvdb-pin`, next to `tvdb`, so the existing write-only key screen sets both.
- Only `continuing` Shows refresh weekly, as the issue asks. `upcoming` and `ended` Shows refresh on rescan of a pending Show or by manual refresh.
- The weekly job is the normal provider-fetch payload with a future `runAfter`, so it survives restarts and runs on any worker. Scheduling in the handler's `finally` keeps the chain alive when a weekly fetch fails.
- Manual refresh is an API procedure. A web UI button is out of scope.
