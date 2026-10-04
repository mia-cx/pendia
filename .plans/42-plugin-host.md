# #42 Plugin host: manifest, capability-gated host, lockfile, registries, admin screens

## Summary

Build the plugin host from `docs/spec/plugins.md`, `docs/spec/plugin-api.d.ts` and ADRs 0005 and 0011. Parse and validate the `pendia` block of a plugin's `package.json`. Keep installed plugins in the Postgres lockfile and install them into a local folder per process, from a folder, a tarball URL, npm or a registry entry. Import a plugin on first use and hand it a host object built from its approved capabilities, with every value crossing the boundary checked as plain data. Bridge providers into matching, events and cron jobs through the queue, routes under `/plugins/<name>/`, shelves and config from the manifest's JSON Schema. A plugin that throws is marked failed, logged and unloaded while the server keeps serving. Admin screens list plugins and registries, install with a capability review and the files warning, flip the files switches and enable or disable plugins.

## Acceptance criteria

- [x] A test plugin without the files capability has no files member; one with it shows the warning at install and stops working when the global switch is off.
- [x] A plugin that throws is disabled and logged while the api keeps answering.
- [x] Installation works from a local folder and from a registry manifest, and a fresh process reinstalls from the lockfile.
- [x] A provider registered by a plugin takes part in matching.
- [x] Capability gating and the boundary check have tests.

## TODOs

- [x] 1. Manifest, plain-data boundary and config schema.
  - `plugins/manifest.ts` reads a package.json into name, version and manifest. It checks the npm name, the semver version, the host API range against `1.0.0`, known capabilities, `items:write` only with `items:read`, network hosts, a config schema of type object, and a relative entry inside the package.
  - `plugins/boundary.ts` accepts JSON values plus `Uint8Array` and rejects functions, class instances, symbols, bigints and non-finite numbers with the offending path.
  - `plugins/config.ts` validates config against the JSON Schema subset the settings form renders: type, properties, required, enum, items, default.
  - Sync `docs/spec/plugin-api.d.ts` and `packages/plugin-api/plugin-api.d.ts`: `Item.libraryId`, and files methods take a library id next to the library-relative path.
  - Validation: unit tests for each module; server check and build.
- [x] 2. Plugin settings, lockfile installer and registries.
  - One `plugins` settings row holds the global files switch, registry URLs (official registry by default) and per-plugin state keyed by name: approved capabilities, enabled, failure, files switch, config. Writes take the settings lock and notify `pendia_plugins`.
  - Resolve a source to package bytes: a folder, an http(s) tarball, an npm spec through the npm registry, or a registry entry's source. Integrity is SRI sha512 of the tarball, or of a canonical file listing for a folder. Install into `PENDIA_PLUGIN_DIR` atomically and verify the lockfile integrity on reinstall.
  - Registries: add and remove URLs, read `pendia-registry.json`; a GitHub repo URL maps to the file at its root.
  - Validation: disposable Postgres and local Bun.serve tests for folder, tarball, npm and registry installs, integrity mismatch and reinstall into an empty folder.
- [x] 3. Host object and runtime with failure isolation.
  - `plugins/host.ts` builds the host per plugin from approved capabilities minus switched-off files, so an absent capability is an absent member. items, progress, files (path containment, per-call switch check), network-restricted fetch, config and log.
  - `plugins/runtime.ts` imports a plugin on first use, calls setup, holds its registrations and wraps every plugin callback: a throw or boundary violation marks it failed with the error logged and unloads it.
  - Validation: Postgres tests with fixture plugins for gating, the boundary check, the files switches and a throwing setup.
- [x] 4. Bridges: providers, events, jobs, routes, shelves.
  - Plugin metadata providers join the provider-fetch job's provider list; subtitle and artwork providers are held for their consumers.
  - Events: publishing an event enqueues one `plugin` job per enabled plugin with the events capability, so delivery is once across workers and NOTIFY wakes them. Emit item, progress and playback events at their write sites.
  - Jobs: `schedule` runs `Bun.cron` in worker processes, each tick enqueues a deduplicated `plugin` job, and the worker runs the handler.
  - Routes under `/plugins/<name>/` with the caller's user id; plugin home shelves join `shelves.home`, item shelves through `shelves.item`.
  - Validation: Postgres tests for a provider in matching, event delivery, a cron-enqueued job, a route and a shelf.
- [x] 5. Admin API and server wiring.
  - `plugins` and `registries` procedures behind manage-server: list, preview a source, install with the previewed integrity, enable and disable, files switches, config.
  - `startPendia` creates the runtime, installs from the lockfile in the background, listens for changes and routes `/plugins/`.
  - Validation: API tests for the acceptance criteria end to end, including the api answering after a plugin throws and a fresh process reinstalling.
