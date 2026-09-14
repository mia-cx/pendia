# Pendia server

## Database

Run these commands from the repository root. This separate Compose project starts only disposable Postgres on port 55433.

```sh
docker compose -p pendia-db-test -f compose.yaml -f compose.test.yaml up -d --wait postgres
DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55433/pendia bun test
docker compose -p pendia-db-test -f compose.yaml -f compose.test.yaml down -v
```

Tests create and drop unique databases on that server. They leave the database named in DATABASE_URL intact.
The test role needs CREATEDB and permission to install pg_trgm and btree_gist. The Compose role has these permissions.
Missing DATABASE_URL skips database tests locally and fails in CI. Connection errors always fail.

After changing the Drizzle schema, generate the next migration:

```sh
bun run --cwd apps/server db:generate
```

Review and commit the SQL and metadata under apps/server/drizzle together.
Hand-written SQL handles the boundary validator, File and Stream origin rules, source timeline agreement and episode-range exclusion.
It also limits SET NULL to version_id on progress.
Timeline boundaries are immutable. Different boundaries need a new timeline row.
Preserve these rules when a generated migration changes their constraints.

The api and all roles apply pending migrations before listening. Other roles do not migrate.
The runner reserves one Postgres connection and holds a shared advisory lock through migrations and built-in group seeding.
Concurrent runners wait their turn. Repeated runs are no-ops. Migration failure stops startup.

Source and dist resolve apps/server/drizzle. Compiled distributions need the drizzle directory beside the binary.
The Dockerfile packages these assets. Compose checks readiness after startup completes.

## Jobs

Register module handlers with `jobRegistry.register(type, handler)` from `src/jobs/registry.ts` before startup.
The handler receives its typed payload and the claimed job. Register one handler for each supported job type.
The worker and all roles run registered handlers. Other roles leave queued jobs alone.
The api and all roles migrate first. A standalone worker needs an already migrated database.

Use `createJobQueue(db).enqueue(payload, options)` from `src/jobs/queue.ts` to enqueue work.
Options are priority, maxAttempts, runAfter, and concurrencyKey. The type comes from the payload.
Higher priority runs first. Equal priorities order by runAfter and then id.
`listJobs(db, { state, type, limit, offset })` lists jobs for the admin, newest first, with a default limit of 100.

Claims use FOR UPDATE SKIP LOCKED under a short shared advisory lock. Handlers run outside the transaction.
The key limit defaults to one. All workers sharing a queue must use the same concurrencyLimit option.
Jobs without a key have no key-specific cap. Worker concurrency defaults to four.

Claims increment attempts. Failures retry after one second, then two, doubling to a sixty-second cap.
The default maxAttempts is three. Exhausted jobs stay failed with their error stored.
Completion and failure only update the matching running attempt. A later successful attempt retains the previous error.

Enqueue commits the row and NOTIFY together. LISTEN wakes idle workers; a five-second poll catches missed notifications and future jobs.
A local timer wakes the worker when its failed job becomes eligible again.
`startJobWorker` accepts concurrency, pollIntervalMs, queueOptions, and onError options.
`startPendia` accepts workerOptions and an optional registry for an embedded server.
On SIGTERM, shutdown stops new claim loops and drains active handlers before closing Postgres.
Abrupt process loss does not recover running jobs in this slice. Handlers must be safe to retry after a reported failure.
Plugin cron scheduling belongs to the plugin host, not this queue.

## Auth

The api and all roles serve these JSON routes. Setup creates the admin account only. It does not log in.
The first accepted setup request owns a fresh instance. Keep it inaccessible to untrusted clients until setup completes.
Use a private bind address, firewall or restricted ingress during setup. Expose the instance only after creating the admin.

| Method | Route | Input | Result |
| --- | --- | --- | --- |
| POST | `/api/auth/setup` | `username`, `password`, optional `displayName` | 201 with `user`, or 409 `SETUP_COMPLETE` |
| POST | `/api/auth/login` | `username`, `password`, `clientName`, `deviceId`, `deviceName` | `token`, `user`, `session` |
| POST | `/api/auth/invites` | `email`, `expiresInSeconds` | 201 with one-time `token` and safe `invite` |
| POST | `/api/auth/invites/accept` | `token`, `username`, `password`, optional `displayName`, `clientName`, `deviceId`, `deviceName` | 201 with `token`, `user`, `session` and session cookie |
| GET | `/api/auth/oidc/login` | Query `clientName`, `deviceId`, `deviceName`, optional `invite` | 302 to the configured provider |
| GET | `/api/auth/oidc/callback` | Provider callback | 200 with `token`, `user`, `session` and session cookie |
| GET | `/api/auth/me` | None | `user`, `credential` |
| POST | `/api/auth/logout` | None | Revokes the current session or API key and returns `ok` |

