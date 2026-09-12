# #23 API foundation: oRPC, OpenAPI, typed client, SSE

## Summary

Build the first-party API from ADR 0010. Procedures are defined once with Effect Schema and served twice: the RPC handler the SvelteKit client calls through a typed client, and OpenAPI REST endpoints with a generated OpenAPI document. Add server-sent events per client fed by Postgres LISTEN and NOTIFY, resumable with Last-Event-ID. Add the card and detail item shapes and a keyset pagination helper that returns a connection. Typed host errors become HTTP errors at the boundary. Authentication reuses the auth slice. The api role keeps hosting the web app on the same origin.

## Acceptance criteria

- [x] A procedure defined once is callable through RPC from the typed client and through REST with the same schema, and appears in the OpenAPI document.
- [x] The typed client calls `me` and a paginated list end to end from the web app.
- [x] An event published with NOTIFY from a second process reaches an SSE client; after a reconnect with Last-Event-ID the missed events arrive.
- [x] An unauthenticated call answers 401 and a forbidden one 403 through the error mapping.
- [x] Effect never appears in a client-facing type.

## TODOs

- [x] Add the API dependencies and the shared client-facing shapes.
  - Add `effect@3.22.1`, `@orpc/server@1.15.0`, `@orpc/client@1.15.0` and `@orpc/openapi@1.15.0` to `apps/server`.
  - Add `src/api/schema.ts`: the item card shape, the item detail shape, the `me` result, the connection combinator and the event union. Outputs stay identity schemas, so encoded and decoded forms match.
  - Add `src/api/pagination.ts`: opaque cursor encoding over `(addedAt, id)`, the keyset predicate and the page builder returning `{ items, cursor }`.
  - Validation: colocated pagination tests for cursor round-trip, rejected cursors and page assembly. Server typecheck and build.
  - Done: api/schema.ts, api/pagination.ts, api/pagination.test.ts, deps pinned exact in apps/server/package.json. bun test pagination.test.ts: 4 pass / 0 fail (14 expects). tsc check, bun build and biome check clean. Commit `0cd1be8`.
- [x] Map typed host errors to HTTP errors at the boundary.
  - Add `src/api/errors.ts`: tagged Effect errors for unauthenticated, forbidden, not found and invalid input, an adapter from `AuthError`, and the boundary runner that turns a failed effect into an `ORPCError` and a defect into a 500.
  - Add `src/api/context.ts`: the request context, the base builder with the shared error map, and the authentication middleware over the auth slice's `authenticate`. Export the session token reader from `auth/http.ts` and use it in both places.
  - Validation: colocated tests asserting each auth code maps to its HTTP status and that a defect answers 500 without leaking its message. Server typecheck and build.
  - Done: api/errors.ts, api/context.ts, api/errors.test.ts; auth/http.ts exports readSessionToken. bun test errors.test.ts: 5 pass / 0 fail (31 expects) covering all ten auth codes, a host defect and a direct ApiError; auth/http.test.ts: 5 pass / 0 fail against pendia-test-pg-23. tsc check, bun build and biome check clean. Commit `d47d5f3`.
- [x] Define the router once and serve it over RPC and REST in the api role.
  - Add `src/api/router.ts` with `me`, `items.list` and `items.get`, each with an Effect Schema input and output and an explicit REST route.
  - Add `src/api/handler.ts` mounting the RPC handler on `/rpc` and the OpenAPI handler on `/api`, returning nothing when neither matches.
  - Wire the handler into `api.ts` and `index.ts`, keeping `/api/auth`, the health routes and the web app unchanged.
  - Validation: Postgres tests over real HTTP for the same procedure through `/rpc` and `/api`, the paginated list across pages, 401 without credentials and 403 without the view permission. Server typecheck and build.
  - Done: api/items.ts, api/router.ts, api/handler.ts, api.ts takes a handlers object, index.ts passes both, api/router.test.ts; runApi's defect log now keeps Cause.pretty while the 500 stays bare. bun test src/api: 19 pass / 0 fail; api+auth-http+roles: 15 pass / 0 fail, both against pendia-test-pg-23: identical RPC/REST payloads, three-page cursor walk, 401 on both transports, denied-view 403, me over session and API key, 404 and 400. tsc check, bun build and biome check clean. Commit `404ee54`.
