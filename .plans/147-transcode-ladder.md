# #147 Default live transcode ladder

## Acceptance criteria
- [x] Six named bounding boxes, from 2160p at 25 Mbit/s to 240p at 0.3 Mbit/s.
- [x] HEVC/AV1 use 0.6x the H.264 bitrate; output above 30 fps uses 1.5x.
- [x] Caps select the highest fitting rung, with aspect ratio preserved and no upscale.
- [x] CPU transcodes default to 1080p; an admin boolean permits 4K.
- [x] Required playback tests and admin setting coverage pass.

## TODOs
- [x] Persist and expose the CPU 4K boolean using the existing admin settings form.
- [x] Implement codec/frame-rate-aware rung selection and CPU ceiling, with focused tests.
- [ ] Run the requested verification, file the PR, and resolve review feedback.

## Notes
- The player quality menu belongs to #150. Stored rendition policies stay unchanged.
- No attached or repository-specific GitHub Project exists; skip status tracking.
- Isolated worktree `.worktrees/feat-147-ladder`, branch `feat/147-transcode-ladder`, base `origin/main`.
- Settings verification: database-backed `bun test apps/server/src/api/admin.test.ts`, 14 pass; `bun run check`, six tasks pass.
- Bun SQL JSON parameters need `::text::jsonb`, as documented in the repository's custom JSON column type.
- Database-backed `bun test apps/server/src/playback apps/server/src/stored apps/server/src/api/admin.test.ts apps/server/src/api/playback.test.ts apps/server/src/api/playback-sessions.test.ts`: 437 pass, 0 fail.
- Database-backed `bun test apps/server/src/transcoder/outputs.test.ts apps/server/src/api/transcode.test.ts`: 12 pass, 0 fail.
- `bun run lint`: exit 0, nine existing warnings. `bun run check`: exit 0, six tasks pass, Svelte zero errors/warnings. `bun run build`: exit 0.
- Browser QA: actual base and branch builds at 1440px and 390px; switch saved and persisted after reload. Screenshots in `/tmp/thalia-147-{before,after}-{1440,390}.png`.
- T3 preview is unavailable in this headless environment. QA used Chromium through a persistent CDP session with focus emulation enabled.
