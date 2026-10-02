# #39 Web player with service worker shell

## Summary

Play Items in `apps/web`. A Play action on movie and episode pages opens `/play/{id}`, a full-screen player that asks `playback.plan` with a client profile read from the browser's own codec support. Direct play hands the range-request URL to the video element. Remux, and live transcode once #34 returns a URL for it, open the master playlist in hls.js, or in the browser's native HLS when hls.js cannot run. Every HLS request carries the current playback token, refreshed before it expires. Subtitles are the WebVTT renditions in the master playlist: hls.js renders them as native text tracks, chosen from the video's captions menu. Quality inside the adaptive group is hls.js's call; a Version choice stops the session and plans a new one. Progress goes through start, progress and stop, and the detail page offers to resume. A service worker caches the app shell and never media or API responses, so the app opens with the server stopped and says the server is unreachable.

## Acceptance criteria

- [ ] Direct play, remux and live transcode fixtures all play.
- [ ] Switching between stored rungs does not stall; a manual Version choice restarts cleanly.
- [ ] Subtitles are selectable and progress resumes where it left off.
- [ ] With the server stopped, the app shell still loads and shows an unreachable state.

## TODOs

- [x] 1. Cache the app shell and report an unreachable server.
  - `$lib/api.ts`: the client's fetch turns a network failure, or a 502, 503 or 504 without a JSON body, into a `ServerUnreachable` error. An aborted request keeps its own error.
  - `$lib/errors.ts`: an `UNREACHABLE` failure code with its own sentence. `hooks.client.ts` hands the code to the error page through `App.Error`, and `+error.svelte` says the server is unreachable and offers Try again.
  - `src/service-worker.ts`: install caches the build and `200.html` under a versioned cache, activate drops older caches. Build assets answer from the cache first. Navigations go to the network and fall back to the cached shell on a network failure or a 5xx. `/api`, `/rpc` and media are never intercepted.
  - Validation: `api.test.ts` reads a refused connection and an HTML 502 as `UNREACHABLE` and a JSON 503 as a normal failure; `bun run --cwd apps/web check` and `build` pass and the build holds `service-worker.js`.

- [x] 2. Add the player helpers in `$lib/playback.ts`.
  - `clientProfile(support)`: containers, video codecs with the profiles the browser decodes, audio codecs with channels, `webvtt` subtitles, and HDR when the display has a high dynamic range. `browserProfile()` wires it to `canPlayType`, `MediaSource.isTypeSupported` and `matchMedia`.
  - `withToken(url, token)` swaps the `token` query parameter, so hls.js requests carry the refreshed token. `formatPosition(seconds)` prints `12:34` or `1:02:03`.
  - Validation: `playback.test.ts` covers profiles for a browser with and without HEVC, token replacement on relative and absolute URLs, and positions.

- [x] 3. Add the player route `/play/[id]`.
  - `hls.js` 1.7.3 as a web dependency, imported only when a session is HLS.
  - `Player.svelte`: plans with the browser profile, attaches direct URLs to the video element and HLS through hls.js or native HLS, starts at `?t=` or the server's resume position, refreshes the token a minute before it expires, calls start on the first frame, progress every 10 s, on pause and at the end, and stop when the page goes away, with keepalive on pagehide.
  - The page: a dark stage with a bar holding Back, the title, and a Version select when the Item has more than one Version. A Version change stops the session and replaces the URL, so Back still leads to the detail page. A transcode plan without a URL, a plan the server refuses and a fatal media error each show a notice over the stage; the last offers Try again from the current position.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 4. Put Play on the detail pages.
  - Movie and Episode pages pass `actions` to `ItemPage`. With stored progress that is not completed, the row shows Resume from the position on the Version it was made on, and Play from start. Otherwise it shows Play.
  - Validation: `check` and `build` pass.

- [ ] 5. Test the player end to end in a browser and document it.
  - `apps/server/src/api/player-browser.test.ts`: a seeded runtime with an mp4 fixture that direct plays and an mkv fixture whose SRT forces remux. Chromium opens `/play/{id}` with a session cookie; each fixture plays to its end, and the test reads a completed Progress and the session's play method from Postgres.
  - `apps/web/DESIGN.md` records the player and the unreachable state.
  - Validation: the test passes with `DATABASE_URL` and a Chromium, and skips without either.