Invite creation requires `manage-users` and accepts bearer or session-cookie auth. Invite tokens are random, stored only as SHA-256 digests, expire, and work once.
Invite acceptance and new OIDC accounts require a live invite. Existing OIDC subjects log in directly.
Only `email_verified: true` can link an existing account. An unverified email never links, but a matching live invite can create a separate account.
OIDC uses discovery, authorization code, state, nonce, PKCE S256, signed ID-token validation, confidential Basic client authentication, and UserInfo subject validation when advertised.

Setup, local login, invite creation and local invite acceptance require `Content-Type: application/json`. Request bodies have a 16 KiB limit.
Usernames use ASCII letters, digits, dots, underscores and hyphens, start with a letter or digit, and have at most 64 characters.
Usernames ignore surrounding whitespace and case. Passwords retain whitespace and allow 1 to 1024 characters.
Display names, client names and device names have at most 128 characters. Device IDs allow 1 to 128 characters.

Send credentials as `Authorization: Bearer <token>` or the `pendia_session` cookie. Query-string account tokens are ignored.
An invalid Authorization header never falls back to cookies. Auth responses use `Cache-Control: no-store`.
Errors return `{ "error": { "code": "...", "message": "..." } }`. Login failures use `INVALID_CREDENTIALS`; invalid sessions use `UNAUTHENTICATED`.
Rate-limited requests return 429 `RATE_LIMITED` and `Retry-After` in seconds.

Local passwords use Bun.password argon2id. Each login creates a separate session and returns its random token once.
Postgres stores SHA-256 token digests, device metadata, creation time and last seen. API keys use the same digest storage.
Authentication checks revocation, expiry and the enabled owner on every call. Tokens have no default server expiry.
Cookies are HttpOnly and SameSite=Lax on both transports. Secure applies only on effective HTTPS.
The persistent cookie has a maximum browser lifetime of 400 days, bounded by any session expiry. This does not expire native-client tokens.
POST requests reject a foreign Origin or cross-site Fetch Metadata. Native clients can omit Origin.

Server callers use these functions after authenticating the actor:

- `accounts.ts`: `setupAdmin` and `createLocalUser`. Only setup accepts anonymous account creation; later users require `manage-users`.
- `permissions.ts`: `checkPermission` and `requirePermission` for every later service. Group permissions form a union, then user overrides apply. Library rows override global view, and a matching library deny wins. Built-in admins bypass checks; disabled users do not.
- `permissions.ts`: `createGroup`, `setUserGroups` and `setPermissionOverride` require built-in admin membership. A null override restores inheritance. Membership replacement serializes on the admins group and rejects removal of the final enabled admin with `CONFLICT`.
- `sessions.ts`: `login`, `authenticate`, `listSessions`, `revokeSession`, `createApiKey`, `listApiKeys` and `revokeApiKey`. Listing and revocation require ownership or `manage-users`. API keys belong to their creator and carry an integration name.

These files live under `src/auth`. Call `login(db, input, address)` with the resolved client address, not a forwarded header string.
The setup transaction holds a Postgres advisory lock. Its `auth.setupComplete` settings marker keeps setup closed after account deletion.

### Auth settings

The `settings` row with key `auth` holds one JSON object. Missing fields use these defaults:

```json
{
  "sessionMaxAgeSeconds": null,
  "loginMaxAttempts": 5,
  "loginWindowSeconds": 900,
  "trustedProxyAddresses": [],
  "artworkRequiresAuth": false,
  "oidc": null
}
```

To enable OIDC, set `oidc` to an object:

```json
{
  "oidc": {
    "issuer": "https://id.mia.cx/application/o/pendia/",
    "clientId": "<client-id>",
    "clientSecret": "<client-secret>",
    "scopes": ["openid", "profile", "email"]
  }
}
```

The issuer, clientId and clientSecret fields are required. `openid` must be included, and scopes use OAuth scope-token characters. HTTPS is required except loopback HTTP for tests. Keep client secrets out of source control and logs.

