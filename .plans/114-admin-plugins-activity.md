# #114 Redesign: admin plugins and activity

## Summary

Plugins and Activity move into the System Settings shell from #112. Plugins shows each installed plugin as a card with its name, version, where it came from and its state, and each card opens its settings or removes the plugin. Adding a plugin goes through an install preview that lists every capability in plain words before you confirm. Registries are a grouped section where you add and remove them, and the plugins they offer sit in their own group. Activity shows what is playing, for whom, on which device, how it plays, the Version, why it transcodes, and how far along it is, updating live. Store jobs sit in their own section with progress.

## Acceptance criteria

- [ ] Installing, configuring and removing plugins and registries works as it does today, in the new design
- [ ] Activity updates live as it does today
- [ ] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [ ] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [ ] Every string follows `ui-copy`
- [ ] The repository gate is green

## TODOs

- [ ] Server: `plugins.remove` (lockfile row and settings state go in one transaction), with an API test and a line in `docs/spec/plugins.md`
- [ ] Server: playback sessions also return the Version label and duration, the user's position, and what a transcode converts, with tests
- [ ] Web helpers: where a plugin came from (`pluginOrigin`) and how a session plays (`transcodeReasons` copy, time labels), with unit tests
- [ ] Plugins screen: cards, configure sheet, remove alert, add-plugin dialog with install preview, available plugins, registries, file access, empty states
- [ ] Activity screen: now playing with artwork, method, Version, reasons and live progress; store jobs with progress and the queue; empty states
- [ ] Drop both screens from the legacy list; restyle `ConfigForm` and `FilesSwitch` on the design system; `DESIGN.md`
- [ ] Screenshots before and after, keyboard, screen reader, reduced motion and high contrast passes
- [ ] Full gate

## Notes

- The API had no way to remove a plugin, and the brief asks for remove on each card. `plugins.remove` is the smallest addition: it deletes the lockfile row and the plugin's settings state in the settings transaction, and every process unloads it on the settings notify. The installed folder is content-addressed and stays as a cache.
- The session list had no Version, position or reason. It now joins the Version's label and duration and the user's progress row, and derives `reasons` from the stored decision: `video`, `audio`, `subtitles` (burned in) and `hdr` (tone mapped). Only a transcode has reasons; a remux repackages without converting.
- The registry a plugin came from is not stored. The card matches the plugin's source against the registry entries; a source no registry lists shows as npm, a folder or the tarball's host.
