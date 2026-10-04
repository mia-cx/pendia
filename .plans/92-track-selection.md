# #92 Playback: select the audio track and subtitles per session

## Summary

A session plays its File's first audio Stream and burns any bitmap subtitle the client cannot draw, asked for or not. Let a plan choose its audio Stream and its subtitle Stream, or no subtitles, and carry that choice through every layer: the engine decides only the chosen Streams, the runs map the chosen audio, the master playlist and Jellyfin describe the choice, and the web player gets menus for both.

Decisions from the lead:

- `PlanInput` gains `audioStreamIndex?: number` and `subtitleStreamIndex?: number | null`. Both are source Stream indexes, Jellyfin's numbering. `null` turns subtitles off. The resolved choice is stored on the session decision, so a stored-Version switch or a resume keeps it.
- No audio chosen: the default-flagged audio Stream, else the first. No subtitle chosen: today's behaviour.
- Burn-in only for a chosen bitmap subtitle the client cannot draw. A stored rung is still refused when burn-in is required and no live path delivers it (#88).
- Jellyfin passes `AudioStreamIndex` and `SubtitleStreamIndex` (`-1` is off) through PlaybackInfo; the playback URLs keep them.

## Acceptance criteria

- [ ] A fixture with two audio Streams plays the second when asked, over remux and transcode.
- [ ] A fixture with an unselected PGS track plays without burn-in when subtitles are off.
- [ ] The master playlist and Jellyfin's `DefaultAudioStreamIndex` describe the selection.
- [ ] The web player has an audio menu and a subtitle menu that re-plan the session at the current position.

## TODOs

- [x] Engine: `PlaybackSource` carries an optional Stream selection, counted among each kind as ffmpeg counts. The decision covers only the chosen audio and subtitle Streams and records the resolved selection. `requiresBurnIn` looks at the chosen subtitles only. An explicit audio choice other than the default rules out direct play. Validation: `playback/decisions.test.ts`.
- [x] Runs and outputs: `LiveRun` and `RemuxRun` map the chosen audio Stream; `sessionOutputs` takes the audio, burn-in and WebVTT renditions from the selection, and the master marks a chosen text rendition `DEFAULT`. Validation: `transcoder/live-run.test.ts`, `transcoder/remux.test.ts`, `transcoder/outputs.test.ts`.
- [x] Planning and API: `PlanInput` takes both indexes and checks them against the File's Streams. Stored rungs, which carry the first audio Stream, are refused for any other audio choice. The plan answers with the chosen indexes and the File's audio and subtitle Streams. Validation: `api/transcode.test.ts` on Postgres with the issue's two fixtures, plus a 400 for a bad index in `api/playback.test.ts`.
- [ ] Jellyfin: PlaybackInfo reads `AudioStreamIndex` and `SubtitleStreamIndex` from the body or query, passes them to the plan, keeps them on the `TranscodingUrl`, and answers `DefaultAudioStreamIndex` and `DefaultSubtitleStreamIndex` from the selection. Validation: `jellyfin/streaming.test.ts` on Postgres.
- [ ] Web player: an Audio menu and a Subtitles menu beside the Version menu. A change re-plans at the current position and keeps the choice across retries. Validation: web `check`, a unit test for the track names, and screenshots at 1440x900 and 390x844 in light and dark with the menus open.
- [ ] Docs and full gate: `docs/spec/playback.md` and `docs/spec/jellyfin-layer.md` name the selection. Validation: the commands in the brief, results below.

## Notes

- `remuxArguments` has no production caller today (live sessions run `liveRunArguments` for remux too), but it maps `0:a:0` the same way, so it takes the selection as well.
- Stored rungs encode `0:a:0`. A selection resolved to any other audio Stream, including a default-flagged second Stream with no explicit choice, plays live.
