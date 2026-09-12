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

| Method | Route | JSON input | Result |
| --- | --- | --- | --- |
| POST | `/api/auth/setup` | `username`, `password`, optional `displayName` | 201 with `user`, or 409 `SETUP_COMPLETE` |
| POST | `/api/auth/login` | `username`, `password`, `clientName`, `deviceId`, `deviceName` | `token`, `user`, `session` |
| GET | `/api/auth/me` | None | `user`, `credential` |
| POST | `/api/auth/logout` | None | Revokes the current session or API key and returns `ok` |

Setup and login require `Content-Type: application/json`. Request bodies have a 16 KiB limit.
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
  "trustedProxyAddresses": []
}
```

Numbers must be positive safe integers. The two seconds settings allow at most 315360000; sessionMaxAgeSeconds also accepts null.
Settings apply on the next request. Invalid stored settings fail closed. Admin settings screens belong to a later slice.
A session maximum age also limits existing sessions by creation time. Clearing it does not clear a session's stored expiry.

Login attempts share independent address and normalized-account windows across API replicas. Successful logins consume an attempt too.
A short Postgres transaction updates both counters before password work. Blocked requests do not extend either window.
Expired counters under `auth.login.*` are removed on a later attempt. Configuration and setup markers remain intact.

### Reverse proxies

Trust uses exact IP addresses, not CIDRs or hostnames. IPv6 spelling is normalized; IPv4-mapped IPv6 matches the IPv4 address.
Untrusted socket peers cannot supply forwarded address or protocol headers. Trusted chains are read from right to left, stopping at the first untrusted hop.
`Forwarded` takes precedence over `X-Forwarded-For`. Malformed hops stop traversal.
Trusted proxies must preserve Host and sanitize forwarded protocol headers. `X-Forwarded-Proto` supports a single sanitized value or a list matching the address chain.
No proxy is trusted by default. Plain HTTP remains supported; TLS normally terminates at the trusted reverse proxy.
