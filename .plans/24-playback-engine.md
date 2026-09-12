# #24 Playback decision engine and timeline derivation

## Summary

Add a pure playback module under `apps/server/src/playback`. It accepts normalized client and probe data. It returns stream decisions, a play method, segment boundaries and adaptive variants. Later API and transcoder slices consume these values.

Read `CONTEXT.md`, `docs/spec/playback.md`, `docs/spec/transcoding.md` and ADR 0009 before changing the rules. The playback spec wins over older research recommendations. Keep database access, ffmpeg, profile translation, playlists and sessions outside this slice.

## Acceptance criteria

- [ ] Table-driven tests cover every row of the per-stream table and every play-method outcome in the spec.
- [ ] Dolby Vision profiles 7 and 8 resolve to the HDR10 base layer on a client without DV; profile 5 resolves to the CPU tone map.
- [ ] TrueHD and DTS-HD pass only on direct play and follow the audio rule in HLS.
- [ ] Timeline derivation covers a regular 2 s GOP and irregular keyframes. Alignment accepts a superset and rejects a missing boundary.
- [ ] The effective cap is the minimum of the three inputs. No policy cap applies on the LAN.

## TODOs

- [x] Define the client profile, caps, ladder and backend capabilities.
  - Use readonly plain data. Client video entries carry codec, accepted profiles, maximum level and dimensions, in preference order.
  - Apply the minimum policy cap off LAN. Keep the client's decoder bitrate limit separate from the LAN exemption.
  - Add the five named ladder rates and CPU capabilities. Select only an asserted backend, in QSV, VAAPI, NVENC, Vulkan, CPU order.
  - Validate cap permutations, missing caps, LAN, all ladder thresholds, below-minimum refusal, CPU fallback and backend preference. Run focused Bun tests and the server typecheck.
  - Done: playback/policy.ts, playback/policy.test.ts. Red run failed on the missing module before implementation; `bun test apps/server/src/playback/policy.test.ts` passed 43 tests and 45 assertions: all six cap permutations, lone and tied caps, LAN bypass, literal ladder, all thresholds plus below-minimum undefined, CPU codec and tone-map assertions, backend preference and forceCpu. `bun run --cwd apps/server check` and `bunx --no-install biome check apps/server/src/playback` clean. Evidence: .devin/todo1-red.log, .devin/todo1-green.log, .devin/todo1-check.log, .devin/todo1-lint.log.
- [ ] Implement per-stream decisions and the resulting play method.
  - Test the public decision function with table rows for every video constraint, audio branch and subtitle branch.
  - Decide direct play first. Re-evaluate lossless audio for HLS when any stream or container prevents direct play.
  - Preserve HDR10 base layers for DV 7 and 8. Force the CPU tone map for unsupported DV 5.
  - Copy supported text. Convert unsupported text to sidecar WebVTT without video re-encoding. Burn unsupported bitmap subtitles.
  - Select a supported encoder and ladder rung only when video needs re-encoding. Preserve aspect ratio and never upscale.
  - Validate all three play methods, DV cases, TrueHD and DTS-HD in direct play and HLS, plus unavailable output paths. Run focused Bun tests and the server typecheck.
- [ ] Derive segment timelines and check foreign Version alignment.
  - Derive boundaries nearest to each previous boundary plus four seconds. Ties choose the earlier keyframe.
  - Include zero and the duration endpoint. Require keyframes at segment starts, not at the terminal duration.
  - Reject malformed keyframe inputs rather than inventing cut points. Use exact timestamps for alignment.
  - Validate regular and irregular GOPs, ties, short files, trailing segments, equal and superset keyframes, missing boundaries and duration mismatch. Run focused Bun tests and the server typecheck.
- [ ] Select adaptive groups from compatible aligned Versions.
  - Filter to the requested Item and timeline, aligned imported Versions and complete Stored Versions.
  - Reuse the video pass rule. Choose the first available client codec family and sort variants by increasing bitrate.
  - Prefer playable existing Versions over a live video transcode, including when only a lower-ranked family passes.
  - Return one live video fallback only when no existing variant passes. Do not offer incomplete Stored Versions as fallback sources.
  - Validate mixed families, cuts, alignment, completeness, caps, sort order, stored preference, live fallback and unchanged inputs. Run focused Bun tests and the server typecheck.
- [ ] Validate the complete slice and record the results.
  - Review every source and test against the spec and acceptance criteria. Keep imports inside the pure module.
  - Run from the root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `bun test`.
  - Record real results below, including database skips. Commit this TODO before rebasing, pushing and filing the PR.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/playback`, branch `feat/24-playback-engine`, starting at `f8c6ac1`. Issue #20 is closed.
- This run is unattended. Tests use exported pure functions as the agreed seam. Each TODO gets its own reviewed implementation and commit with `Refs #24`.
- Read both playback research documents, the Version/Stream/timeline schema, colocated test conventions and the server README.
- The profile is Pendia's normalized contract, not Jellyfin's DeviceProfile wire format. Translation and admin overrides belong to later slices.
- Bitrates use bits per second. Null or absent caps mean no limit. LAN removes policy caps, not decoder limits. Equality fits a cap.
- The spec does not assign rung dimensions. Use bounding boxes of 3840x2160, 1920x1080, 1920x1080, 1280x720 and 854x480 for 20, 10, 6, 3 and 1.5 Mbit/s. Scale down within the source and client bounds, preserving aspect ratio with even output dimensions.
- The spec does not rank codecs. The normalized profile orders video capabilities from best to least preferred. Existing compatible Versions beat live re-encoding in another family.
- Inputs describe the selected video, audio and subtitle Streams, not every unselected Stream in a File. Probe normalization supplies known dimensions, bitrate and channels. Optional profile and level constraints require known matching source values.
- Unsupported output combinations throw rather than return an unplayable plan. A cap below 1.5 Mbit/s has no ladder rung. AAC stereo is the spec's baseline audio fallback.
- CPU capability assertions describe the MVP contract, not a trial executed by this module. Hardware entries arrive from a later startup trial. Unsupported DV 5 selects CPU even when hardware advertises tone mapping.
- Timeline boundaries include the duration so callers can derive the final segment length. The endpoint is not a segment start and need not be a keyframe. Foreign alignment also requires the same duration. No timestamp tolerance is invented.
- Push after the pre-PR rebase onto `origin/main`, so no force-push is needed. Never commit `.devin`, touch another branch or merge the PR.
- Review existing CodeRabbit, Codex and Pullfrog findings with the trigger test. Finish only with passing CI, a clean Pullfrog verdict on the head, mergeability and no unresolved threads.
