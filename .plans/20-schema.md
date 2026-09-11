# #20 Schema and migrations under an advisory lock

## Summary

The Drizzle schema for the core and both mediums, exactly as the glossary and ADRs 0006 and 0007 define them, plus the tables the later slices already decided on: users, groups and permissions, sessions and api keys, settings, the plugin lockfile, the job queue, the session registry, transcoder capabilities and segment timelines. UUIDv7 ids everywhere. A migration runner in the api role that takes a Postgres advisory lock so replicas never race. pg_trgm enabled for search later.

## Acceptance criteria

- [ ] A fresh database migrates from empty; running the runner again is a no-op.
- [ ] Two api processes started together: one migrates, the other waits on the lock and continues.
- [ ] Inserting a show, season and episode tree populates the closure table so that "all episodes under this show" is one query.
- [ ] Deleting a version cascades to its files and streams; provider ids are unique per provider and entity.
- [ ] Schema tests cover the tree, the cascade and the uniqueness rules, and run in CI against a real Postgres.

## TODOs

- [ ] Dependencies and config: `drizzle-orm` on the Bun SQL driver and `drizzle-kit` in `apps/server`; a `db` module with a client factory that reads `DATABASE_URL`; `.worktrees/` added to `.gitignore`; drizzle config pointing migrations at `apps/server/drizzle`.
- [ ] Core schema: libraries, items with kind and parent, the item ancestors closure table, versions, files, streams, contributors, credits, artwork, provider ids, segment timelines. Column choices follow the glossary; nullable columns stay few.
- [ ] Per-kind extension tables keyed on item id: movies, shows, seasons, episodes, with the columns the scan rules and next up need (season and episode numbers, an episode end number for multi-episode files, air dates, show status).
- [ ] Users and access: users with local and OIDC identity fields, groups with a permission list, user groups, per-user permission overrides, per-user settings (bitrate cap, content-rating ceiling), library access, sessions with hashed tokens and device fields, api keys, invites.
- [ ] Per-user marks: progress per item with the version and format the position was made on, favourites, ratings.
- [ ] Operational tables: settings as key and JSON value, plugin lockfile, jobs as the queue spec describes, session registry, transcoder capabilities per node.
- [ ] Tree helpers in the db module: insert an item under a parent and maintain the closure rows; move an item; delete an item with its subtree. Tests against a fixture tree.
- [ ] Migration runner: the first migration enables pg_trgm; the runner takes `pg_advisory_lock` on a fixed key, applies pending migrations with Drizzle's migrator, releases; wired into the api role's startup before the server listens; a `db:generate` script for the next slices.
- [ ] Tests against a real Postgres from `DATABASE_URL`: migrate from empty twice, two runners racing, the tree query, the cascade, the uniqueness rules. A Postgres service container in the CI checks job; tests fail loudly when `DATABASE_URL` is unset in CI and skip with a clear message locally.
- [ ] A short "Database" section in the server README: how to run Postgres from compose for tests, generate a migration, and how the runner behaves.

## Notes

- Phase one: Astra reads the specs and writes its approach per TODO; the orchestrator reviews it against the criteria and posts it on the issue before phase two writes code.
- Implementation is delegated to Codex (gpt-6-astra); the orchestrator commits per TODO by staging paths.