- [x] Generate the OpenAPI document from the same procedures.
  - Add `src/api/openapi.ts`: the Effect Schema to JSON Schema converter and the cached document, served at `/api/openapi.json`.
  - Validation: a test asserting the document lists every procedure path once with the card properties on the list response, and that the document is valid JSON with an OpenAPI version. Server typecheck and build.
  - Done: api/openapi.ts with EffectSchemaConverter and a memoised generator, handler answers GET /api/openapi.json, api/openapi.test.ts plus two router.test.ts cases. bun test src/api: 26 pass / 0 fail (88 expects). The document reports openapi 3.1.1, declares 400/401/403/404 on the list operation and carries no $ref into #/$defs. tsc check, bun build and biome check clean. Commit `07b5969`.
- [x] Publish events through Postgres and stream them to SSE clients.
  - Add the `events` table to the operations schema with a generated Drizzle migration.
  - Add `src/api/events.ts`: `publishEvent` writing the row, notifying the channel and pruning past the retention window, and the per-process broker holding one LISTEN and serving resumable subscriptions.
  - Add the `events.stream` procedure and its broker wiring in the api role.
  - Validation: Postgres tests where a second process publishes and an SSE client receives it, and where a reconnect with Last-Event-ID delivers the events missed while disconnected. Server typecheck and build.
  - Done: events table and drizzle/0001_clever_amphibian.sql, api/events.ts (publishEvent, startEventBroker, subscribe, stop), events.stream on the router, ApiContext.events, Bun idle timeout lifted on the stream routes, index.ts starts the broker before the api server, api/events.test.ts, db.test.ts counts updated to 33 tables and 2 journal rows. bun test src with Postgres: 108 pass / 0 fail; without DATABASE_URL: 33 pass / 75 skip. tsc check, bun build and biome check clean. Commit `fe3fd36`.
- [x] Call the API from the web app through the typed client.
  - Add `@orpc/client` and the workspace server dependency to `apps/web`, allow TypeScript extension imports in its tsconfig, and add `src/lib/api.ts` creating the typed client against `/rpc`.
  - Validation: a Postgres test that drives the web app's client factory against a live api role for `me` and a paginated list, plus assignability assertions proving the client-facing types are plain. Web typecheck.
  - Done: server exports map `@pendia/server/api` types-only, web gets @orpc/client 1.15.0 plus @orpc/server and @pendia/server as devDependencies, allowImportingTsExtensions in web tsconfig, web/src/lib/api.ts, api/client.test.ts. bun test events+client: 7 pass / 0 fail against pendia-test-pg-23; the mutual-assignability checks prove the client types are plain JSON. `bun run --cwd apps/web check` reports 0 errors and `bun run --cwd apps/web build` writes the static site. effect is not resolvable under apps/web/node_modules. The cross-process SSE test now parks the subscriber on its wake with a warm-up event before the second process publishes, so the three-second budget can only be met through NOTIFY. Commit `a26a58f`.
- [x] Document the API and run the final gate.
  - Add the API section to the server README: routes, the card and detail shapes, cursor semantics, error codes, the event channel, retention and the Last-Event-ID limits.
  - Validation: frozen install, lint, check, build, the full test suite with disposable Postgres, and the suite without DATABASE_URL. Record the real results in the notes.
  - Done: README API section appended. Final gate below.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/api`, branch `feat/23-api-foundation`, based on `f8c6ac1`. One commit per TODO with `Refs #23`. `.devin` stays uncommitted.
