# #102 Libraries: several roots per Library, and editing a Library's roots

## Summary

A Library gets one or more roots in a new `library_roots` table, and `libraries.root_path` goes away. Every File records its root, and its path stays relative to that root. One resolver turns a File's root and path into an absolute path, so no call site joins a root and a path by hand. Scans walk a folder in every root and merge the same canonical folder into one Item, with each root's files as Versions. Webhooks and the watcher locate changes by root. The API and the admin UI create Libraries with several roots and edit them: add, repoint and remove, with confirmation before a removal.

## Acceptance criteria

- [ ] Migrating a database with single-root Libraries keeps every Library, Item, File and progress row. Each File points at its Library's one new root.
- [ ] A Library with roots `A` and `B` holding `Blade Runner (1982)` in both scans to one movie Item with two Versions. Playback of each Version reads from the right root.
- [ ] Removing root `B` leaves the Item with only `A`'s Version. Removing a root that holds an Item's only Files deletes that Item.
- [ ] Repointing a root to a new path where the same files exist keeps Item ids and watch progress after the rescan.
- [ ] An overlapping root, in the same or another Library, is rejected. So is removing the last root.
- [ ] A webhook path under root `B` queues the right folder scan. A move from `A` to `B` ends with the File under `B`.
- [ ] The admin UI can create a two-root Library, then add, repoint and remove roots, with confirmation on removal.

## TODOs

- [x] Migration on top of `main`. `main` gained `0015_session_decision_selection`, so the roots migration is `0016_library_roots`, regenerated with `db:generate` and carrying the hand-written backfill.
  - Validation: `db:generate` reports no schema changes; `bun test src/db` with `DATABASE_URL`: 16 pass.
- [x] Server: roots in the schema, scans, change detection and the libraries API. The WIP checkpoint `aa09cf1` holds this work for the first four TODOs of the original plan: `library_roots`, `files.root_id`, `probe_cache.root_id`, the resolver in `libraries/roots.ts` with every call site in the inventory on it, multi-root scans with per-root reconciliation, webhooks and the watcher by root, and `create`/`get`/`list`/`update` with roots. What is left is the stale `scan.test.ts` type and the wizard test that still reads `rootPath`.
  - Result: `bun run --cwd apps/server check` clean; `bun test src/libraries src/watcher src/api/wizard.test.ts src/api/libraries.test.ts src/db` with `DATABASE_URL`: 194 pass, 0 fail.
  - Validation: `bun run --cwd apps/server check`; `bun test src/libraries src/watcher src/api src/db` with `DATABASE_URL`. The acceptance tests already exist: the migration test, one movie and one Show in two roots, per-root reconciliation, root removal, repoint keeping Items and progress, overlap in the same and another Library, last-root removal, a webhook under root `B` and a move from `A` to `B`, and the watcher on `PENDIA_WATCH=<root-id>=<path>`.
- [x] Admin UI. The create form takes folder rows you can add and remove. The Library page gains an edit form with the name, editable folder rows with remove buttons, an add-folder button, and each saved folder's id with a copy button. Saving with a folder removed asks first. A refused folder shows its error under its row. A pure `lib/roots.ts` holds the draft logic.
  - Result: `bun test apps/web/src/lib/roots.test.ts` 6 pass, 0 fail; `bun run --cwd apps/web check` clean; `bun run lint` clean.
  - Validation: `bun test apps/web/src/lib/roots.test.ts`; `bun run --cwd apps/web check`.
- [x] Docs: `CONTEXT.md` (Library, Root, home root), server README API and watcher sections, `docs/operations.md` and `compose.watcher.yaml` for the new `PENDIA_WATCH` form, the plugin API files comment.
  - Result: all five files updated plus `docs/spec/plugins.md`; `bun run lint` clean.
- [ ] Full gate and screenshots per the brief.

## Call-site inventory

Every non-test use of `libraries.rootPath`, of `files.path` joined to a root, and of Files or probe rows keyed by Library and path, from `rg -n rootPath apps/server/src` at f244cdf:

