# #26 Shows medium with next up

## Summary

Add the shows medium beside movies. It recognizes Sonarr-style show and season layouts, writes Show, Season and Episode Items, and keeps Versions only on Episodes. Split episode files become ordered Files on one Version. Multi-episode files become one Episode with an inclusive range. The medium joins the video Home shelves, adds next up per user, and registers routes for all three kinds.

## Acceptance criteria

- [ ] A fixture shows tree yields Show, Season and Episode Items with the closure table filled.
- [ ] A split episode is one Version with two Files; a multi-episode file is one Episode carrying its range.
- [ ] Next up returns the first unwatched episode after the last watched one per show, and nothing for a finished show.
- [ ] Scan rules have tests on season folders, specials and both multi-file cases.

## TODOs

- [ ] 1. Add the shows Medium definition and Sonarr path grouping.
  - Register Show, Season and Episode against their existing extension tables. Only Episode has Versions.
  - Use the top-level show folder as the canonical folder. Accept `Season N` and `Specials`, with Specials as season zero. Parse `SxxEyy`, `SxxEyy-Ezz` and `SxxEyyEzz` episode forms.
  - Group `partN`, `ptN` and `cdN` filename suffixes into one Version with ordered paths. Keep one multi-episode path as one Episode carrying its start and end numbers. Apply the movies medium's video, extras and Pendia-store rules.
  - Validation: `bun test apps/server/src/mediums/shows.test.ts`, `bun run --cwd apps/server check`, and `bun run --cwd apps/server build` pass. Tests cover season folders, Specials, ranges, split parts, extras, unsupported files and unsafe paths.
- [ ] 2. Persist one canonical show tree through the scan pipeline.
  - Scan a canonical show folder recursively. Probe accepted files through the existing cache.
  - Insert or reuse the Show, its Seasons and Episodes through `insertItem`, preserving closure rows and curated Item metadata.
  - Write one imported Version per grouped episode version. Aggregate split-file bytes and duration, attach ordered Files and their Streams, and keep repeat scans identity-stable.
  - Validation: `DATABASE_URL=... bun test apps/server/src/libraries/scan.test.ts` passes against disposable Postgres and real ffmpeg fixtures. It asserts the Item tree, extension rows, closure rows, split and ranged episodes, Version ownership, File order, Streams, probe reuse and no container Versions.
- [ ] 3. Enable shows libraries and queued show scans.
  - Permit `shows` in library creation and scan requests.
  - Dispatch root and directory jobs by library medium. A shows root job fans out once per canonical show folder and a directory job runs the shows scanner before publishing `library.changed`.
  - Keep the existing per-library concurrency key and movie behavior unchanged.
  - Validation: `DATABASE_URL=... bun test apps/server/src/libraries/service.test.ts apps/server/src/libraries/jobs.test.ts apps/server/src/api/libraries.test.ts` passes. Tests cover shows creation, root fan-out, queued scanning and the existing movie path.
- [ ] 4. Add the next up shelf and registered show screens.
  - Add a database-bound shows medium factory so its shelf callback can query Progress without changing the Medium contract.
  - Return one candidate for each started show. The candidate is the first non-completed Episode after that show's highest completed Episode in season and episode order. Omit shows with no completed progress and shows with no later Episode.
  - Sort shows by the selected last Episode's `playedAt`, newest first, then deterministically. Join continue watching and recently added. Register `/shows/:id`, `/shows/:showId/seasons/:id` and `/shows/:showId/seasons/:seasonId/episodes/:id`.
  - Validation: `DATABASE_URL=... bun test apps/server/src/mediums/shows.test.ts` passes. Tests cover independent users, a partially watched candidate, multiple shows, season boundaries, Specials and a finished show.
- [ ] 5. Complete acceptance coverage and run the repository gate.
  - Review every issue criterion against a permanent test and update the existing server README for shows scanning.
  - Run from the repository root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55426/pendia bun test`, and `env -u DATABASE_URL bun test`.
  - Confirm the existing CI-only missing-DATABASE_URL failure and remove `pendia-test-pg-26` when review validation ends.
  - Validation: every command has its real result recorded below, local omission prints one skip message, and no `.devin` file is committed.

## Notes

- This run is unattended. The lead owns design, review, commits, pushes, comments and the pull request. The built-in SWE-2 sidekick implements and validates each TODO from an exact brief.
- Work stays in `/home/mia/mia-cx/pendia/.worktrees/shows` on `feat/26-shows-medium`. The initial base is clean at `0e8ac31`, equal to `origin/main`.
- The repository does not define split-part spelling. This plan accepts the common terminal `partN`, `ptN` and `cdN` forms, separated by spaces, dots, underscores or hyphens. The part marker affects File order but not Version identity.
- A valid scanned episode sits under `<show>/Season N/` or `<show>/Specials/`. The filename season must match its folder. Files outside these folders are ignored. The first path segment is the canonical show folder, matching the requested Sonarr layout.
- Episode titles default to `Episode N` or `Episodes N-M`. Providers can replace them later. Filename quality words do not become metadata.
- Next up starts only after completed Progress exists for a show. A partially watched later Episode is still the candidate because `completed` defines watched. Specials participate as season zero.
- The database-bound medium factory closes over `Database` for next up. This keeps the published shelf callback shape `{ userId }` unchanged.
- Test seams are the Medium scan contract, show path grouping, `scanDirectory`, library service and jobs, and the next up shelf callback. These are the existing public module boundaries named by the issue.
- No schema migration is needed. The Show, Season, Episode, episode range, closure and Progress tables already exist.
- Before filing and before each review push, fetch and rebase on `origin/main`. Resolve conflicts in favor of merged code. Never force-push.
