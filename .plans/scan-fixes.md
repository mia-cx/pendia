# #67 #68 #70 #71 #73 Library scan fixes

## Summary

Five bugs in `apps/server/src/libraries/scan.ts` and its tests:

- #67: the show scan writes episode Versions without `keyframesSeconds` and `lazyIndexPending`, so an indexed probe is stored as unindexed.
- #68: two overlapping episode ranges found in one show scan reach the insert unnormalised, hit the episode range exclusion constraint, and fail the whole scan.
- #70: the show reconciler deletes stale File rows before it checks `versions.origin`.
- #71: reconciliation trusts a walk taken before the write lock, so a file recreated during the probe pass loses its row and its watch progress.
- #73: `waitForBlockedScan` counts lock waits from every database on the server, so it can return before the scan under test blocks.

## Acceptance criteria

- [ ] An episode whose probe has keyframes is stored indexed (`lazyIndexPending` false).
- [ ] `S01E01-E03` plus `S01E02-E04` in one scan succeed as one widened Episode with both files as Versions.
- [ ] A new `S01E01-E03` next to a retained `S01E02` succeeds without an exclusion constraint error.
- [ ] The show reconciler deletes File rows only for imported Versions, like the movie reconciler.
- [ ] A file recreated between the walk and the write lock keeps its row and its watch progress, for movies and shows.
- [ ] `waitForBlockedScan` counts only lock waits in the test's own database, from other backends.
- [ ] Lint, check, build, and `bun test` with and without `DATABASE_URL` pass.

## TODOs

- [ ] #73: filter `waitForBlockedScan` to `datname = current_database()` and `pid <> pg_backend_pid()`.
  - Validation: the existing lock tests in `scan.test.ts` pass.
- [ ] #67: store `keyframesSeconds` and `lazyIndexPending` on show Versions, as the movie path does.
  - Validation: the show tree test asserts single-file episode Versions are indexed.
- [ ] #68: merge overlapping discovered episode ranges per Season before writing, and drop the widening checks the merge makes dead.
  - Validation: new tests for `S01E01-E03` plus `S01E02-E04`, and `S01E01-E03` next to a retained `S01E02`; existing range tests still pass.
- [ ] #70: the show reconciler selects only Files of imported Versions before deleting stale ones.
  - Validation: existing reconcile tests pass.
- [ ] #71: re-stat the paths a reconciling scan is about to drop, inside the write lock, for movies and shows.
  - Validation: new tests recreate a file while the scan waits on the lock and expect the existing abort error with rows and progress kept.
- [ ] Run the full gate and record the results here.

## Notes

- #67: a split Version has one keyframe index per File, so only a single-File Version takes its probe's index. A split Version stays `lazyIndexPending`. The show scan still writes no segment timeline for episodes (`persistScanTimelines` runs only for movies); that is outside these issues.
- #68 design: `mergeEpisodeRanges` in `mediums/shows.ts` merges one Season's discovered ranges before any write.
  - A Version whose File already belongs to an Episode of the Season keeps that Episode's start. Without this, deleting the first file of a merged pair would re-key the second file to a new Episode and fail with `CONFLICT`.
  - Overlapping ranges merge into one Episode holding every Version, as `groupShowPaths` already does for equal starts.
  - No range reaches past the next persisted Episode's start. This is the rule `blocksWidening` applied to existing rows, and the pre-pass already applies to persisted rows (`blockingStart - 1`). It also covers new rows, which had no check.
  - With merged, capped ranges, `blocksWidening` and `overlapsDiscoveredEpisode` can no longer be true, so the widening check is just `discoveredEnd > existingEnd`.
  - `S01E01-E03` next to a retained `S01E02` becomes a new Episode 1 holding the `E01-E03` file, and Episode 2 keeps its row. The existing logic gives the same result for an existing Episode 1 (`does not widen into a retained standalone Episode`).
  - No case was left that needed the skip-the-later-file fallback, so it is not built.
- #70: the schema already forbids Files on stored Versions (trigger `files_imported_version`, "Files require an imported Version"; stored Versions are fileless). A stored Version therefore has no File rows the reconciler could delete, and the requested test (a stored Version keeps its File rows) cannot be built. The reconciler now filters on `origin = 'imported'` in its select, matching the movie reconciler and removing the per-Version origin lookup.
- #71: `ScanSource` gains `confirmMissing(paths)`, next to `verify` and `confirmEmpty`. The local source re-stats each path; the watcher source does nothing, like its `verify` and `confirmEmpty`, because its report is the walk and `exists` there treats an unchecked path as present. Only paths inside the walked scope are checked: a stored path outside the scope was never walked, and aborting on it would fail every retry. `inScope` moves from `watcher/http.ts` to `scan.ts` for both callers.