Numbers must be positive safe integers. The two seconds settings allow at most 315360000; sessionMaxAgeSeconds also accepts null.
Settings apply on the next request. Invalid stored settings fail closed. Admin settings screens belong to a later slice.
`artworkRequiresAuth` false keeps artwork anonymous for clients such as Findroid. True requires the existing bearer token or session cookie.
A session maximum age also limits existing sessions by creation time. Clearing it does not clear a session's stored expiry.

Login attempts share independent address and normalized-account windows across API replicas. Successful logins consume an attempt too.
A short Postgres transaction updates both counters before password work. Blocked requests do not extend either window.
Expired counters under `auth.login.*` are removed on a later attempt. Configuration and setup markers remain intact.

### Authentik at id.mia.cx

In authentik Admin, go to Applications > Applications > New Application.
Application name: `Pendia`. Application slug: `pendia`.
Provider type: `OAuth2/OpenID Connect`.
Authorization flow: `default-provider-authorization-implicit-consent`.
Client type: `Confidential`. Copy the generated Client ID and Client Secret into Pendia's auth setting.
Redirect URI type: `Strict`, purpose `Authorization`.
Redirect URI: `<pendia-public-origin>/api/auth/oidc/callback`, where `<pendia-public-origin>` is Pendia's public scheme and host with no trailing slash, such as `https://pendia.example.com`.
Signing key: select an available signing key.
Selected scopes/property mappings: `openid`, `profile`, `email`.
Allowed grant type: `authorization_code`.
Issuer mode: `Each provider has a different issuer, based on the application slug`, the default.
Pendia issuer: `https://id.mia.cx/application/o/pendia/`.
Discovery document: `https://id.mia.cx/application/o/pendia/.well-known/openid-configuration`.
Authentik must emit `email` and `email_verified`. Only verified email links an existing Pendia account.
Reverse proxies and firewalls must allow server-side discovery, token, JWKS, and UserInfo requests between Pendia and id.mia.cx.

The admin settings screen is a later issue. Until then, configure OIDC with this PostgreSQL 18 upsert:

```sql
INSERT INTO settings (id, key, value)
VALUES (
  uuidv7(),
  'auth',
  jsonb_build_object(
    'oidc',
    jsonb_build_object(
      'issuer', 'https://id.mia.cx/application/o/pendia/',
      'clientId', '<client-id>',
      'clientSecret', '<client-secret>',
      'scopes', jsonb_build_array('openid', 'profile', 'email')
    )
  )
)
ON CONFLICT (key) DO UPDATE
SET value = settings.value || EXCLUDED.value,
    updated_at = clock_timestamp();
```

This preserves the existing top-level auth keys. Replace the two placeholders before execution.

Live validation after merge: set the Client ID and Secret, open `/api/auth/oidc/login?clientName=Web&deviceId=<stable-device-id>&deviceName=<browser-name>`, authenticate, and confirm `/api/auth/me` returns that session. For a first OIDC account, add `&invite=<one-time-invite-token>`.

### Reverse proxies

Trust uses exact IP addresses, not CIDRs or hostnames. IPv6 spelling is normalized; IPv4-mapped IPv6 matches the IPv4 address.
Untrusted socket peers cannot supply forwarded address or protocol headers. Trusted chains are read from right to left, stopping at the first untrusted hop.
`Forwarded` takes precedence over `X-Forwarded-For`. Malformed hops stop traversal.
Trusted proxies must preserve Host and sanitize forwarded protocol headers. `X-Forwarded-Proto` supports a single sanitized value or a list matching the address chain.
No proxy is trusted by default. Plain HTTP remains supported; TLS normally terminates at the trusted reverse proxy.

## API

The api and all roles serve one procedure router on two transports. `/rpc` carries the typed client and `/api` carries REST. `GET /api/openapi.json` answers the generated OpenAPI 3.1 document. The api role also serves `/api/auth` and the web app on the same origin.

| Procedure | REST route | Input | Output |
| --- | --- | --- | --- |
| `me` | GET `/api/me` | None | `user` and `credential` |
| `items.list` | GET `/api/items` | `libraryId`, `kind`, `limit`, `cursor` | `{ items, cursor }` of cards |
| `items.get` | GET `/api/items/{id}` | `id` in the path | the detail shape |
| `events.stream` | GET `/api/events` | `Last-Event-ID` header | `text/event-stream` |

Procedures accept the same `Authorization: Bearer <token>` or `pendia_session` cookie as the auth routes, and the generated document declares both under `securitySchemes` as root alternatives.
`me` is the only auth route wrapped as a procedure. Setup, login and logout stay on the auth handler because they set cookies, check Origin and consume login windows.

