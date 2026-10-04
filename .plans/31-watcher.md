# #31 Watcher role

## Summary

Add `--role watcher`: a process on the storage host, configured with the api URL, an API key token and a map from local paths to Library ids. It watches each path with inotify, batches and debounces file events, and pushes them to the api as library-relative changes. It also runs scan jobs for its Libraries on local disk: it claims them from the api, walks and probes locally, and reports the files and probe results, which the api writes. The api accepts both on `/api/watcher/*` behind the watcher token. A compose snippet shows the watcher on the storage host.

## Acceptance criteria

- [ ] Creating, moving and deleting files in a local fixture tree produces events at the api within 1 s, with library-relative paths.
- [ ] A walk requested for a library runs on the watcher and its probe results land in the database.
- [ ] A missing or wrong token is rejected.
- [ ] The documented compose snippet runs the watcher against a local folder.

## TODOs

- [x] Split each scan into a disk source and a database write: a `ScanSource` walks, probes and re-checks files, with the current local behaviour as the default, so a report from elsewhere can feed the same write.
  - Validation: existing scan, jobs, changes and webhooks tests pass unchanged against `DATABASE_URL`. Done: `bun test src/libraries src/jobs`, 154 pass.
- [x] Accept watcher event batches at `POST /api/watcher/events` behind a Bearer API key with `manage-libraries`, feeding library-relative changes into the existing 10 s directory debouncer.
  - Validation: tests for a missing, wrong and session token (401), a path escaping the root (400), and a batch that becomes one scan job with relative paths. Done: `bun test src/watcher src/libraries/webhooks.test.ts`, 16 pass.
- [x] Route scan jobs of watched Libraries to the watcher: `POST /api/watcher/claim` records a heartbeat and claims one scan job for the watcher's Libraries, `POST /api/watcher/jobs/<id>` writes the reported files and probes and completes or fails the job, and workers skip scan jobs of Libraries with a live heartbeat.
  - Validation: tests that a worker leaves a watched Library's scan queued, and that a claimed job plus a reported probe writes Items, Versions, Files, Streams and the probe cache. Done: `bun test src/watcher src/db/db.test.ts`, 16 pass; `src/jobs src/libraries src/mediums` unchanged.
- [ ] Add the watcher role: read `PENDIA_API_URL`, `PENDIA_WATCHER_TOKEN` and `PENDIA_WATCH`, watch each path recursively, turn create, close-write, move and delete into file changes (moves paired by inode), push them, and run claimed scans with the local walker and ffprobe.
  - Validation: a fixture-tree test against a stub api sees add, move and delete within 1 s with relative paths; a database test requests a library scan through the api and finds the watcher's probe results in `probe_cache` and Streams.
- [ ] Document the watcher in the server README and add a compose snippet for the storage host; run it against a local folder.
  - Validation: `docker compose -f compose.watcher.yaml config`, and the watcher container started from it pushes events for a local folder.
- [ ] Run the full gate and record the real results here.
  - Validation: `bun install --frozen-lockfile`; `bun run lint`; `bun run check`; `bun run build`; `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55531/pendia bun test`; `bun test`.

## Notes

- The watcher token is an API key, like the arr webhook secrets (auth.md: "API keys per integration"). The watcher sends it as `Authorization: Bearer`, never in the URL. Session tokens are rejected.
- `PENDIA_WATCH` maps Library ids to local roots: `<library-id>=<path>` entries separated by commas. Library ids, not names: names are not unique.
- inotify comes from Bun's recursive `fs.watch`, which is inotify on Linux and adds watches for new directories itself. It reports `rename` and `change` without move cookies, so the watcher keeps a path to inode index of its tree and pairs a vanished path with a new path of the same inode as a move. Directory events expand into file changes from that index, so the api only ever sees file adds, moves and deletes, like an arr webhook. A file is reported after 200 ms without further writes, which stands in for close-write during a long copy.
- Scan jobs stay one `scan` job type on the one queue. A watcher heartbeat per Library (30 s) routes them: workers skip scan jobs of a Library with a live heartbeat, and the api claims them for the watcher. When the watcher stops, workers take the Library's scans back over NFS.
- The watcher learns cached probe keys for the scope from the claim, so it only probes files whose size or mtime changed.
- The heartbeat is `libraries.watcher_seen_at` (migration 0008), set by every claim. The watcher claims at least every 5 s, also while a job runs, so a long probe never lets the 30 s heartbeat lapse.
- The watcher sends raw ffprobe JSON plus its keyframe index. The api parses it with the same schema as a local probe, so the report needs no second probe schema.
- Abrupt loss of a watcher mid-job leaves that job running, the same documented gap as an abrupt worker loss in the queue.
- The watcher reports every regular file. The api keeps only changes to files the Library's medium accepts, the same test the walker applies, so subtitles, partial downloads and `.pendia` artwork never trigger a scan. A rename from a non-media name to a media name (`Alien.mkv.part` to `Alien.mkv`) becomes an add; the reverse becomes a delete.
- The `all` role does not start an in-process watcher. The issue's acceptance criteria name only the standalone watcher.