- [x] 6. Admin screens.
  - `/admin/plugins`: installed plugins with state, failure, enable and disable, per-plugin files switch, config form; install with preview, capability review and the files warning; global files switch; registries with add, remove and install from an entry.
  - Validation: web check and build; manual run against a local server.
- [x] 7. Docs and final gate.
  - Document sources, the registry format, the lockfile, the plugin folder and the settings shape in `docs/spec/plugins.md` and `apps/server/README.md`.
  - Run `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test` and `bun test` without it.

## Notes

- Unattended run. Worktree `.worktrees/plugin-host`, branch `feat/42-plugin-host`, base `main`. Postgres container `pendia-test-pg-42` on 127.0.0.1:55542.
- Approval is the install itself: the admin installs the previewed integrity, so the approved capabilities are the manifest's at that integrity. Only `files` has switches, per plugin and global, off for good or until a time.
- A host is built when a plugin loads. A switch change unloads loaded plugins so the next use rebuilds the host; a files call also checks the switch, so a flip takes effect at once in every process.
- Files paths are library-relative, which needs the library: `Item` gains `libraryId` and files methods take it. Contract change recorded in both d.ts copies.
- Events use the queue rather than a bare LISTEN per worker, so a second worker replica does not deliver an event twice and a failed delivery retries. The queue's NOTIFY wakes workers. `scan.completed` needs per-run counts that scans do not track yet; it is declared but not emitted in this slice.
- A plugin provider takes part in matching once its id is in the metadata `providerOrder` setting, which is the existing admin setting for order and enablement.
- Installed plugins are imported from the local folder without their dependencies. Plugins ship a bundled entry, as `plugins/webhooks` does with `bun build`.
- The official registry defaults to `https://github.com/mia-cx/pendia`; slice #43 adds its `pendia-registry.json`. Until then the admin screen shows that registry's 404 as its error line.
- Shelves changed from a `shelves.plugins` procedure: plugin home shelves join `shelves.home`, so the existing web Home renders them, and `shelves.item` lists item shelves. The item pages do not render item shelves yet. Both filter to items the caller may view.
- Workers import plugins with `jobs` at startup, because schedules are registered in setup. Everything else imports on first use.
- A schedule tick's job id is a UUIDv5 of plugin, schedule and minute, inserted with on-conflict-do-nothing. Workers need clocks within the same minute.
- An install that fails in one process (an unreachable source) is logged and leaves the plugin enabled; only plugin code that throws marks it failed.
- Plugin results pass the plain-data check, not a full shape check per provider type. A provider that returns plain data of the wrong shape fails the provider-fetch job, not the plugin.
- Asynchronous throws a plugin starts outside a host call, such as its own timers, are not attributed to the plugin.
- Gate at 2d397fc (main 27bc7b4 merged): `bun install --frozen-lockfile`, `bun run lint`, `bun run check` and `bun run build` passed. `bun test` without DATABASE_URL: 0 fail, 465 skip. With DATABASE_URL: 1056 pass, 3 fail. Two failures were `Failed to start server. Is port 3001 in use?` in the wizard and libraries api tests, because another session's `node src/worker.ts` held port 3001. The third was the timing test "a request at the idle boundary waits for cleanup and revives" under the shared machine's load. All 22 tests in those three files passed on rerun with `PENDIA_TRANSCODER_PORT=3542`. The later commits change only admin CSS and docs; web check passed after them.
- Final gate at 233ae08 (main 31c340f merged, conflicts in `api.ts` and `index.ts` kept both the plugin and Jellyfin handlers): install, lint, check and build passed; `PENDIA_TRANSCODER_PORT=3542 DATABASE_URL=... bun test` 1086 pass, 0 fail; `bun test` without it 623 pass, 473 skip, 0 fail. The port override sidesteps another session's process on 3001.
- Gate at 3294bda (main 8ddfc36 merged: TVDB, artwork stores, Jellyfin). Main's provider-fetch now matches whole Show trees; plugin providers join its `metadataProviders`, and `item.updated` fires for each Item that matches. No new migration: `plugin_lockfile` already existed. Install, lint, check and build passed; with DATABASE_URL 1120 pass, 3 skip, 0 fail; without it 645 pass, 488 skip, 0 fail.
- Screens checked in headless Chromium at 1440x900 and 390x844, light and dark. The journey (switch a plugin's file access, save settings, reload) persisted both changes.