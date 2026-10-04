# #69 #74 Change detection fixes: cross-show moves and library-root webhook paths

## Summary

Two change-detection bugs, both in `apps/server/src/libraries/changes.ts` and `webhooks.ts`.

#69: a move that lands on another Show's existing file deletes the whole destination Show, because the collision branch deletes the destination's root subtree. A move between two Shows also passes webhook validation and queues only the destination folder, which can leave the Episode under the source Show while its File points into the destination.

#74: a webhook change whose scan folder is the library root (`"."`) is accepted with 202. The scan job then rejects every root job that carries changes, so it fails each attempt and applies nothing.

## Acceptance criteria

- [x] A move onto an existing file replaces only the colliding destination Item, never its whole root subtree.
- [x] A move whose source and destination fall in different root Items (two Shows) is a removal at the source plus a scan of the destination folder. Progress does not follow it.
- [x] A move within one root keeps today's behaviour, Progress included.
- [x] A webhook move into another Show or Movie queues scans for both folders.
- [x] A webhook change whose scan folder is the library root answers with the `InvalidWebhookError` 400 and queues nothing: both a delete of the root itself and a file directly in the root.
- [x] Tests: one Episode moved onto another Show's Episode deletes only that Episode, and every other Season and Episode of the destination Show survives. After a cross-show move, the Episode belongs to the destination Show.

## TODOs

- [x] 1. Replace only the colliding Item, and apply a cross-root move as a removal plus a destination scan.
  - `applyScanChanges`: a collision deletes the destination's Version when both Files share one Item, else the destination Item's subtree. After the collision, a move whose destination path lies in another root Item's folder removes the source File like a file delete. Otherwise the move re-paths the File as before.
  - Validation: new tests in `changes.test.ts` for the collision onto another Show's Episode and for a cross-show move without a collision, including the source-folder job running first. Existing move tests pass.
  - Done: both new tests fail on the old `changes.ts` and pass now. `bun test src/libraries/ src/watcher/` with `DATABASE_URL`: 157 pass, 0 fail.
- [x] 2. Queue both folders for a webhook move, and reject library-root scan folders.
  - `submitChanges` computes one scan folder per path: the Show folder for Sonarr, the Movie folder for Radarr, `"."` at the library root. A `"."` folder for the change or a move's source throws `Webhook path must name a folder inside the library root.` A move into another Show or Movie also queues the move on the source folder, without provider ids.
  - Validation: `webhooks.test.ts` covers a Radarr file directly in the root, a delete of the root itself, and a cross-show Sonarr move that queues both folders.
  - Done: both new tests fail on the old `webhooks.ts` and pass now. `bun test src/libraries/webhooks.test.ts` with `DATABASE_URL`: 15 pass, 0 fail.
- [x] 3. Document the root rejection and cross-show moves in `apps/server/README.md`.
  - Validation: the webhook section states the root 400 and that a cross-show move does not carry Progress.
- [x] 4. Run the full repository gate.
  - From the repo root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55563/pendia bun test`, and `bun test` without `DATABASE_URL`.
  - Validation: all pass, and Notes record the real results.
  - Done after merging `origin/main` at `f7e5ab3`: install clean, lint clean (376 files), check clean, build clean. With `DATABASE_URL`: 1326 pass, 3 skip, 0 fail. Without: 774 pass, 573 skip, 0 fail.

## Notes

- A root Item is a Show or Movie: an Item without a parent. The destination root is the root Item whose canonical folder holds the destination path. With no such Item (a Show folder rename into a new folder), the move stays within its root.
- One exception to "only the colliding Item": a duplicate root goes whole. A scan of a renamed Show folder that runs before the move arrives creates a second Show from the moved Files. The existing test `a show folder rename keeps hierarchy identity and canonical folders` covers it, and replacing only its Episode would leave that Show standing, so the rename would count as cross-show and drop Progress. A destination root counts as a duplicate when it differs from the source root and every one of its Files matches a source-root File on size and mtime. A rename keeps both, so the early scan recorded the same stamps the source rows hold. A real second Show holds its own files, which never share a size and mtime with the source's, so only its colliding Episode goes. Review on #97 rejected a first version that compared paths against the batch: a one-Episode Show whose only file was overwritten passed it and was deleted whole.
- The collision runs before the root check. A Movie moved onto another Movie's file replaces that Movie and then re-paths into its folder, so the moved Movie keeps its Progress.
- A Sonarr file directly in the shows root used to queue a scan of a folder named after the file, which did nothing. It now gets the same 400 as the Radarr case, because its scan folder is `"."` too.
- The webhook queues the source folder only when the move leaves its Show or Movie (`leavesRoot`). A move within one root keeps today's single destination job. Review on #97 showed why: a Movie with two Versions that moves one File into a new folder relocates the Movie, and a scan of the old folder then conflicts on the File left behind.
- The source-folder job carries the move without provider ids: Sonarr's ids name the destination Show, and the source Show's scan would match them and conflict. Either job order gives the same result, because the second application finds no File at the old path.
- The watcher keeps its single destination job. `applyScanChanges` now handles a cross-show move inside that one job. A watcher file directly in a movies root still queues a `"."` job; #74 covers webhooks only.
