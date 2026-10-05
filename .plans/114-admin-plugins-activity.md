# #114 Redesign: admin plugins and activity

## Summary

Plugins and Activity move into the System Settings shell from #112. Plugins shows each installed plugin as a card with its name, version, where it came from and its state, and each card opens its settings or removes the plugin. Adding a plugin goes through an install preview that lists every capability in plain words before you confirm. Registries are a grouped section where you add and remove them, and the plugins they offer sit in their own group. Activity shows what is playing, for whom, on which device, how it plays, the Version, why it transcodes, and how far along it is, updating live. Store jobs sit in their own section with progress.

## Acceptance criteria

- [x] Installing, configuring and removing plugins and registries works as it does today, in the new design
- [x] Activity updates live as it does today
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] Server: `plugins.remove` (lockfile row and settings state go in one transaction), with an API test and a line in `docs/spec/plugins.md`
- [x] Server: playback sessions also return the Version label and duration, the user's position, and what a transcode converts, with tests
- [x] Web helpers: where a plugin came from (`pluginOrigin`, `registryLabel`, `entryAction`) and how a session reads (`clock`, `deliveryLine`, `transcodeLine`), with unit tests
- [x] Plugins screen: cards, configure dialog, remove alert, add-plugin dialog with install preview, available plugins, registries, file access, empty states
- [x] Activity screen: now playing with artwork, method, Version, reasons and live progress; store jobs with progress and the queue; empty states
- [x] Drop both screens from the legacy list; restyle `ConfigForm` and `FilesSwitch` on the design system; `DESIGN.md`
- [x] Screenshots before and after, keyboard, screen reader, reduced motion and high contrast passes
- [x] Full gate

## Notes

- The API had no way to remove a plugin, and the brief asks for remove on each card. `plugins.remove` is the smallest addition: it deletes the lockfile row and the plugin's settings state in the settings transaction, and every process unloads it on the settings notify. The installed folder is content-addressed and stays as a cache.
- The session list had no Version, position or reason. It now joins the Version's label and duration and the user's progress row, and derives `reasons` from the stored decision: `video`, `audio`, `subtitles` (burned in) and `hdr` (tone mapped). Only a transcode has reasons; a remux repackages without converting. The decision does not record whether a video transcode came from the codec or the bitrate cap, so the screen says what is converted rather than guessing why.
- The registry a plugin came from is not stored. The card matches the plugin's source against the registry entries; a source no registry lists shows as npm, a local folder or the tarball's host.
- Configure is a dialog rather than a sheet, matching the group editor from #112. It holds what the plugin can do, its file access when it has `files`, and its settings.
- A failed plugin shows Restart instead of its switch, since turning it on is what restarts it.
- The Available row says Install, Update or Installed by comparing the registry's latest version with the installed one.
- Activity keeps the 10 s reload and the session event stream; progress moves on each reload. The Version label already names the source, so a transcode's line names its output and node instead ("To 720p on athena").
- The base gained `Progress` and dialogs that scroll inside the viewport while this slice was in flight; Activity and the plugin dialogs use them.
- Fixture data for screenshots: the real webhooks plugin, two scratch fixture plugins (one with files and settings, one that fails on setup), the official registry plus one that answers 404, four heartbeated sessions (direct play, remux, two transcodes) and a 90-minute generated film so a store job runs long enough to show progress.
- Gate on the tree committed as `42de419`, after merging `origin/feat/107-design-system` at `a854f2f`:
  - `bun install --frozen-lockfile`: no changes.
  - `bun run lint`: clean, apart from 9 warnings in `app.css` that the base already has.
  - `bun run check`: 0 errors, 0 warnings.
  - `bun run build`: 6 of 6 tasks.
  - `bun test` with `DATABASE_URL`: 1439 pass, 3 skip, 0 fail.
  - `bun test` without it: 857 pass, 603 skip, 0 fail.
- Round 2 gate on the tree committed as `5f48891`, 2026-10-05:
  - `bun install --frozen-lockfile`: no changes.
  - `bun run lint`: clean, apart from the same 9 warnings in `app.css`.
  - `bun run check`: 0 errors, 0 warnings.
  - `bun run build`: 4 of 4 tasks.
  - `bun test` with `DATABASE_URL`: 1605 pass, 3 skip, 0 fail.
  - `bun test` without it: 999 pass, 627 skip, 0 fail.
- Accessibility, on the rendered app: tab order runs the nav, Add plugin, then each card's switch, Configure and Remove. Escape closes dialogs and returns focus. The card switch is named by the plugin, the Available and registry buttons carry the plugin or registry name, and the progress bars expose role, name, value and max. High contrast rings the cards and panels; reduced motion drops the dialog zoom and the bar easing is the only movement left.
