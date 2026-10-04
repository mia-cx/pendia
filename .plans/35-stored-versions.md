# #35 Stored Versions: store job, policy, completeness, adaptive playlist

## Summary

Pendia keeps lower-quality Versions next to the source so a session can switch between them instead of transcoding live. A per-library policy names rungs and a condition; a manual per-Item request names rungs too. A store job runs the quality profile on a worker, at low priority and only inside the idle window, and writes `<source file>.pendia/<rung>/` with `init.mp4`, numbered `.m4s` segments cut on the Item's segment timeline, and `manifest.json` with the timeline id, the rung and a complete flag, written last. The source rung is a remux. A killed or interrupted job resumes by skipping segments already present. A Stored Version row (no File rows) carries the folder, rung and complete flag and its fileless Streams. A rung the policy drops is deleted, and a deleted source takes its `.pendia` folder with it. When a plan is not direct play, the master playlist lists the complete, aligned stored rungs that pass as variants, served from disk by the api; the live rendition (the #33 remux session, later the #34 transcode) appears only when no stored Version passes.

Read: CONTEXT.md, docs/spec/transcoding.md, playback.md, topology.md, ADR 0009 and 0013, docs/research/ffmpeg-hls-pipeline.md, .plans/33-hls-sessions.md, apps/server/src playback, transcoder, jobs, libraries and db schema.

## Acceptance criteria

- [ ] A policy on a fixture library produces complete stored rungs with manifests; an incomplete rung is never offered.
- [ ] hls.js switches between two stored rungs without stalling, and the playlist shows matching segment boundaries.
- [ ] Deleting the source removes its `.pendia` folder; dropping a rung from the policy removes that rung.
- [ ] Store jobs run only inside the idle window and at low priority.
- [ ] Store folder layout and playlist composition have tests.

## TODOs

- [x] 1. Policy and idle window. `stored/policy.ts` decodes the library policy from `libraries.configuration.storedVersions` (rungs: `source` or `{ name, height, bitrate }`; optional `when` with `minHeight`, `codecs`, `hdr`, any one matching) and the idle window from the `store` settings row (default 01:00 to 07:00 server local time). Pure helpers decide whether a source matches, which rungs it wants, whether now is inside the window, when the window ends and when the next one starts. Validation: unit tests for decoding, matching, rung skipping and windows that cross midnight.
- [ ] 2. Store run. `stored/encode.ts` builds the ffmpeg arguments for the source rung (stream copy) and an encoded rung (libx264 high, keyframes forced on the timeline, scaled to the rung height, HDR tone mapped to SDR, AAC stereo), runs ffmpeg under `nice -n 19` into `<rung>/.partial/`, moves each segment ffmpeg's list declares finished into the rung folder, resumes at the first missing segment, and writes `manifest.json` last once every segment is present. Validation: real ffmpeg on a fixture; segment cut points equal the timeline in both rungs; a run killed midway resumes without rewriting present segments and with the same init; no manifest before the last segment.
- [ ] 3. Store job. `stored/jobs.ts` registers the `store` handler for worker and all roles. It skips a stale job, re-enqueues itself for the next window when claimed outside the window, kills ffmpeg at the window end and re-enqueues, upserts the Stored Version row, and after the manifest writes the fileless Streams and sets complete. Store jobs enqueue at priority -10 under one `store` concurrency key. Validation: Postgres tests for a complete rung, the outside-window deferral, the window-end stop and resume, and the niceness of the ffmpeg process.
- [ ] 4. Policy reconciliation and API. `stored/reconcile.ts` enqueues the wanted rungs for an Item's best aligned source (deduped against queued and running jobs and complete rungs), deletes Stored Versions whose rung the policy no longer names, and removes `<file>.pendia` folders whose source File is gone. The scan job runs it for the scanned folder. Procedures: `libraries.storedVersions` (get), `libraries.setStoredVersions` (put, reconciles the library) and `items.requestStoredVersion` (manual, per Item). Validation: Postgres tests for the policy run on a fixture library, a dropped rung, a deleted source and a manual request.
- [ ] 5. Adaptive playlist. `planPlayback` lists complete, aligned stored rungs that pass the client as variants of a remux session; only when none passes does it open the live session it opens today. `buildMasterPlaylist` takes several variants. The api serves the stored master, media playlists, init and segments from disk under `hls/<versionId>/`. Validation: playlist composition unit tests; an api test where two stored rungs share segment boundaries, an incomplete rung is left out, and a profile no rung passes falls back to the live rendition.
- [ ] 6. hls.js switch. A headless Chromium test plays the two-rung master, forces a level switch each way and asserts playback passes the switch points without a fatal error or stall. Validation: the test passes locally with Chromium.
- [ ] 7. Docs and final validation: README sections for stored Versions; `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test`, `bun test` without it. Record results here.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/stored-versions`, branch `feat/35-stored-versions`. Unattended run; decisions are recorded here. Postgres container `pendia-test-pg-35` on port 55535; `TMPDIR=/home/mia/.cache/pendia-tmp/35` because `/tmp` is full.
- No migration. The schema already has `origin = 'stored'`, `source_file_id`, `stored_folder`, `rung`, `complete`, fileless Streams and the `store` job type. That also keeps this branch clear of #34's migrations.
- The idle window is server wide, because CPU is: settings row `store`, `{ "idleWindow": { "start": "01:00", "end": "07:00" } }`, server local time. Like the `playback` bitrate cap, it has no API yet.
- Encoded rungs are H.264 with AAC stereo, matching the spec's example. A rung taller than the source is skipped. The source rung copies video and the first audio track; audio outside the fMP4 copy list is encoded to AAC stereo, and a source whose video cannot be copied into fMP4 gets no source rung.
- A rung is deleted when the policy no longer names it. A condition change does not delete rungs, so a manual request keeps its rung while the policy names it.
- One store job runs at a time across the cluster (concurrency key `store`, the queue's default limit of 1), at queue priority -10, and ffmpeg runs under `nice -n 19`.
- Stored sessions are served by the api from the library share, which every role reads (topology.md). No transcoder is involved, so a stored session works with no transcoder registered.
- TODO 1 validation: `DATABASE_URL=... bun test src/stored` passes 16 tests. The policy decodes with excess keys rejected, because Effect's union otherwise strips `height` and `bitrate` from an encoded rung named `source` and reads it as the remux.
