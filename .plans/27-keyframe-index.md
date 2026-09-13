# #27 Keyframe index parsers and segment timeline at scan

## Summary

Read keyframes from Matroska Cues and MP4 sample tables without scanning packets. Cache the result with the probe. Persist each Version's index and lazy-index flag. Reuse playback's derivation and alignment checks when scans establish an Item's segment timeline.

## Acceptance criteria

- [ ] Parsed keyframe times match ffprobe's full packet scan for start/end Cues and start/end moov fixtures.
- [ ] Parser reads stay below 2 MB per fixture, including files larger than that budget.
- [ ] Scans persist one timeline per Item cut, reuse it for later Versions, and record each Version's alignment.
- [ ] Fragmented MP4 without a sync-sample table requests lazy indexing instead of failing the scan.

## TODOs

- [x] Add a bounded random-access reader and Matroska SeekHead/Cues parser. Validate generated start/end Cues fixtures against ffprobe, plus absent and malformed indexes.
- [ ] Add MP4 sync-sample timing from stss, stts, ctts and supported edit lists. Validate start/end moov, B-frames, audio-first tracks and fragmented MP4 through the public parser.
- [ ] Add Version keyframe storage and a lazy-index flag with a generated migration. Validate fresh and repeated migrations and index round trips against disposable Postgres.
- [ ] Include the cheap index in probes and persistent probe-cache hits. Validate real probes, unchanged-file cache reuse, changed-file refresh and upgrading old cached results.
- [ ] Persist scan timelines and Version alignment using playback helpers. Validate first-Version ownership, later aligned and unaligned Versions, independent cuts, rescans, concurrent scans and lazy fallback.
- [ ] Complete large-payload fixture coverage and final validation. Assert fewer than 2,000,000 bytes read for every layout. Run all requested root checks and record actual results below.

## Notes

- TODO1 done: `apps/server/src/mediums/video-common/keyframes.ts` (`readKeyframeIndex`, `KeyframeIndex`; EBML signature dispatch, reserved MP4 branch returns null, `InvalidIndex` caught at the boundary while OS errors propagate), `keyframes/reader.ts` (`FileIndexReader`/`IndexReader` over fs.promises with a 2,000,000 actual-bytes budget enforced before each read), `keyframes/matroska.ts` (EBML VINT headers, unknown Segment size to file end, SeekHead following with a visited set, Info TimestampScale, first video TrackEntry, CuePoint filtering on CueTrack), `keyframe-fixtures.ts` (`createKeyframeFixture` with the start/end Cues layouts, `ffprobeKeyframeTimes` packet oracle) and colocated `keyframes.test.ts` with compact synthetic EBML builders. Checks from repo root: `bun test apps/server/src/mediums/video-common/keyframes.test.ts` (9 pass: end-cues and front-cues match the ffprobe packet oracle within 1e-6, synthetic SeekHead/Cues positive, `-live 1` no-cues, unreachable front Cues, zero TimestampScale, truncated/cyclic/out-of-range/unknown-size/oversized-integer/over-budget EBML, MP4/junk signatures, nonexistent rejects), `bun run --cwd apps/server check`, `bunx biome check` on the four owned paths. All pass; evidence in `.plans/27-todo1-validation.txt`. Observed reads: end-cues fixture 436,839-byte file cost 530 bytes, start-cues 444,908-byte file cost 529 bytes. Review fixes applied: the budget rejects before excess IO, integer payloads cap at 8 bytes, Cues are accepted only through SeekHead (front Cues encountered in the header scan are skipped), TrackTimestampScale values other than 1 request lazy indexing, element headers read exactly their VINT lengths, and unused fixture options plus inline comments were removed.
- Work stays on `feat/27-keyframe-index` in the supplied worktree. Each TODO gets its own reviewed implementation commit with `Refs #27`.
- Owned code is the new keyframe module, video probe, probe cache, scan pipeline, Version schema and migration metadata. Existing playback derivation stays unchanged.
- Test seams are the public file index reader, `probeVideo`, `probeLibraryFile`, `scanDirectory`, and migrated database storage. Database assertions verify persistence required by this issue.
- Use the first timed video track. Return presentation timestamps in seconds, matching ffprobe packet PTS. MP4 composition offsets and ordinary rate-one edit lists must be applied.
- Index reads have a 2,000,000-byte budget. Missing, unsupported, malformed or oversized indexes return a lazy result. Filesystem errors still fail the probe. No production ffprobe packet scan is added.
- The first persisted imported Version owns derivation for its cut. Initial directory ordering is deterministic. A later Version must not replace an unavailable first Version as the timeline source.
- Reuse `editionTag` for cut identity, normalized to lowercase; untagged Versions use `original`. Existing timeline identities and boundaries remain immutable.
- Playback requires keyframes beginning at zero. Preserve raw container times. An index with a nonzero first keyframe remains stored but cannot establish a timeline with this playback contract. Do not fabricate a keyframe at zero.
- Lazy indexing execution on first play belongs to playback delivery. This slice persists the request flag only.
- Tests use the existing disposable-database helper. Local Postgres is `pendia-test-pg-27` on port 55427 and is removed at completion.
- Rebase on `origin/main` before filing and before each push. Never force-push. If a later rebase would require rewriting published history, report the constraint rather than override it.
- Source references read: `CONTEXT.md`, `docs/research/ffmpeg-hls-pipeline.md`, `docs/spec/playback.md`, `docs/spec/plugin-api.d.ts`, ADRs 0002, 0006, 0008 and 0009, server README, playback timeline/adaptive modules and tests, video probe and fixtures, and scan/cache/schema modules and tests.
