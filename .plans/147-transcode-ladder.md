# #147 Default live transcode ladder

## Acceptance criteria
- [ ] Six named bounding boxes, from 2160p at 25 Mbit/s to 240p at 0.3 Mbit/s.
- [ ] HEVC/AV1 use 0.6x the H.264 bitrate; output above 30 fps uses 1.5x.
- [ ] Caps select the highest fitting rung, with aspect ratio preserved and no upscale.
- [ ] CPU transcodes default to 1080p; an admin boolean permits 4K.
- [ ] Required playback tests and admin setting coverage pass.

## TODOs
- [x] Persist and expose the CPU 4K boolean using the existing admin settings form.
- [ ] Implement codec/frame-rate-aware rung selection and CPU ceiling, with focused tests.
- [ ] Run the requested verification, file the PR, and resolve review feedback.

## Notes
- The player quality menu belongs to #150. Stored rendition policies stay unchanged.
- No attached or repository-specific GitHub Project exists; skip status tracking.
- Isolated worktree `.worktrees/feat-147-ladder`, branch `feat/147-transcode-ladder`, base `origin/main`.
- Settings verification: database-backed `bun test apps/server/src/api/admin.test.ts`, 14 pass; `bun run check`, six tasks pass.
- Bun SQL JSON parameters need `::text::jsonb`, as documented in the repository's custom JSON column type.
