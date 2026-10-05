# #110 Redesign: player with custom controls

## Summary

Replace the browser's video controls with Pendia's own, modelled on the Apple TV app's player on macOS. The video fills the screen. The top carries only Back and the title. A bottom bar over a soft gradient holds a thin scrubber (elapsed left, remaining right), centred transport, volume, Picture in Picture, fullscreen and one settings gear whose menu holds Version, Audio and Subtitles in short grouped sections with a check on the current choice. Every control fades after a few seconds of stillness and returns on pointer move, tap or key press.

Player state lives in one browser-free module with `bun test` coverage. The Svelte components are thin views over it. Playback, token refresh and session reports stay in `player.ts`, and Track and Version changes still go through the session API unchanged.

## Acceptance criteria

- [ ] The native controls are gone and every listed control works: scrubber with buffered ranges and the time under the pointer, skip 10 s both ways, volume and mute, the settings menu (Version, Audio, Subtitles), Picture in Picture and fullscreen (WebKit-prefixed on iOS)
- [ ] Nothing is pinned above the video; Back and the title hide with the other controls
- [ ] Space, the arrow keys, F, M and C work, and double tap skips on touch
- [ ] Track and Version changes go through the current session API, unchanged, and keep the position
- [ ] The player state module has tests for play and pause, seek, buffering, track and Version switches, notices and auto-hide
- [ ] The server's headless-browser playback test passes, driving the new Play control
- [ ] Subtitles are styled with `::cue` and lift above the visible control bar
- [ ] Auto-hide keeps the controls up while paused, while a menu is open and while keyboard focus is in the bar, and hides the cursor with them
- [ ] Every control checked against real files: a direct-play mp4 and an HLS remux, with two audio tracks and a subtitle track
- [ ] Labelled before and after screenshots at 1440x900 and 390x844, light and dark, plus hover, focus and open-menu states, during real playback
- [ ] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [ ] Every string follows `ui-copy`
- [ ] The repository gate is green

## TODOs

- [ ] 1. Player state module `src/lib/player-state.ts` with `bun test` coverage; `player.ts` gains a `paused` start option
- [ ] 2. Slider `media` variant (thin white track, buffered ranges, thumb on hover or focus) and the radio item's leading check
- [ ] 3. Player view: stage, top bar, bottom bar, scrubber, settings menu, notices, buffering, gestures, shortcuts, fullscreen, Picture in Picture, `::cue` and the caption lift; the route keeps one Player across Version switches
- [ ] 4. `player-browser.test.ts` starts playback through the Play control over CDP
- [ ] 5. `DESIGN.md`: the player moves out of the legacy list into Screens and Media components
- [ ] 6. Real-playback review and screenshots, before and after
- [ ] 7. Full gate, PR, babysit

## Notes

- Version switches pass the current position as the new session's start. Resume alone would lose it, since the server resumes across Versions only when they share a segment timeline. Audio and subtitle choices reset on a Version switch, since Stream indexes belong to a File.
- A switch or retry keeps a paused viewer paused, through a new `paused` option on `play()`.
- A Version switch updates `?version=` in place without remounting the player, so the video, the controls and an open menu stay put.
- Auto-hide holds for keyboard focus only (`:focus-visible`), so a clicked button does not keep the controls up forever.
- The scrubber and volume use white, as the Apple TV player does, rather than the tint. The focus ring stays tint.
- Caption lift uses `::-webkit-media-text-track-container`, which Chromium and WebKit honour. Firefox shows captions at the default line.
