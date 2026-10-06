# #133 Scanning: about 2–3 folders a minute over NFS

## Summary

Scans over NFS run at 2–3 movie folders a minute, and some scan jobs lose their lease. Measured on Mia's Radarr library (`/mnt/media`, nfs4): listing all 2,159 folders and 495 videos takes 4.5 s, ffprobe takes 0.1–0.2 s per file, and the keyframe index takes 0.6–132 s per file. The index is about 99% of scan time. Verifying every Matroska cue costs one NFS round trip per cue: about 434,000 reads for one 25 GB remux.

The scan stops reading the keyframe index. It lists files and runs ffprobe only, so Items appear within minutes. A new `keyframe-index` job reads each single-file Version's index in the background, one file at a time per Library, and derives the segment timeline when it finishes. Until then a File plays as a File without an index plays today: direct play, or an aligned stored Version.

This lands before the rest of #135. It keeps today's end state (every single-file Version gets its index eventually), so nothing regresses while direct streaming and the HLS fallback are built. #135 can later narrow which Files get an index job.

## Acceptance criteria

- [ ] A directory scan runs ffprobe and never calls the keyframe reader
- [ ] Each imported single-File Version without an index gets one queued `keyframe-index` job; a rescan queues no duplicate
- [ ] The job stores the index on the probe cache entry and the Version, and derives the segment timeline as the scan did
- [ ] A File that already has an index keeps it across rescans and is not re-read
- [ ] A File that changed or vanished before the job runs is skipped without error
- [ ] Index jobs never hold the Library's scan concurrency key, so scans don't wait behind them
- [ ] A slow index read under a short lease completes without losing its lease
- [ ] Each directory scan logs its walk, probe and write times
- [ ] Before and after timings on the Radarr NFS library in the PR
- [x] The repository gate is green

## Design

- `ProbeResult.keyframesSeconds` becomes optional. Absent means the index was never read. `null` means it was read and the container has no usable index. An array is the index.
- `probeVideo` runs ffprobe only. The probe cache accepts an entry with or without `keyframesSeconds`. Entries that already hold one keep it.
- Scan writes for a single-File Version: `keyframesSeconds: probe.keyframesSeconds ?? null`, `lazyIndexPending: probe.keyframesSeconds === undefined`. Multi-File Versions keep `keyframesSeconds: null` and get `lazyIndexPending: false`: split Files are never indexed, as today.
- Job payload: `{ type: "keyframe-index", libraryId, rootId, path }`. Priority -5: below scans and metadata fetches (0), above store jobs (-10), which wait for a timeline. Concurrency key `keyframes:<libraryId>`, separate from `library:<libraryId>`.
- The scan queues the job inside its write transaction for each imported Version with exactly one File whose probe has no `keyframesSeconds` key, unless a queued or running `keyframe-index` job already exists for that root and path.
- The handler reads the index outside any database transaction. It checks size and mtime against the probe cache entry before and after the read. Then, in one transaction under the same per-file advisory lock as `probeLibraryFile` and the Item write lock the scan takes, it stores the index on the cache entry and on matching Versions, sets `lazyIndexPending: false`, and calls `persistScanTimelines` for each affected Item.
- Watcher-backed Libraries are unchanged. The watcher runs next to the disks, where random reads are cheap, so it keeps reporting the index with each probe. Its reports always carry `keyframesSeconds`, so they never queue index jobs. A worker that runs an index job for a file it cannot reach skips it.

## TODOs

- [x] Probe with ffprobe only: optional `keyframesSeconds`, cache hits without it, scan writes index state from it; tests
- [x] Add the `keyframe-index` job type: enum migration, payload, handler, registration, admin label; tests, including the short-lease run
- [x] Queue index jobs from the scan, deduplicated; tests
- [x] Log walk, probe and write time per directory scan
- [x] Update the scan and keyframe docs
- [ ] Full gate

## Notes

- Baseline from the 8-movie NFS sample above, and the issue's figure of about 2 hours for 315 folders. The after run is a fresh scan of the Radarr library on the dev server.
- TODO 1: probe.test, probe-cache.test, scan.test, timelines.test, watcher/http.test, adaptive.test, stored/jobs.test all green; tests that need an index inject a probe carrying `keyframesSeconds`.
- TODO 2: handler lives in `libraries/keyframe-index.ts` (not jobs.ts) to avoid a scan↔jobs import cycle; no web job-label map exists, so no admin label added. jobs.test.ts green incl. short-lease worker run.
- TODO 3: dedup keys on rootId+path in queued/running `keyframe-index` jobs; watcher never reaches this path (it writes the cache directly), covered by the index-carrying-probe test. jobs.test.ts, scan.test.ts, timelines.test.ts, probe-cache.test.ts green.
- TODO 4: `scan.directory` JSON line (libraryId, path, files, probeCacheHits, walkMs, probeMs, writeMs) after both scan writers; a scan.test.ts case asserts the shape.
- TODO 5: updated CONTEXT.md (Scan/Probe/Job entries), topology.md job list, operations.md worker row, server README probe-cache + timeline paragraphs.
- TODO 6: gate green on the fast suite — `bun run lint` clean, `bun run check` 6/6, `bun run build` 4/4, `bun run test` 1475 pass / 3 skip / 0 fail in ~124 s (DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55580/pendia_dev).
