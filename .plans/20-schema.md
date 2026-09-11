# #20 Schema and migrations under an advisory lock

## Summary

The Drizzle schema for the core and both mediums, exactly as the glossary and ADRs 0006 and 0007 define them, plus the tables the later slices already decided on: users, groups and permissions, sessions and api keys, settings, the plugin lockfile, the job queue, the session registry, transcoder capabilities and segment timelines. UUIDv7 ids everywhere. A migration runner in the api role that takes a Postgres advisory lock so replicas never race. pg_trgm enabled for search later.

## Acceptance criteria

- [x] A fresh database migrates from empty; running the runner again is a no-op.
- [x] Two migration runner processes started together apply one migration set under the lock, per the amended validation scope.
- [x] Inserting a show, season and episode tree populates the closure table so that "all episodes under this show" is one query.
- [x] Deleting a version cascades to its files and streams; provider ids are unique per provider and entity.
- [x] Schema tests cover the tree, the cascade and the uniqueness rules, with a real Postgres service configured in CI.

## TODOs

- [x] Docs corrections: apply amendment 12 exactly before schema work.
- [x] Dependencies and config: `drizzle-orm` on the Bun SQL driver and `drizzle-kit` in `apps/server`; a `db` module with a client factory that reads `DATABASE_URL`; `.worktrees/` added to `.gitignore`; drizzle config pointing migrations at `apps/server/drizzle`.
- [x] Core schema: libraries, items with kind and parent, the item ancestors closure table, versions, files, streams, contributors, credits, artwork, provider ids, segment timelines. Column choices follow the glossary; nullable columns stay few.
- [x] Per-kind extension tables keyed on item id: movies, shows, seasons, episodes, with the columns the scan rules and next up need (season and episode numbers, an episode end number for multi-episode files, air dates, show status).
- [x] Users and access: users with local and OIDC identity fields, groups with a permission list, user groups, per-user permission overrides, per-user settings (bitrate cap, content-rating ceiling), library access, sessions with hashed tokens and device fields, api keys, invites.
- [x] Per-user marks: progress per item with the version and format the position was made on, favourites, ratings.
- [x] Operational tables: settings as key and JSON value, plugin lockfile, jobs as the queue spec describes, session registry, transcoder capabilities per node.
- [x] Tree helpers in the db module: insert an item under a parent and maintain the closure rows; move an item; delete an item with its subtree. Tests against a fixture tree.
- [x] Migration runner: the first migration enables pg_trgm; the runner takes `pg_advisory_lock` on a fixed key, applies pending migrations with Drizzle's migrator, releases; wired into the api role's startup before the server listens; a `db:generate` script for the next slices.
- [x] Tests against a real Postgres from `DATABASE_URL`: migrate from empty twice, two runners racing, the tree query, the cascade, the uniqueness rules. A Postgres service container in the CI checks job; tests fail loudly when `DATABASE_URL` is unset in CI and skip with a clear message locally.
- [x] A short "Database" section in the server README: how to run Postgres from compose for tests, generate a migration, and how the runner behaves.

## Notes

