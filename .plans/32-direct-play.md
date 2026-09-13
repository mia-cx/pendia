# #32 Direct play, playback tokens, progress and marks

## Summary

Connect the playback decision engine to an authenticated play-planning procedure and a Bun file route. Record playback sessions and per-Item progress. Expose compatible resume, favourites, ratings, and continue watching.

Read contracts: CONTEXT.md; docs/spec/playback.md, auth.md, topology.md, plugin-api.d.ts; ADRs 0001, 0002, 0003, 0006, 0009, 0010; apps/server/README.md. Existing playback, auth, API, scanner, and database modules provide the implementation boundaries.

## Acceptance criteria

- [ ] A range request answers 206 with the right bytes and Content-Range; an expired or foreign token answers 401.
- [ ] Progress is recorded and resumed on another Version of the same cut, and not across cuts.
- [ ] Favourites and ratings toggle and read back.
- [ ] A user without access to the library cannot plan or play.
- [ ] Leave real NFS sendfile verification to the measurement slice. The issue calls this slice 29; its current issue is #47.

## TODOs

- [x] 1. Add signed, five-minute playback tokens backed by a shared Postgres signing key. Bind each token to its playback session, Item, user, and issuing credential. Check expiry, signature, live session ownership, credential revocation, and current permissions. Validation: adjacent token tests cover tampering, expiry, foreign scope, disabled users, revoked credentials, stopped sessions, and shared-key use across database clients.
- [ ] 2. Add playback planning and refresh procedures. Load the requested Item and Version, normalize probed Streams, and run decidePlayback with trusted-address LAN detection and persisted bitrate caps. Create a session row and return a token URL only for direct play. Validation: RPC and REST tests cover direct play, non-direct decisions without URLs, input validation, library and play denial, refresh ownership, and registry rows.
- [ ] 3. Serve GET and HEAD /api/playback/{sessionId}/{itemId}/direct through Bun.file responses. Accept scoped query tokens or the owning user's same-origin cookie. Recheck permissions, session state, and library-relative file containment before opening the file. Validation: real HTTP tests cover full, bounded, open-ended, suffix, and unsatisfiable ranges; expired and foreign tokens; cookie ownership; missing files; and escaping paths. Record NFS sendfile as unverified.
- [ ] 4. Add start, progress, stop, and resume procedures. Write the session's Version and Format with per-Item position. Serialize session transitions and make repeated start and stop safe. Resume on the same Version or another Version with the same non-null timeline and Format. Validation: tests cover cross-Version same-cut resume, different cuts, missing timelines, deleted Versions, user isolation, completion, and terminal stopped sessions.
- [ ] 5. Add per-user favourites, ratings, and continue-watching procedures. Set or clear marks idempotently. Ratings accept 0 through 10 with one decimal. Continue watching returns accessible unfinished Items with positive positions, newest played first. Validation: RPC and REST tests cover mark round trips, invalid ratings, per-user isolation, filtering, and stable pagination.
- [ ] 6. Verify the complete playable path and record final results. Add a scanned-media end-to-end test and confirm OpenAPI describes the new procedures. Run frozen install, lint, check, build, all tests with Postgres, and tests without DATABASE_URL. Validation: every command passes, local database tests skip once without the URL, and CI without the URL fails. Review the complete diff before filing.

## Notes

- Work only in /home/mia/mia-cx/pendia/.worktrees/directplay on feat/32-direct-play. The lead owns plans, commits, rebases, pushes, comments, and review decisions. Each implementation TODO goes through the authorized implementation handoff and full diff review before its commit.
- Keep changes in new playback and API playback/marks modules, auth/playback-tokens.ts, their adjacent tests, and the minimal API router and handler wiring. Reuse existing schema tables without a migration unless a demonstrated constraint requires one. Leave scanner and playback-engine changes to their owners.
- The run is unattended. Tests use the public token helper, typed RPC/REST procedures, and the real HTTP route. Use the existing disposable Postgres helper. No mocked database.
- Each successful plan creates one playback session in starting state for direct play. Non-direct decisions report the method without a session or URL. Remux and transcode execution belong to later slices.
- Planning accepts an explicit Version of the requested Item. This avoids choosing a different cut silently. Direct play supports one imported File per Version. Multi-part assembly and Stored Version HLS delivery belong to later playback slices.
- Tokens last 300 seconds. A random 256-bit HMAC key lives under the internal auth.playbackSigningKey setting. Concurrent replicas create it with conflict-safe insertion. Tokens contain identifiers and expiry, never account tokens or paths. Refresh requires ordinary authentication and a live owned playback session.
- The direct URL is origin-relative and carries only the playback token. Cookie callers receive a token-free URL. A supplied invalid token fails instead of falling back to cookies.
- Use the existing requestIdentity helper before LAN detection. LAN means loopback, RFC1918 IPv4, or IPv6 unique-local/link-local addresses. Unknown addresses remain capped. Global caps use the playback setting's bitrateCapBps; user caps use user_settings.bitrate_cap_bps. Missing caps are unlimited. Clients cannot assert LAN status or override server policy.
- Current scanned Versions have no segment timeline. Same-Version resume works; cross-Version resume fails closed until slice #27 records cut timelines. Equal durations, labels, or null timelines do not prove compatibility.
- Start increments playCount once per session. Progress and stop accept an explicit completed flag, default false. There is no invented completion percentage. A completed Item resumes at zero. A missing recorded Version also resumes at zero.
- Continue watching uses a stable newest-first playedAt and Item id cursor. Permission filtering happens before pagination. Empty access returns an empty shelf.
- Real NFS sendfile remains unverified here. Issue #47 measures this exact route on the real mount and determines any fallback.
- Start local Postgres with `docker run -d --name pendia-test-pg-32 -e POSTGRES_USER=pendia -e POSTGRES_PASSWORD=pendia -e POSTGRES_DB=pendia -p 127.0.0.1:55432:5432 postgres:18`. Use `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55432/pendia`. Remove only this container when finished.
- Rebase on origin/main before filing and every push. Preserve sibling code in conflicts. Never force-push. If a later rebase rewrites published commits, a normal push may be impossible; report that conflict rather than bypassing either instruction.
- TODO 1 validation: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55432/pendia bun test apps/server/src/auth/playback-tokens.test.ts` passes 14 tests and 42 assertions. `bun run --cwd apps/server check` and focused Biome checks pass. Token expiry uses an independent literal expected instant. Full source and test review accepted.
- Final results: pending.
