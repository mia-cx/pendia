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

- [ ] Roots in the schema, with every call site on one resolver. `library_roots`, `files.root_id`, `probe_cache.root_id` and the `0015` migration with a backfill of roots, Files, probe cache rows and queued scan changes. `libraries/roots.ts` resolves a File's absolute path, a root's path and an Item's home root. Each call site in the inventory below moves onto it. Test fixtures create Libraries through one helper.
  - Validation: a migration test seeds the `0014` schema with two single-root Libraries, a movie and a show with Files, progress, artwork and a stored Version, migrates, and asserts every row survives and each File points at its Library's root. `bun test src/libraries src/stored src/playback src/subtitles src/plugins src/metadata` with `DATABASE_URL`.
- [ ] Multi-root scans. A folder scan walks the folder in every root and a full scan walks every root. Grouping runs on root-relative paths; each root's files become their own Versions of one Item. Reconciliation is per root. Scan changes carry their root.
  - Validation: scan tests for one movie in two roots (one Item, two Versions, each Version's File in its own root), a Show in two roots, and per-root reconciliation.
- [ ] Change detection by root. Webhooks locate a path by the longest root across Libraries; a move between two roots of one Library becomes a delete at the source and an add at the destination. The watcher reads `PENDIA_WATCH=<root-id>=<path>`; events, claims, heartbeats and reports carry roots.
  - Validation: webhook tests for a path under root `B` and a move from `A` to `B`; watcher tests on the new protocol.
- [ ] Roots in the libraries API. `create` takes `roots`, `get` and `list` return `roots`, and `update` adds, repoints and removes roots in one transaction under the Library's row lock. Overlapping and relative roots fail with the index of the root at fault; removing the last root fails.
  - Validation: service and router tests for each criterion: overlap in the same and another Library, last-root removal, removal deleting emptied Items, repoint keeping Item ids and progress after the rescan.
- [ ] Admin UI. The create form takes root rows you can add and remove. The Library page gains an edit form with the name, editable root rows with remove buttons, an add-root row, and each root's id with a copy button. Saving with a root removed asks first. Errors show next to their field. The setup wizard sends its one root as `roots`.
  - Validation: `bun run check` for the web app; screenshots of the create form with two roots, the edit form, the removal prompt and an overlap error.
- [ ] Docs: `CONTEXT.md` (Library, Root, home root), server README API and watcher sections, `docs/operations.md` watcher form, the plugin API files comment.
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