- Batch B final validation: `bun install`, `bun run lint`, `bun run check` and `bun run build` passed. Fresh check/build runs with `--force --cache-dir=/tmp/pendia-schema-turbo-cache` passed without shared-cache write warnings. `DATABASE_URL=...:55432/pendia bun test` passed 15 tests; no-URL `bun test` passed 10 and skipped 5 with one message. `CI=true DATABASE_URL=... bun run test --cache-dir=/tmp/pendia-schema-turbo-cache` passed all 15 through Turbo. Final Compose build and healthy startup passed, followed by `down -v` and `docker rm -f pendia-test-pg`. `git diff --check` passed. No git writes or PR. OptMem could not save a note because its storage is read-only.
- TODO 10: The README's `docker compose -p pendia-db-test -f compose.yaml -f compose.test.yaml up -d --wait postgres`, `DATABASE_URL=...:55433/pendia bun test` and `down -v` passed. All 15 tests passed. `bun run --cwd apps/server db:generate` reported no schema changes.
- TODO 9: `DATABASE_URL=... bun test apps/server/src/db/db.test.ts` passed all 5 tests. `bun test` without the URL passed 10 and skipped 5 with one message. `CI=true bun test` without the URL failed as required. Server typecheck passed. CI uses postgres:18; Turbo passes DATABASE_URL and CI and never caches tests. GitHub CI execution awaits the orchestrator.
- TODO 8: `bun run --cwd apps/server check`, source runner twice, reserved-backend probe, dist startup and `docker compose build` passed. `PENDIA_HOST_PORT=3001 docker compose up -d --wait` brought both services healthy, with 32 tables, one journal row and pg_trgm; `docker compose down -v` cleaned up. Build needed `DOCKER_CONTEXT=rootless BUILDX_CONFIG=/tmp/pendia-buildx` for this sandbox. Docker validation overlapped TODO 9 test writing.
- Squash: `bun run --cwd apps/server db:generate` produced one SQL file and snapshot. Applying it with `psql -v ON_ERROR_STOP=1` to disposable `pendia_squash` passed with 32 tables and pg_trgm. Preserved both stored-file triggers and column-specific SET NULL. The boundary validator precedes tables because their checks require it.
- TODO 7: `bun run --cwd apps/server check` and `DATABASE_URL=... bun /tmp/pendia-tree-check.ts` passed. Closure matched recursive traversal after inserts, season and episode moves, and subtree deletion. Cycle rejection and transaction composition passed.
- Batch validation: `bun install`, `bun run lint`, `bun run check --force --cache-dir=/tmp/pendia-turbo-cache` and `bun run build --force --cache-dir=/tmp/pendia-turbo-cache` passed. All five SQL migrations applied to empty `pendia_schema_fresh` with `psql -v ON_ERROR_STOP=1`, creating 32 tables and 44 foreign keys. `bun run --cwd apps/server db:generate` reports no schema changes. `docker rm -f pendia-test-pg` removed the disposable container. No git writes or PR. Runner, tree helpers, permanent tests, image packaging and README remain for the next batch.
- TODO 6: `bun run --cwd apps/server check`, `db:generate`, migration 0004 and `/tmp/pendia-operations-check.sql` through `psql -v ON_ERROR_STOP=1` passed. Queue order, reusable concurrency keys, retry limits, JSON capabilities, node routing and cascades checked. Jobs and plugin lockfile follow the spec's column lists, without added lifecycle timestamps. The registry has no credentials or Format column; nodes have no heartbeat.
- TODO 5: `bun run --cwd apps/server check`, `db:generate`, migration 0003 and `/tmp/pendia-marks-check.sql` through `psql -v ON_ERROR_STOP=1` passed. Upserts, Item/Format agreement, finite positions, rating range, cascades and Version deletion preserving position/completion/count passed. Migration SQL explicitly uses `ON DELETE SET NULL (version_id)`.
- TODO 4: `bun run --cwd apps/server check`, `db:generate`, migration 0002 and `/tmp/pendia-access-check.sql` through `psql -v ON_ERROR_STOP=1` passed; `bun -e` verified bytea hash round-trips. Identity rules, permission vocabulary, scoped access, token lengths/uniqueness, nullable expiry and cascades passed. Group seeding belongs to the migration runner in the next batch.
- TODO 3: `bun run --cwd apps/server check`, `db:generate` and `psql -v ON_ERROR_STOP=1` for migration 0001 and `/tmp/pendia-extensions-check.sql` passed. Specials, episode ranges, numbering uniqueness, kind agreement and cascades checked. Parent agreement stays in the next batch's tree helpers.
- TODO 2: `bun run --cwd apps/server check`, `db:generate`, `docker exec -i pendia-test-pg psql -U pendia -d pendia -v ON_ERROR_STOP=1 < apps/server/drizzle/0000_breezy_runaways.sql` and `bun /tmp/pendia-core-check.ts` passed. UUIDv7, bigint, arrays, JSON, fractional timestamps, timeline ordering, stored File rejection, provider/artwork uniqueness, credits and cascades checked. Bun/Drizzle timestamp string mode returns incorrect offsets; Date mode preserves instants at millisecond precision. Custom migration SQL enforces timeline ordering and fileless stored Versions.
- TODO 1: `bun install` and `bun run --cwd apps/server check` passed; server-workspace `bun -e` verified a real query, invalid URLs and cleanup. Bun needs `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache` here.
- Docs corrections: `git diff --check` passed; inspected the diff against all six exact amendment edits.
- Phase one: Astra reads the specs and writes its approach per TODO; the orchestrator reviews it against the criteria and posts it on the issue before phase two writes code.
- Implementation is delegated to Codex (gpt-6-astra); the orchestrator commits per TODO by staging paths.
- Phase one done: Astra's plan and the review are on issue #20. Decisions: no speculative columns; simple session registry and node table; plain foreign keys on extension tables; Stored Versions have no File rows; timelines per cut; stored Versions keep their audio tracks; permission precedence, verified-email OIDC linking and a 0 to 10 rating scale are fixed in the docs by this slice.