Cards carry `id`, `kind` (`movie`, `show`, `season`, `episode`), `libraryId`, `title`, `year`, `addedAt` and `posterArtworkId`, which is the selected poster's artwork id for use with `/api/artwork/{id}`.
Details add `parentId`, `overview`, `contentRating`, `genres`, `tags` and `updatedAt`. Instants are the database's own UTC text at microsecond precision.

The list connection is `{ items, cursor }` over the newest-first order, `addedAt` then `id` descending.
`cursor` is opaque, bound to that order and carries the microsecond instant, so a row that shares a millisecond with its predecessor still pages.
Without a `libraryId` the list is scoped to the libraries the caller may view, with the auth slice's own precedence rules, and answers 403 when that set is empty.
The default page is 24 and `limit` caps at 100. An unparseable cursor answers 400.

Errors map host codes to HTTP statuses:

| Auth code | Status | oRPC code |
| --- | --- | --- |
| `INVALID_INPUT`, `METHOD_NOT_ALLOWED` | 400 | `BAD_REQUEST` |
| `INVALID_CREDENTIALS`, `UNAUTHENTICATED` | 401 | `UNAUTHORIZED` |
| `FORBIDDEN` | 403 | `FORBIDDEN` |
| `NOT_FOUND` | 404 | `NOT_FOUND` |
| `CONFLICT`, `SETUP_COMPLETE` | 409 | `CONFLICT` |
| `BODY_TOO_LARGE` | 413 | `PAYLOAD_TOO_LARGE` |
| `RATE_LIMITED` | 429 | `TOO_MANY_REQUESTS` |

Anything that is not a mapped failure is a defect. The response is a bare 500 and the cause goes to the server log.

Every response from either transport carries `Cache-Control: no-store` and `Vary: Cookie, Authorization`, matching the auth routes, because the answers are personalised and a shared proxy caches on the URL. The generated document is identical for every caller, so `/api/openapi.json` stays cacheable.

Events live in the durable `events` table. Publishing inserts the row, prunes rows older than the ten-minute retention window and notifies the new id on the `pendia_events` channel, all in one transaction.
Each api process holds one LISTEN and wakes its subscribers; every subscriber then reads its own rows. Postgres sees one listener per process, not per client.

Every event reaches only its audience, on live delivery and on replay alike: `library.changed` needs view on that library, `job.progress` needs `manage-server`, and `session.state` and `segment.ready` reach the session's owner or a `manage-server` caller. An unknown kind is denied.
An open stream revalidates its credential every thirty seconds and again before any event that would be delivered past that deadline, so a revoked session or key, a disabled user or a permission change stops delivery within the interval and ends the stream — including mid-batch, where a suspended yield cannot stretch one validation over many rows.
Audience decisions are memoised per event subject — the library, the job set or the session — and cleared whenever the credential refreshes, so a long replay costs one decision per subject rather than per row while staying within the same freshness bound.

`events.stream` resumes through the `Last-Event-ID` header. A digit id within the signed bigint range replays the rows after it; a missing, unparseable or out-of-range id starts from the present.
Two honest limits: a disconnect longer than the retention window loses the pruned events, and an event committed out of sequence order during a disconnect can be skipped by an id-ordered replay.

Bun closes a connection idle for ten seconds and oRPC 1.15 sends no keep-alive comments, so the stream route lifts the idle timeout. Every other route keeps the default.

Procedures are defined once with Effect Schema in `src/api/router.ts` and stay identity schemas over plain JSON types, so Effect never crosses the boundary.
The web app calls the API through `apps/web/src/lib/api.ts`, which imports the router type only.

## Libraries and manual scans

Library administration requires `manage-libraries` on every procedure. The API exposes RPC under `libraries` and these REST routes:

| Procedure | REST route | Input | Output |
| --- | --- | --- | --- |
| `libraries.list` | GET `/api/libraries` | None | Library array |
| `libraries.get` | GET `/api/libraries/{id}` | `id` | Library |
| `libraries.create` | POST `/api/libraries` | `name`, `medium: "movies" \| "shows"`, `rootPath` | Library |
| `libraries.update` | PATCH `/api/libraries/{id}` | `id`, `name` | Library |
| `libraries.delete` | DELETE `/api/libraries/{id}` | `id` | `{ ok: true }` |
| `libraries.scan` | POST `/api/libraries/{id}/scan` | `id` | `{ jobId }` |

