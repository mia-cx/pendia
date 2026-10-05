# #110 Redesign: player with custom controls

## Summary

Replace the browser's video controls with Pendia's own, modelled on the Apple TV app's player on macOS. The video fills the screen. The top carries only Back and the title. A bottom bar over a soft gradient holds a thin scrubber (elapsed left, remaining right), centred transport, volume, Picture in Picture, fullscreen and one settings gear whose menu holds Version, Audio and Subtitles in short grouped sections with a check on the current choice. Every control fades after a few seconds of stillness and returns on pointer move, tap or key press.

Player state lives in one browser-free module with `bun test` coverage. The Svelte components are thin views over it. Playback, token refresh and session reports stay in `player.ts`, and Track and Version changes still go through the session API unchanged.

## Acceptance criteria

- [x] The native controls are gone and every listed control works: scrubber with buffered ranges and the time under the pointer, skip 10 s both ways, volume and mute, the settings menu (Version, Audio, Subtitles), Picture in Picture and fullscreen (WebKit-prefixed on iOS)
- [x] Nothing is pinned above the video; Back and the title hide with the other controls
- [x] Space, the arrow keys, F, M and C work, and double tap skips on touch
- [x] Track and Version changes go through the current session API, unchanged, and keep the position
- [x] The player state module has tests for play and pause, seek, buffering, track and Version switches, notices and auto-hide
- [x] The server's headless-browser playback test passes, driving the new Play control
- [x] Subtitles are styled with `::cue` and lift above the visible control bar
- [x] Auto-hide keeps the controls up while paused, while a menu is open and while keyboard focus is in the bar, and hides the cursor with them
- [x] Every control checked against real files: a direct-play mp4 and an HLS remux, with two audio tracks and a subtitle track
- [x] Labelled before and after screenshots at 1440x900 and 390x844, light and dark, plus hover, focus and open-menu states, during real playback
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] 1. Player state module `src/lib/player-state.ts` with `bun test` coverage; `player.ts` gains a `paused` start option
- [x] 2. Slider `media` variant (thin white track, buffered ranges, thumb on hover or focus) and the radio item's leading check
- [x] 3. Player view: stage, top bar, bottom bar, scrubber, settings menu, notices, buffering, gestures, shortcuts, fullscreen, Picture in Picture, `::cue` and the caption lift; the route keeps one Player across Version switches
- [x] 4. `player-browser.test.ts` starts playback through the Play control over CDP
- [x] 5. `DESIGN.md`: the player moves out of the legacy list into Screens and Media components
- [x] 6. Real-playback review and screenshots, before and after
- [ ] 7. Full gate, PR, babysit

## Notes

- Version switches pass the current position as the new session's start. Resume alone would lose it, since the server resumes across Versions only when they share a segment timeline. Audio and subtitle choices reset on a Version switch, since Stream indexes belong to a File.
- A switch or retry keeps a paused viewer paused, through a new `paused` option on `play()`.
- A Version switch updates `?version=` in place without remounting the player, so the video, the controls and an open menu stay put.
- Auto-hide holds for keyboard focus only (`:focus-visible`), so a clicked button does not keep the controls up forever.
- The scrubber and volume use white, as the Apple TV player does, rather than the tint. The focus ring stays tint.
- Caption lift uses `::-webkit-media-text-track-container`, which Chromium and WebKit honour. Firefox shows captions at the default line.
- The token block is declared on both `:root` and `.dark`. Lightning CSS resolves `light-dark()` where a token is declared, so before this a `.dark` subtree inside a light page kept light materials: the player's menus and the Home hero's glass buttons rendered light in the light scheme. This touches every dark subtree, not only the player.
- While a notice shows, the bottom band hides and goes inert, since none of its controls can act on a stopped session. The top band stays for Back.
- On phones the transport sits mid-screen over a small radial scrim rather than a full-screen dim, so the picture stays readable.
- The Home hero before and after shots are not pixel-comparable: the carousel landed on different slides. Computed styles confirm the hero's glass buttons now resolve to dark materials.

## Gate

Run on `e00f3d8` (before merging the admin slice from `feat/107-design-system`):

- `bun install --frozen-lockfile`: exit 0, no changes
- `bun run lint`: exit 0, 525 files, 9 warnings (the existing `noImportantStyles` in `app.css`)
- `bun run check`: exit 0, svelte-check 0 errors, 0 warnings
- `bun run build`: exit 0, 4 of 4 tasks
- `bun test` with `DATABASE_URL`: exit 0, 1412 pass, 3 skip, 0 fail, 128 files
- `bun test` without `DATABASE_URL`: exit 0, 831 pass, 602 skip, 0 fail, 128 files

After merging the admin slice (`970aafd`): install, lint (541 files, the same 9 warnings), check (0 errors, 0 warnings) and build all exit 0, and `bun test apps/web` gives 89 pass, 0 fail.
