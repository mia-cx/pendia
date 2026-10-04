# #95 #99 jsonb columns stored as JSON strings, and an unordered events read

## Summary

- #95: drizzle's `jsonb` column runs `JSON.stringify` on every write. Bun SQL then sees a JS string bound to a `jsonb` parameter and encodes it as a JSON string. Postgres ends up holding `"{\"oidc\":...}"` instead of `{"oidc":...}`. Drizzle parses it back on read, so the app works, but raw SQL (`->`, `?`, `||`) sees a string. Fix it once with a shared column type, unwrap existing rows in a migration, and drop the workarounds.
- #99: `transcode.test.ts` reads `session.state` events without `ORDER BY` and asserts their order. Order by `events.id`, and fix any other read of `events` that relies on row order.

## Acceptance criteria

- [ ] Every `jsonb` column stores real JSON (`jsonb_typeof` is `object`, `array`, or the value's own scalar type) on drizzle `insert`, `update().set()` and `onConflictDoUpdate`.
- [ ] One shared column type does this; no call site changes.
- [ ] A migration unwraps existing double-encoded rows in every affected column. A setting whose real value is a plain string survives untouched, and the migration does not fail on it.
- [ ] The README OIDC upsert and `probe-cache.test.ts` use plain `jsonb` again.
- [ ] Reads of `events` that assert order use `ORDER BY events.id`.

## TODOs

- [x] Shared `jsonb` column type in `db/schema/common.ts`, used by every `jsonb` column including `jobs.payload`. Validation: `db/jsonb.test.ts` writes every `jsonb` column through insert, update and upsert and checks `jsonb_typeof`; `drizzle-kit generate` reports no schema change; server `check`.
- [ ] Migration `0013` unwraps double-encoded strings in each affected column. Validation: `db/jsonb.test.ts` seeds every column through drizzle's own `jsonb` (the old path), plus plain-string settings written by raw SQL, runs the migration, and checks the result.
- [ ] Remove the string workarounds in the server README and `probe-cache.test.ts`. Validation: `probe-cache.test.ts` on Postgres; the README upsert runs in the jsonb test.
- [ ] Order the `session.state` reads in `api/transcode.test.ts` and `transcoder/sessions.test.ts` by `events.id`. Validation: both files on Postgres.
- [ ] Full gate. Validation: the commands in the brief, results below.

## Notes

### Measurement before the fix (step 1)

Real Postgres 18, Bun 1.4.2, drizzle-orm 0.45.2. Each row written through drizzle `insert`, `update().set()` and `onConflictDoUpdate` on the real table (foreign keys off with `session_replication_role = replica`), then read with `jsonb_typeof`:

| column | insert | update | upsert |
| --- | --- | --- | --- |
| `settings.value` (object) | string | string | string |
| `settings.value` (plain string) | string, text `"…"` | string | string |
| `libraries.configuration` | string | string | string |
| `files.chapters` | string | string | string |
| `streams.disposition` | string | string | string |
| `probe_cache.result` | string | string | string |
| `events.payload` | string | string | string |
| `transcoder_capabilities.backends` | string | string | string |
| `session_registry.decision` | string | string | string |
| `jobs.payload` | object | object | object |

- Cause: `PgJsonb.mapToDriverValue` is `JSON.stringify`. Postgres types the parameter `jsonb`, and Bun JSON-encodes whatever JS value it gets for a `jsonb` parameter, so the already stringified text becomes a JSON string.
- `jobs.payload` uses a `customType` with no `toDriver`, so Bun receives the object and encodes it once. That is why the `payload->>'…'` queries and `jobs_payload_type_check` work.
- Raw SQL writes store real values: `jsonb_build_object` in `auth/rate-limit.ts` and `'true'::jsonb` in `auth/accounts.ts`.
- Column defaults (`'[]'::jsonb`, `'{}'::jsonb`) are real arrays and objects. Only explicit writes are strings.
- A live bug hides here: `watcher/http.ts` filters cached probes with `probe_cache.result ? 'keyframesSeconds'`. On a string row that never matches, so the watcher re-probes files it already has.
- The pass-through `customType` is not enough on its own: Bun binds a JS number or boolean as `int4` or `bool`, and Postgres rejects that for a `jsonb` column. `settings.value` is typed `JsonValue`, so the shared type sends `JSON.stringify(value)` cast `::text::jsonb`. The `::text` matters: `$1::jsonb` would type the parameter `jsonb` and Bun would encode the string again. Measured: object, array, string, number, boolean and null all store as their own type on all three paths.

### Fix

- `jsonb` in `db/schema/common.ts` replaces drizzle's `jsonb` in every schema file, and the old `jobPayload` type. `drizzle-kit generate` reports no schema changes.
- `db/jsonb.test.ts` writes one row per `jsonb` column, plus string and number settings, through insert, update and upsert, and checks `jsonb_typeof` and the drizzle read. A second test fails when a new `jsonb` column has no case. With the old `JSON.stringify` encoding swapped back in, the test fails on `settings.value` with `string`.
- Validation: `jsonb.test.ts` 2 pass; `probe-cache`, `metadata/settings`, `auth` and `server-id` tests 108 pass; server `check` clean.

### Migration rule

- Legacy drizzle writes stored every value as a string whose text is JSON. That includes the scalar settings `server.id` and the playback signing key, stored as text `"<value>"` with quotes. Unwrapping only `{` and `[` would leave those quoted, and the new column type would then read `server.id` back with quotes, changing the id clients key saved servers by.
- So the migration unwraps a `jsonb` string when its trimmed text starts with `{`, `[` or `"` and `IS JSON` accepts it (Postgres 16 and later; compose and CI run 18). A plain string written by raw SQL, such as a provider key `abc` or `{not json`, does not match and stays as it is. No writer stores a top-level number or boolean through drizzle, so number-like strings are left alone.

### #99

- Order-dependent reads of `events` without `ORDER BY`: `api/transcode.test.ts` (the issue) and `stateEvents` in `transcoder/sessions.test.ts`.
- Left as they are: `transcoder/sessions.test.ts` `segment.ready` uses `toContain`; `libraries/jobs.test.ts` and `metadata/jobs.test.ts` assert lists of identical `library.changed` rows, which match in any order; `transcoder/index.ts` reads one row by id; `api/events.ts` already orders.