- [ ] 6. Verify in a real browser and run the gate.
  - Headless Chromium over CDP on a seeded runtime at 1440x900 and 390x844: Play, Resume, Play from start, a Version change, Back, token refresh past expiry, subtitles from an injected WebVTT rendition, and the server stopped after the shell was cached.
  - Validation: the full gate from the repository root, recorded below.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/stack-39-player`, branch `stack/39-player`, stacked on `stack/38-browse` (#79) at `cddf5cc`. Test Postgres `pendia-test-pg-39` on port 55539. `TMPDIR=/home/mia/.cache/pendia-tmp/39`.
- No GitHub Project is attached to the issue, so status tracking is skipped.
- The server side this issue leans on is partly later in the stack: live transcode and WebVTT renditions are #34, stored rungs and the multi-variant master playlist are #35. Today a transcode plan returns no URL. Decisions made without anyone to ask:
  - The player is written against the contract those slices fill in: any plan URL that is not direct play is a master playlist and goes through the same hls.js path, subtitles are whatever text tracks hls.js exposes, and rung switching is hls.js's own adaptive logic. Until #34 lands, a transcode plan shows a notice saying the Version needs transcoding.
  - Subtitles are chosen in the video element's own captions menu, which every browser draws for text tracks and which hls.js follows. A second, custom menu would duplicate it.
  - The player uses the video element's native controls. They are keyboard operable, labelled and familiar on every platform; a custom control set is a later design effort the PRD names.
  - hls.js runs whenever it is supported, native HLS only otherwise. Chromium 151 now answers `maybe` for native HLS, so checking native first would bypass hls.js on Chrome. Native HLS cannot rewrite segment URLs, so its token refresh swaps the source at the current position.
  - The resume prompt lives on the detail page as Resume and Play from start, so the choice is made before the player opens.
  - A Version change waits for stop before planning the next session, so the server's resume reads the position stop just wrote.
- TODO 1 done. The auth routes' `postJson` goes through the same `reachServer`, so sign-in with the server down says so too. Unexplained client errors still reach the console, since a custom `handleError` replaces SvelteKit's logging. The worker leaves `/api/`, `/rpc/`, `/healthz` and `/readyz` alone, so OIDC redirects and media URLs never meet it. `bun test apps/web` 11 pass; `check` 0 errors; `build` writes `service-worker.js` next to `200.html`.
- TODO 2 done. Codec support is asked of `ManagedMediaSource` or `MediaSource` when either exists, because that is how hls.js will decode, and of `canPlayType` otherwise. Audio channel limits follow the codec, not the speakers: browsers decode 5.1 and 7.1 and downmix. `withToken` only sees absolute URLs, since hls.js resolves every playlist URI before loading it. `bun test apps/web` 15 pass; `check` 0 errors; lint clean.
- TODO 3 done. `$lib/player.ts` owns one playback attempt: resume, plan, attach, start on the first `playing`, a heartbeat every 10 s while playing plus pause and end, token refresh, and stop. Reports run one after another, so a pause report cannot land after the end. Reported positions are clamped to the Version's probed duration, because the server rejects a position past it and a browser's `currentTime` can run a few milliseconds over. `Player.svelte` draws the bar, the stage and the notices; the page keys the player on Item, Version and start point. hls.js loads as its own 575 KB chunk only for HLS sessions. `check` 0 errors; `build` passes; lint clean.
- First browser run: the remux session never loaded, because hls.js passes the master playlist to `xhrSetup` as the bare path the plan returned and `withToken` called `new URL` on it. `withToken` now resolves against the page; fatal hls.js errors also go to the console. Fixed in its own commit with a test for the bare path.
- TODO 4 done. `PlayActions.svelte` reads Progress, picks the Version it was made on (else the first), and asks `resume` for that Version's position. Its row keeps a 44 px height while loading, so the overview never moves when the buttons arrive. If either read fails it still offers Play, and the player reports the real failure. The primary button draws `--canvas` text on `--signal`, which holds contrast in both schemes. `check` 0 errors; `build` passes; lint clean.
- Chromium 151 at `/usr/bin/chromium` decodes H.264 High and High 10, AV1, VP9, AAC, Opus and FLAC through MSE, not HEVC or AC-3, and answers `maybe` for mkv.