- `playback/direct.ts` `locateVersionFile`: File to absolute path.
- `transcoder/sessions.ts` `loadSession`: File to absolute path.
- `stored/jobs.ts` `loadStoreTarget`: source File and its stored folder.
- `stored/playback.ts`: stored segment reads.
- `stored/status.ts`: segment counts in a stored folder.
- `stored/sweep.ts` `sweepStoredFolders`: walks stored output per root.
- `stored/reconcile.ts`: Files of a folder by Library and path prefix.
- `subtitles/opensubtitles.ts`: the hash of an Item's first File.
- `subtitles/store.ts` `subtitleFolder`: the Item's home root.
- `plugins/host.ts` `libraryPath`: plugin file access.
- `libraries/probe-cache.ts`: probe cache by root and path.
- `libraries/scan.ts` `localScanSource`, `findShowOwningFiles` and both directory scans.
- `libraries/changes.ts`: Files by path in moves and deletes; colocated artwork re-keying in `updateItemCanonicalFolder` (home root).
- `libraries/webhooks.ts`: root lookup and the moved File lookup.
- `libraries/repair.ts`: the NFS repair walk, per root.
- `libraries/service.ts`: create, get, list, update, delete.
- `libraries/jobs.ts` `runScanJob`: the full-scan walk.
- `metadata/artwork-store.ts`: colocated artwork root (home root).
- `db/tree.ts` `deleteItemSubtree`: the root of deleted colocated artwork (home root).
- `watcher/http.ts`, `watcher/index.ts`: probe cache and File lookups, the watch map.
- `api/schema.ts`, `api/libraries.ts`: `Library` and `LibraryInput`.
- Web: `lib/wizard.ts`, `routes/setup/+page.svelte`, `routes/admin/libraries/+page.svelte`, `routes/admin/libraries/[id]/PolicyEditor.svelte`.

## Notes

- Decisions:
  - `library_roots.path` is unique, and a root may not equal or contain another root in any Library. A transaction-level advisory lock serializes root writes, so two concurrent writes cannot both pass the overlap check.
  - `files` references `library_roots (id, library_id)`, so a File's root always belongs to its Library.
  - `probe_cache` moves from `library_id` to `root_id`: the same relative path in two roots is two files.
  - Stored Version folders stay beside their source File, in the source File's root, instead of the Item's home root. The folder name is `<source path>.pendia/<rung>`, so it only exists beside its source. Under the home root, removing the home root would leave a complete stored Version pointing at a folder in another root that does not exist. Path-backend artwork and fetched subtitles do use the home root, as the issue says.
  - Adding or repointing roots queues one full scan of the Library, which also covers a new root.
  - Removing a root deletes its Files, the Versions left without Files, the leaf Items left without Versions, and then Seasons and Shows left without children.
  - The Jellyfin layer reports no Library folders today (`VirtualFolders` is unimplemented), so nothing there lists roots.
  - Plugin file access keeps `(libraryId, path)`. A path resolves in the first root by position that holds it, or its folder, and otherwise in the first root.
  - A watcher claims the scans of a Library only when it watches every root of it, because a scan walks every root. Its events still count for any root it watches.
  - The WIP checkpoint `aa09cf1` stays in history as one commit. It covers the first four TODOs of the original plan, so they collapse into one server TODO whose remaining fixes land as their own commit. Every later TODO gets its own commit.
  - The UI says "folder" where the API says "root", matching the server's error messages ("This folder overlaps another folder of this library.").
  - The Library page's heading and the library read move into a new `LibraryEditor.svelte`, so a rename shows in the heading at once. `PolicyEditor.svelte` keeps only the Stored Versions form.
  - A scan that walked a root which an update removes before the scan writes fails on the `files_root_library_fk` foreign key, and the job retries against the new roots. A repoint during a scan is reconciled by the full scan the update queues.
  - Colocated artwork stays in the Item's home root on disk. Removing that root leaves the artwork rows of Items another root still holds pointing at the old folder, until artwork is fetched again. The issue does not ask to move artwork, so this PR does not.