- Sources read: issue #23, ADR 0010, CONTEXT.md, the topology and auth specs, the plugin API declarations, the Bun capabilities research, the server api role, auth slice, db client and testing helpers, the jobs queue and worker, the web app and the server README.
- oRPC 1.15.0 is the current stable line and was published on 2026-08-08. The 2.0 betas carry the Effect integration package; the stable line does not, so this slice brings its own converter. Effect 3.22.1 is the newest release older than a week.
- Verified against the installed packages before planning: `Schema.standardSchemaV1` satisfies oRPC's Standard Schema input and output validation, the OpenAPI handler answers an event iterator with `text/event-stream` including `id:` lines, the standard handler reads the `Last-Event-ID` request header into the handler's `lastEventId`, and a converter over `JSONSchema` puts Effect Schemas into the generated document.
- `JSONSchema.make` emits a draft-07 `$schema` and hoists named schemas into `$defs`, which dangle once oRPC splits a schema into query parameters. The converter uses `JSONSchema.fromAST` with the OpenAPI 3.1 target, skips the top-level reference and inlines the definitions it collected.
- Effect stays inside the host: handlers build effects and the boundary runner returns plain values. Client-facing outputs are identity schemas over JSON types, so no transformation and no Effect type crosses the boundary. Instants cross as ISO strings.
- The connection shape is `{ items, cursor }`, matching `ItemQuery` in the plugin API. The cursor is an opaque base64url encoding of `(addedAt, id)`, and the keyset predicate compares that row pair against the `items_added_idx` ordering.
- `me` is the auth handler procedure worth wrapping: it is a GET with no cookie work. Setup, login and logout stay on the auth slice handler because they set cookies, check Origin and consume login windows, which the oRPC boundary would have to re-implement.
- Event resumption needs durable events, so events are a Postgres table with a bigserial id, and the SSE stream reads from it rather than from memory. NOTIFY carries only the new id; each api process holds one LISTEN and wakes its subscribers, which then read their own rows. That keeps one connection per process, not per client.
- Events are pruned past a ten-minute retention window when the next event is published. A reconnect whose Last-Event-ID is older than the window resumes from the oldest event kept, so a long disconnect can miss events. A client that sends an unparseable Last-Event-ID starts from the present.
- Known limitation of a sequence-assigned id: an event inserted before a client disconnects but committed during the disconnect can carry an id below one already delivered, and a replay by `id >` then skips it. Closing that needs commit-order tracking, which is outside this slice.
- The event union covers the four cross-process events the topology names: library changed, job progress, session state and segment ready. Publishers for them arrive with their own slices.
- The web app typechecks the server's router source through a type-only import, which needs `allowImportingTsExtensions` in its tsconfig. Verified in a throwaway spike: `bun run --cwd apps/web check` reports no errors with that option and fifty-one extension errors without it. `effect` stays out of the web app's dependencies, so a leaked Effect type would fail that check.
- Bun's ten-second idle timeout is lifted for the event stream on both transports, `/api/events` and `/rpc/events/stream`, because the same procedure is reachable through either and both would hit the idle kill. Every other route keeps the default.
- `effect` is absent from the web app's dependency tree: neither `@orpc/client` nor `@orpc/server` depends on it, `effect` does not resolve under `apps/web/node_modules`, and the `@pendia/server` devDependency is consumed through a types-only exports entry that Vite erases.
- Tests follow the repository conventions: colocated, real Postgres from DATABASE_URL, disposable databases through `withDatabase`, skipped with one message locally and failing in CI without it. Test Postgres for this slice is `pendia-test-pg-23` on port 55423, removed when the run finishes.
- The second publishing process in the SSE test is a spawned Bun process against the same disposable database, because the criterion is about NOTIFY crossing processes rather than crossing connections.
- Review posture is adversarial at the HTTP boundary. Apply the trigger test to every review finding. Reviewers are the bots already on the repository.
- Push only after the pre-PR rebase, so no force-push is needed. The parent owns merging.
- PR #54 review fixes, one commit each:
  - `items.list` ignored per-library access rows when no `libraryId` was given: the check consulted only the global grant while the query stayed unfiltered. `viewableLibraryIds` in auth/permissions.ts now runs the existing `checkPermission` over every library, the list filters with `inArray`, and an empty set answers 403. `540e1c3`, plus `6fa13bf` for a lint-clean scope annotation.
  - Every authenticated subscriber received every event, and an open stream never re-authenticated. `subscribe` now takes the caller plus a `revalidate` callback, filters every event through `canReceive` (per-kind audience, deny on unknown) on live and replay paths, and revalidates before each batch and every thirty seconds idle so revocation ends the stream. `e78cf27`.
  - `stop()` awaited the api server's graceful stop before the broker, so an open SSE response held shutdown forever. The broker now stops first. `8b4ebea`; the regression test `stop resolves while an event stream is open` returned false at three seconds against the old order.
  - The driver returns `added_at` as a millisecond Date, so the encoded cursor truncated a same-millisecond row out of every later page. Instants now cross the API as the database's own `to_char` UTC text at microsecond precision, the cursor carries that stamp and `after` binds it back with `::timestamptz`. `8f0388b`; the regression test `paging does not drop rows that share a millisecond` dropped the earlier of two same-ms rows before the fix.
  - The generated document declared no security, so generated clients saw the API as anonymous. `generate` now receives `securitySchemes` (`bearerAuth`, `cookieAuth` naming the real `pendia_session` cookie) and a root `security` listing both as alternatives; the generator merges `components` without dropping them. `835f68d`.
- Final gate, all run from the repo root after the review fixes: `bun install --frozen-lockfile` clean (115 installs, 218 packages, no changes); `bun run lint` clean (76 files); `bun run check` 6/6 turbo tasks (web svelte-check 0 errors, 0 warnings); `bun run build` 4/4 turbo tasks (server bundle, web static site written); `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55423/pendia bun test` 120 pass / 0 fail / 594 expects across 18 files; `bun test` without DATABASE_URL 34 pass / 86 skip / 0 fail with the skip message printed once.
