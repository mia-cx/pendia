# #44 Sessions dashboard, store policy and caps UI

## Summary

Operations screens in the admin UI, on top of the session registry, stored Versions (#35) and the admin shell (#37).

- An Activity screen lists live and queued playback sessions with the user, client, Item, play method, rung and transcoder, and reloads when a `session.state` event arrives over SSE. Below it, store jobs: the running ones with segment progress, the queued ones and the failed count.
- A library page edits the stored-version policy: rungs, and the condition a source must meet. The idle window is server wide (`store` settings row), so it is edited on the settings screen with the global bitrate cap. An Item page offers a manual store request for one policy rung.
- Per-user caps already have a control on the user screen (#37); the global cap is new.
- The artwork store backend is an install-time environment choice (#45), so the settings screen shows which backend and where, read-only.

Read: CONTEXT.md, docs/spec/transcoding.md, playback.md, .plans/35-stored-versions.md, .plans/37-admin-ui.md, .plans/45-artwork-backends.md, apps/server/src/api, playback/planning.ts, playback/progress.ts, stored, apps/web/src/routes/admin.

## Acceptance criteria

- [ ] A running session appears and disappears live.
- [ ] Editing a policy enqueues store jobs; a manual request does the same for one Item.
- [ ] A changed cap applies to the next play plan.

## TODOs

- [x] 1. Record the client on a playback session and announce it. A migration adds nullable `client_name` and `device_name` to `session_registry`. `planPlayback` fills them from the caller's device session (client and device name) or API key (its name as the client), and publishes `session.state` `starting` in the insert's transaction. Validation: a playback test reads both columns for a session credential and an API key, and the event stream carries the `starting` event.
- [x] 2. `playback.sessions` (GET `/playback/sessions`, manage-server): sessions not stopped and seen in the last 5 minutes, newest first, each with state, play method, user, client, the Item as a browse card, rung names and the transcoder node name. Rungs: the stored rung names for a stored session, the ladder height for a live transcode, `source` otherwise. Validation: `api/sessions.test.ts` on disposable Postgres: a planned session lists with its client and rung, a stopped one and a stale one do not, a user without manage-server gets 403.
- [ ] 3. `store.status` (GET `/store/status`, manage-transcoding): running store jobs with segments done and total, read from the rung folder on the library share; the total queued and the next 10 by run-after, each with Item, rung and run-after; the failed count. Validation: `stored/status.test.ts`: a policy edit and a manual request each show up as queued jobs; a running job with two of four segments in its folder reports 2 of 4; 403 without the permission.
- [ ] 4. Server settings for caps, the idle window and the artwork store. `settings.get` adds `bitrateCapBps`, `idleWindow` and `artworkStore` (backend, plus path, or bucket and endpoint; never credentials). `settings.update` takes `bitrateCapBps` (null clears) and `idleWindow`; a new window moves queued store jobs waiting for the old one to now, so they re-place themselves. Validation: admin tests for the round trip and the job reset; a playback test plans from a WAN address before and after a cap change and sees the second plan honour it.
- [ ] 5. Activity screen at `/admin/activity`: sessions and store jobs, reloading on `session.state` and `job.progress` events and every 10 s for staleness and progress. Validation: web `check` and `build`; rendered in Chromium with a live session appearing and leaving without a reload.
- [ ] 6. Store policy editor at `/admin/libraries/[id]` (linked from the libraries list) and a manual store request on the movie and episode pages for callers holding manage-transcoding. Validation: web `check` and `build`; in Chromium, saving a policy shows queued jobs on Activity, and a manual request answers queued.
- [ ] 7. Settings screen sections for the global bitrate cap, the idle window and the artwork store. README documents the new procedures. Validation: web `check` and `build`; in Chromium, a cap saved, reloaded and cleared.
- [ ] 8. Final gate and evidence: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test`, `bun test` without it; before and after screenshots at 1440x900 and 390x844, light and dark.

## Notes

- Worktree `.worktrees/sessions`, branch `feat/44-sessions-dashboard` from `origin/main` at 4dee205. Postgres `pendia-test-pg-44` on 55544, `TMPDIR=/home/mia/.cache/pendia-tmp/44`. Unattended run; decisions are recorded here.
- #34 (PR #88) runs alongside and changes the transcoder, `planning.ts` and `progress.ts`, with no migration. It adds the `queued` state and its `session.state` events, so queued sessions appear on the dashboard once it lands. Merge `origin/main` after #88 lands.
- Liveness: nothing marks an abandoned session stopped, and the web player sends no heartbeat while paused. A sweep that stops sessions would break a viewer resuming after a long pause, so the list filters instead: not stopped, seen in the last 5 minutes. The screen reloads every 10 s so a stale session leaves without an event.
- The artwork store stays an environment choice, as #45 decided: moving artwork between backends is unsupported, and a backend switched in the UI would strand every original on the old one. The settings screen shows the active backend read-only.
- TODO 1: migration `0010_session_client`. `DATABASE_URL=... bun test src/api/playback.test.ts src/api/events.test.ts src/api/progress.test.ts` 37 pass; `src/transcoder/sessions.test.ts src/api/hls.test.ts` 21 pass; server check and lint clean.
- TODO 2: mounted as `playback.sessions` at `/playback/sessions`, because `/sessions/{id}/revoke` already names login sessions. The test builds a real transcode decision with `decidePlayback` for the `720p` rung. `bun test src/api/playback-sessions.test.ts src/api/openapi.test.ts` 10 pass.
- Permissions: sessions follow `session.state` event delivery (manage-server); store status, the policy and manual requests follow #35 (manage-transcoding); the global cap and the idle window live in server settings (manage-server).
