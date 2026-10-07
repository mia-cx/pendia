# Progressive stream for unindexed files (#135)

## Why

Since #140 the scan no longer builds keyframe indexes; a background job does. Unindexed
Versions fail the HLS alignment gate, so browser remux/transcode plans refuse with
CONFLICT. This slice adds a progressive fMP4 stream (MSE on the web) needing no index,
and on-demand top-priority indexing when HLS is unavoidable (deviating from the PRD's
synthetic-timeline transcode).

## TODOs

- [x] Plan response gains `delivery` ("progressive" | "hls" | null), `output` codecs and `subtitleUrl`; `ClientProfile.progressive`; PREPARING (503 + Retry-After 5) with an on-demand `keyframe-index` job at priority 10 when `lazyIndexPending`; `requestKeyframeIndex` dedupes/raises.
- [x] `progressiveArguments(run)` on the transcoder: `-copyts` + input `-ss`, fMP4 flags, forced 4s keyframes on transcode; `sessions.stream()` (one ffmpeg per session, transcode slot pool, kill on abort/stop); `/internal/playback/{sid}/{item}/stream?token&start` and `subtitles/{n}.vtt` (WebVTT, absolute cues); idle timeout off.
- [x] API routes `/api/playback/{sid}/{item}/stream` and `subtitles/{n}.vtt`: shared owner resolution/proxy from hls.ts, token auth, delivery === "progressive" only, `start` validated.
- [x] Web: `MediaSupport.mse`, `profile.progressive`, `progressiveMime`, `lib/progressive.ts` MSE attach (segments mode, backpressure, seek-restart, timestampOffset for transcode), player.ts wiring + PREPARING plan retry.
- [x] Jellyfin maps PREPARING like CONFLICT.
- [x] Docs updated.
- [x] Tests: planner delivery/PREPARING/output, args unit tests, real-ffmpeg tfdt integration, route authz, web mime; `bun run check`, `bun run lint`, full `bun run test`.
- [x] Demo rebuilt on this branch (keeping the DB volume); live check in headless Chrome: unindexed movie + episode play, seek, subtitle; `progressive:false` plan → PREPARING → job priority 10 → HLS after index.

## Notes
- Done: `delivery`, `output`, `subtitleUrl` in plan + refresh; PREPARING 503 via AuthError → SERVICE_UNAVAILABLE (oRPC); `requestKeyframeIndex` raises a queued job to 10 or enqueues one.
- Done: `-ss` input seek, `-avoid_negative_ts make_zero`, frag flags + `delay_moov`, `expr:gte(t,n_forced*4)` on transcode; `sessions.stream` one-run-per-session + transcode slot share + `x-stream-offset`; `/internal` stream/subtitle routes.
- Done: `proxyToNode` shared, `/stream` + `subtitles/{n}.vtt` behind the same token/owner auth, HLS and progressive sessions reject each other's routes, bad start → 400.
- Done: `mse` in MediaSupport, `progressive` in profile, `progressiveMime`, `lib/progressive.ts` (segments mode, 90/60s backpressure, seek-restart, timestampOffset from `x-stream-offset`), player PREPARING retry every 5 s for 5 min.
- Done: PREPARING caught like CONFLICT in PlaybackInfo.
- Done: docs/spec/playback.md play-method section.
- Done: 5 planner/route cases in playback.test.ts, 5 arg unit tests + 4 real-ffmpeg cases in progressive.test.ts, 3 route tests in hls.test.ts, web mime/profile tests in playback.test.ts. check/lint clean; `bun run build` green; sharded `bun scripts/test.ts` hit 5s timeouts on unrelated files only under load avg ~35 (demo indexing) — every flagged file passes in isolation.
- Done: rebuilt on this branch keeping the DB volume; unindexed episode played over MSE in headless Chromium (position advances, seek to duration-60 resumes correctly), unindexed movie (4K HDR transcode) resumed at t=300; PREPARING → priority-10 job → HLS verified.

- Spike (ffmpeg 7.1.5, real NFS MKV, h264+eac3): with `-ss` input seek + `-copyts`, a **copy**
  stream writes absolute `tfdt` (first moof = source keyframe time ≤ start, e.g. 56.056s for
  start 60). A **transcode** always rebases tfdt to 0 no matter the flag set
  (`-copyts` in/out, `-noaccurate_seek`, `-output_ts_offset`, `frag_discont` all tried) — ffmpeg
  applies the input seek offset after the filters. Deviation: the web sets
  `SourceBuffer.timestampOffset = startAt` for transcode streams (copy keeps absolute tfdt),
  which gives identical absolute positions in MSE `segments` mode. Evidence:
  /home/mia/.cache/pendia-tmp/progressive/spike-*.mp4 + tfdt.py output.
- EAC3 audio copy needs `delay_moov` (as live-run.ts documents).