A Library contains `id`, `name`, `medium` and `rootPath`. Names trim surrounding whitespace and allow 1 to 128 characters. Roots must be absolute. Roots and mediums cannot change through `update`. Deleting a library removes its database records, never its files. Mutations use the auth module's origin checks.

The returned scan job walks the root and enqueues one scan per canonical movie or show folder in one transaction. Every root and directory job carries `library:<id>` as its concurrency key. The existing queue key limit applies. Worker and all roles register the built-in handler on startup. An explicit custom scan handler takes precedence.

Each media file directly inside a movie folder becomes an imported Version of that folder's Item. Nested collection folders work. Loose videos at the library root are skipped. Titles and years come from folder names such as `Alien (1979) {tmdb-348}`. Version labels come from probe dimensions, codecs and HDR. Only explicit filename tags such as `{edition-Director's Cut}` contribute to those labels.

A shows library uses each top-level show folder as canonical. `Season N` folders and `Specials` hold Episodes, with Specials as season zero. Episode names use `SxxEyy`; a range such as `S01E02-E03` becomes one Episode carrying that range. Files ending in `partN`, `ptN` or `cdN` form ordered Files in one Version. Only Episodes hold Versions; Shows and Seasons are containers.

The literal `extras` directory is always reserved, case-insensitively, even for same-name videos. Use a dated folder such as `Extras (2005)` for a movie named Extras. Other extras-category names can identify movies when the filename matches the canonical title, including `Collection/Shorts/Shorts.mkv`.

The walker skips symlinks, excluded extras directories, extra filename suffixes, `.pendia` folders and `<source>.pendia` stores. Probe results persist in Postgres by library-relative path, byte size and nanosecond mtime. Changed files get one ffprobe for streams, duration and chapters. Unchanged scans reuse the cache across processes.

Directory writes preserve Item, Version, File and Stream identities and keep curated Item metadata. Completed directory scans publish `library.changed` through the existing permission-filtered SSE stream. An empty root scan publishes the event too. A root job completing means its directory jobs were queued, not that they finished.

Scans persist container keyframe indexes on Versions. The first imported Version establishes each cut's immutable segment timeline through the playback module. Later Versions reuse it and record their own alignment. Missing or unsupported indexes set lazyIndexPending for first-play indexing. Nonzero-start indexes remain stored but cannot establish a timeline under the current playback contract. Missing-file reconciliation and change signals are covered below. Metadata providers belong to a later slice.

Scan tests generate short MKV fixtures with ffmpeg and compare their stream lists with ffprobe. Both commands must be on PATH. Database-backed scan tests use the disposable database helper described above.

### Change detection

Sonarr and Radarr report file changes through webhook routes so scans stay current between manual runs. Create one API key per integration through the auth service's `createApiKey`. The token is shown once and becomes the secret URL segment. Point Sonarr at `<pendia-origin>/api/webhooks/sonarr/<secret>` and Radarr at `<pendia-origin>/api/webhooks/radarr/<secret>` with POST. Enable Download or import, Rename, Episode File Delete and Series Delete in Sonarr, and Download or import, Rename, Movie File Delete and Movie Delete in Radarr.

The secret must be a live API key owned by a caller with `manage-libraries`. Session tokens in the URL are rejected. Wrong, revoked or expired secrets answer 401. Treat the full webhook URL as a secret and redact it from logs. Accepted payloads answer 202 with the number of translated changes. Unknown Servarr event types are accepted with zero changes. Malformed payloads and paths outside the matching medium's Library answer 400.

Absolute writer paths become library-relative paths and debounce for 10 seconds per Library directory. A burst of events queues one scan job under the Library concurrency key `library:<id>`.

A rename updates the stored File and Item paths before the scan writes, so Item, Version, File and Progress identity survive. A delete removes the missing Version, and the Item goes only when no Version remains. Provider ids from Servarr persist on the Item. Sonarr and Radarr changes both queue scans through their matching medium.

The `api` and `all` roles run a directory-mtime repair pass after startup and every 24 hours. It walks movie and show Library directories without statting files, compares each directory mtime with a snapshot kept in process memory, and queues a directory scan for every changed canonical folder and every Item folder missing on disk. Repair and manual fan-out scans carry the reconcileMissing flag, so a scan removes imported Versions whose files disappeared and the emptied movie Items, show Episodes and Seasons they leave behind. An unavailable root is skipped without deleting rows. A restart rebuilds the snapshot, so every reachable directory is checked once after boot. `POST /api/libraries/{id}/scan` remains the manual full scan.
