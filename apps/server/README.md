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
The browser playback tests run when a Chromium binary is on PATH or PENDIA_BROWSER points at one, and skip otherwise. The web player test also needs `apps/web/build`, which `bun run build` writes.

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

## Plugins

The api, worker and all roles each run a plugin runtime. At startup it listens on `pendia_plugins` and installs every plugin in the lockfile into `PENDIA_PLUGIN_DIR`, default `pendia-plugins` under the OS temp dir, in the background. Use local disk. Each package lands in a folder named after its integrity, written to a staging folder and renamed, so two versions never share a folder and a half-written install is never imported. A fresh process with an empty folder refetches each source and refuses one whose bytes no longer match the lockfile.

The official registry, `https://github.com/mia-cx/pendia`, reads `pendia-registry.json` at the repo root. It lists the first-party plugins in `plugins/`.

A source is an absolute folder path, an http(s) tarball URL or an npm spec such as `pendia-plugin-prunarr@^1`. Npm specs resolve through `PENDIA_NPM_REGISTRY`, default `https://registry.npmjs.org`, and the lockfile records the exact version served. Integrity is SRI sha512 of the tarball, which matches npm's own, or of the sorted file listing for a folder. A folder skips `node_modules` and `.git`, so a plugin ships a bundled entry. Tarballs are capped at 64 MiB.

The `plugin_lockfile` table holds name, pinned source, version and integrity. The `settings` row with key `plugins` holds the rest:

```json
{
  "filesOff": null,
  "registries": ["https://github.com/mia-cx/pendia"],
  "plugins": {
    "pendia-plugin-prunarr": {
      "capabilities": ["items:read", "progress:read", "shelves", "jobs", "network"],
      "enabled": true,
      "failure": null,
      "filesOff": { "until": "2026-10-05T12:00:00.000Z" },
      "config": { "radarrUrl": "http://radarr:7878" }
    }
  }
}
```

`capabilities` are the approved ones: the manifest's at the installed integrity. A files switch is `null` when on, `{ "until": null }` when off for good, or off until an instant. Every write takes the settings lock and NOTIFYs `pendia_plugins`, and every process then rebuilds the hosts whose state changed. A config change instead calls the plugin's `config.onChange` handlers.

A plugin is imported on first use: a route request, a provider-fetch, a shelf, or a plugin job. Workers also import plugins with `jobs` at startup, because their schedules live in setup. Every call into plugin code is guarded. A throw, a bad default export, or a result that is not plain data marks the plugin failed in its settings, logs `plugin.failed` with the error, and unloads it in every process. Re-enabling it in the admin is the restart.

Item, progress and playback writes enqueue one `plugin` job per event and per enabled plugin with `events`, inside the write's transaction. A schedule tick enqueues a `plugin` job whose id is derived from the plugin, schedule and minute, so every worker that fires the same tick enqueues it once. Workers need clocks within the same minute. `scan.completed` is declared but not emitted yet.

Routes are served at `/plugins/<name>/<path>`, a scoped name taking two segments, for GET and POST. The handler gets the caller's user id when a session or API key authenticates, and null otherwise. POST passes the same origin check as API mutations. Plugin metadata providers join provider-fetch and take part in matching once their id is in the metadata `providerOrder`. Plugin subtitle providers join every subtitle-fetch next to OpenSubtitles. Plugin home shelves appear on Home after the medium shelves; `GET /api/shelves/item/{id}` lists item shelves. Both show only items the caller may view.

`plugins.*` and `registries.*` are the admin procedures, all behind `manage-server`: list, preview a source, install at the previewed integrity, enable and disable, files switches, config, and adding, listing and removing registries.

## Transcoder

The transcoder and all roles run live HLS sessions. When the playback engine decides remux or transcode, `playback.plan` returns `/api/playback/{sessionId}/{itemId}/hls/master.m3u8?token=...`. The api serves `media.m3u8`, `init.mp4`, `N.m4s`, and per text subtitle Stream `subs-N.m3u8` and `subs-N.vtt`, under the same path. Every HLS URL carries the playback token.
One ffmpeg runs each session into transcoder-local scratch, cutting segments on the Item's segment timeline. Remux copies every Stream. Transcode uses the fast live profile on the CPU: video re-encodes to the engine's ladder rung with keyframes forced on the timeline, tone mapped to SDR when the client lacks the HDR flavour; audio copies, encodes EAC3 5.1 or downmixes to AAC stereo. Text subtitles become WebVTT renditions in the master playlist, converted on first request. A bitmap subtitle the client cannot draw is burned into the video.
A segment that is not ready yet waits up to twenty seconds, then answers 503. A seek restarts ffmpeg at that segment; segments already in scratch serve without a restart. Sixty seconds idle stops ffmpeg and deletes scratch while the session row stays live; the next request revives it.
Each transcoder runs at most `PENDIA_TRANSCODE_SLOTS` sessions that re-encode video, default 2. Later ones queue in arrival order: their session state reads `queued` with a `session.state` event, playlists still answer, and init or segment requests wait up to twenty seconds, then answer 503 `SESSION_QUEUED`. A slot frees when a session stops, idles out or the transcoder shuts down.
At startup a transcoder runs a 2 s trial encode per CPU codec, a tone map per transfer function, and a 2 s encode per codec on each hardware backend whose device exists. It records the passing ones on its node row and answers `/readyz` only after that. A CPU that encodes nothing stops startup. Planning uses the CPU entries every node shares; hardware backends are recorded, not used yet.
`PENDIA_SCRATCH_DIR` chooses the scratch root, default `pendia-scratch` under the OS temp dir. Use local disk, never NFS. `PENDIA_TRANSCODER_PORT` defaults to 3001. `PENDIA_TRANSCODER_URL` is the address other api processes reach this transcoder at, default `http://127.0.0.1:<port>`; set it when api and transcoder run on different hosts.
The session registry maps a session to its owning transcoder. An api that is not the owner proxies to the owner's `PENDIA_TRANSCODER_URL`. A standalone transcoder needs an already migrated database. Stopping a transcoder removes its node row and releases its sessions.
Stored Versions are below; they need a transcoder only for their WebVTT tracks. A transcoder that dies without stopping leaves its node row, and requests for its sessions answer 503 until the row is removed.

## Stored Versions

A library's policy names the rungs Pendia stores next to each source and an optional condition. It lives in the library configuration under `storedVersions`:

```json
{
  "rungs": [{ "name": "source" }, { "name": "1080p", "height": 1080, "bitrate": 8000000 }],
  "when": { "minHeight": 2160, "codecs": ["hevc"], "hdr": true }
}
```

`source` is a remux of the source video. Every other rung is H.264 High at its height, capped at its bitrate, with AAC stereo; HDR sources are tone mapped to SDR. A source matches when any one `when` criterion holds, and every source matches without `when`. `hdr` only takes `true`. A rung taller than the source is skipped, and so is the source rung when fMP4 cannot carry its codec.

| Procedure | REST route | Input | Output |
| --- | --- | --- | --- |
| `libraries.storedVersions` | GET `/api/libraries/{id}/stored-versions` | `id` | `{ policy }`, null when the library stores nothing |
| `libraries.setStoredVersions` | PUT `/api/libraries/{id}/stored-versions` | `id`, nullable `policy` | `{ policy }` |
| `items.requestStoredVersion` | POST `/api/items/{id}/stored-versions` | `id`, `rung` | `{ queued }`, false when the rung is complete or already queued |

All three need `manage-transcoding`. A manual request names a rung the policy defines and skips only its condition. An unknown rung answers 400, a rung the source cannot make answers 409.

Every folder scan queues the wanted rungs of each Item's best aligned source and deletes the rows of rungs the policy no longer names. A low-priority `store` sweep job on a worker then removes their folders and any `<file>.pendia` folder whose source left the disk, because the api, which runs a watcher's scans, may only read the share. Replacing a policy reconciles the whole library at once.

A `store` job writes `<source file>.pendia/<rung>/`: `rung.json` with the rung definition, `init.mp4`, numbered `.m4s` segments cut on the Item's segment timeline, and `manifest.json` last. Editing a rung's height or bitrate under the same name stores it again. Store jobs run on workers one at a time across the cluster, at priority -10, with ffmpeg under `nice -n 19`. They run only inside the idle window, 01:00 to 07:00 server local time unless the `store` settings row says otherwise (`{ "idleWindow": { "start": "23:00", "end": "05:30" } }`; equal ends mean all day). A job claimed outside the window books itself for the next one; at the window end or on shutdown ffmpeg stops and the job resumes at the first missing segment next time.

When a plan is not direct play, the complete stored rungs that pass the client become the variants of one master playlist. A remux plan takes them only when they include the source rung. The api serves `hls/<versionId>/media.m3u8`, `init.mp4` and `N.m4s` from the library share, so every api needs read access to the libraries. The master lists the same WebVTT tracks a live session would, and a transcoder converts them. A plan that must burn a bitmap subtitle in skips stored rungs, which carry none. The live session answers only when no stored rung passes.

## Activity

| Procedure | REST route | Input | Output |
| --- | --- | --- | --- |
| `playback.sessions` | GET `/api/playback/sessions` | None | `PlaybackSession[]`, newest first |
| `store.status` | GET `/api/store/status` | None | `{ running, queued: { total, next } }` |

`playback.sessions` needs `manage-server`. It lists sessions that are not stopped and reported in the last five minutes: state, play method, user, client and device, the Item as a browse card, rungs and the transcoder node name. Rungs are the stored rung names for a stored session, the output height for a live transcode such as `720p`, and `source` otherwise. A plan records the client and device of the caller's login, or an API key's name as the client, and publishes `session.state` `starting`, so a dashboard on `events.stream` sees a session arrive and leave.

`store.status` needs `manage-transcoding`. Each running store encode reports its Item, rung, and the segments finished against the timeline's total, counted in the rung folder on the library share. The queue reports its total and the next ten encodes in run order with their run-after time; a job booked for the next idle window shows that window's start. Sweeps are left out.

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
`artworkRequiresAuth` is a boolean defaulting to false. Of the auth settings, `settings.update` writes `trustedProxyAddresses` and `artworkRequiresAuth` only.
Settings apply on the next request. Invalid stored settings fail closed.
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

OIDC stays read-only over the API in this slice. Configure it with this PostgreSQL 18 upsert:

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
| `me` | GET `/api/me` | None | `user`, `credential`, and `admin` saying whether the caller is a built-in admin |
| `items.list` | GET `/api/items` | `libraryId`, `kind`, `sort`, `limit`, `cursor` | `{ items, cursor }` of cards |
| `items.get` | GET `/api/items/{id}` | `id` in the path | the detail shape |
| `items.search` | GET `/api/search` | `query` | card array, best match first |
| `items.refresh` | POST `/api/items/{id}/refresh` | `id` in the path | `{ jobId }` |
| `shelves.home` | GET `/api/shelves/home` | None | `Shelf` array |
| `events.stream` | GET `/api/events` | `Last-Event-ID` header | `text/event-stream` |
| `setup.status` | GET `/api/setup/status` | None | `{ complete }` |
| `users.list` | GET `/api/users` | None | `AdminUser` array |
| `users.get` | GET `/api/users/{id}` | `id` | `UserAccess` |
| `users.create` | POST `/api/users` | `username`, `password`, optional `displayName` | `UserAccount` |
| `users.sessions` | GET `/api/users/{id}/sessions` | `id` | `Session` array |
| `users.revokeSession` | POST `/api/sessions/{id}/revoke` | `id` | `{ ok: true }` |
| `users.setGroups` | PUT `/api/users/{id}/groups` | `id`, `groupIds` | `UserAccess` |
| `users.setOverride` | PUT `/api/users/{id}/overrides/{permission}` | `id`, `permission`, nullable `allowed` | `UserAccess` |
| `users.setSettings` | PUT `/api/users/{id}/settings` | `id`, nullable `bitrateCapBps`, nullable `contentRatingCeiling` | `UserAccess` |
| `users.setLibraryAccess` | PUT `/api/users/{id}/libraries/{libraryId}` | `id`, `libraryId`, nullable `allowed` | `UserAccess` |
| `groups.list` | GET `/api/groups` | None | `Group` array |
| `groups.create` | POST `/api/groups` | `name`, `permissions` | `Group` |
| `groups.setPermissions` | PUT `/api/groups/{id}/permissions` | `id`, `permissions` | `Group` |
| `settings.get` | GET `/api/settings` | None | `ServerSettings` |
| `settings.update` | PATCH `/api/settings` | optional `trustedProxyAddresses`, `artworkRequiresAuth`, nullable `bitrateCapBps`, `idleWindow` | `ServerSettings` |
| `settings.setProviderKey` | PUT `/api/settings/providers/{name}` | `name`, `value` | `ServerSettings` |
| `settings.deleteProviderKey` | DELETE `/api/settings/providers/{name}` | `name` | `ServerSettings` |

Procedures accept the same `Authorization: Bearer <token>` or `pendia_session` cookie as the auth routes, and the generated document declares both under `securitySchemes` as root alternatives.
`me` is the only auth route wrapped as a procedure. Setup, login and logout stay on the auth handler because they set cookies, check Origin and consume login windows.

`setup.status` is the only unauthenticated procedure. The first-run wizard asks it before any account exists, and it leaks one boolean that `POST /api/auth/setup` already leaks through its 409.
The other admin procedures check permissions inside the auth slice: `manage-users` for user reads and settings, `manage-server` for server settings, and built-in admin membership for group and library access writes.

`users.get` and the four `users.set*` mutations all answer the full `UserAccess` shape, so the per-user screen refreshes in one round trip. The mutations read that shape back without re-checking the caller, which exposes nothing new because reaching that line already required passing the write's own check; it lets an admin demote themselves and still receive the saved state.
`users.setOverride` restores inheritance on a null `allowed`. `users.setLibraryAccess` writes user rows only; group access rows stay unexposed in this slice.
`bitrateCapBps` crosses the API as a nullable integer and the service stores it as bigint. It must be a positive safe integer, because the playback planner reads the column as a number and rejects anything larger. `contentRatingCeiling` trims, rejects blanks and clears on null.
Session and user instants cross as ISO-8601 at millisecond precision, because the auth slice hands back `Date` values. Item instants stay the database's own UTC text.

Group permission edits apply to custom groups only. The built-in `admins` and `users` groups reject writes: admins bypass every check, and `users` is the documented default group.

`settings.get` answers the trusted proxy addresses, the artwork toggle, whether OIDC is configured, the provider key names, the global bitrate cap, the store idle window and the artwork store. No read returns a provider key value, the OIDC client secret or S3 credentials; provider keys are write-only over the API.
`settings.update` writes `trustedProxyAddresses`, `artworkRequiresAuth`, `bitrateCapBps` and `idleWindow`. OIDC stays read-only in this slice.
`bitrateCapBps` is the global default cap in bits per second, null for none; the next `playback.plan` reads it. `idleWindow` is `{ start, end }` as `HH:MM` server local time. A new window moves queued store jobs booked for a later start to the new window's start, or to now when the window is open.
`artworkStore` is `{ backend, path, bucket, endpoint }`: the environment's choice (`PENDIA_ARTWORK_STORE`), read-only, because moving artwork between backends is unsupported.

Cards carry `id`, `kind` (`movie`, `show`, `season`, `episode`), `libraryId`, `title`, `year`, `addedAt` and `posterArtworkId`, which is the selected poster's artwork id for use with `/api/artwork/{id}?width=<pixels>`; `width` is required and accepts an integer from 1 through 4096.
Browse cards add `parentId`, `seasonNumber`, `episodeNumber`, `episodeEndNumber` and `show`, which is `{ id, title, posterArtworkId }` for a Season or Episode and null otherwise. An Episode's `seasonNumber` is its Season's. Together they give every route a card needs.
Details are browse cards plus `overview`, `contentRating`, `genres`, `tags`, `metadataState`, `updatedAt`, `backdropArtworkId`, `credits`, `versions` and `children`. `credits` lists `{ contributorId, name, role, character }` with actors first, then by role and credit order. `versions` lists the imported Versions as `{ id, label, format, durationSeconds, bytes }` by label; stored Versions are renditions of those and stay off the list. `children` holds a Show's Seasons or a Season's Episodes as browse cards in number order. `metadataState` is `pending` until an enabled provider looks at the Item, and again while a failed artwork download or Show tree waits for the next scan to retry it. It is `matched` after a confident match. It is `unmatched` when a provider searched and found no confident match, or has no record for the Item's stored id; that is the state an admin resolves by hand. Instants are the database's own UTC text at microsecond precision.

The list connection is `{ items, cursor }`. `sort` is `added` by default, newest first by `addedAt` then `id` descending, or `title`, A to Z by `title` then `id`.
`cursor` is opaque and bound to its sort: an `added` cursor carries the microsecond instant, so a row that shares a millisecond with its predecessor still pages, and a `title` cursor starts with `t1.`. Either sort answers 400 to the other's cursor.
Without a `libraryId` the list is scoped to the libraries the caller may view, with the auth slice's own precedence rules, and answers 403 when that set is empty.
The default page is 24 and `limit` caps at 100. An unparseable cursor answers 400.

`items.refresh` queues a provider-fetch for one Item and needs `manage-libraries`. It runs at priority 1, ahead of background scans at 0. When a due fetch for the Item is already queued, it raises that job to priority 1 and returns its id instead of adding another. A refresh of a Show re-fetches its whole tree. An unknown id answers 404.

`items.search` matches the titles of Movies and Shows in the libraries the caller may view, with pg_trgm. Trigram similarity forgives a misspelling, so `Interstelar` finds `Interstellar`; word similarity lets a prefix or one word of a longer title match. Results come best match first, at most 24. `query` is trimmed, must keep 1 to 200 characters and may not contain NUL. A caller who may view no library gets an empty list.

`shelves.home` assembles Home from the mediums in one call. Continue watching comes first, then each medium's own shelves such as next up, then recently added. A core shelf appears only when some medium joins it, each holds at most 24 entries, and an empty shelf is left out. A shelf is `{ id, title, entries }` and an entry is `{ item, progress }`: a browse card, and `{ positionSeconds, durationSeconds }` on continue watching or null elsewhere. Recently added lists Movies and Shows by their own `addedAt`, so a new Episode does not lift its Show.

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
| `libraries.scanStatus` | GET `/api/libraries/{id}/scan-status` | `id`, `runId?` | `ScanStatus` |

A ScanStatus describes one scan invocation, identified by the `jobId` that `libraries.scan` returned: the library id, counts for the four job states covering that run's root job and the directory jobs it fanned out, the newest scan job's id, state and error or null, and `runId`, the run's root job id. Directory jobs inherit the run id in their payload, so the counts cover exactly one run even when another scan starts while a run is still fanning out. Omitting `runId` reports the newest run (the newest root job, `path` of `.`), and an unknown `runId` answers 404. When the library has never scanned, the counts answer zero, `latest` and `runId` answer null.
A Library contains `id`, `name`, `medium` and `rootPath`. Names trim surrounding whitespace and allow 1 to 128 characters. Roots must be absolute. Roots and mediums cannot change through `update`. Deleting a library removes its database records, never its files. Mutations use the auth module's origin checks.

The returned scan job walks the root and enqueues one scan per canonical movie or show folder in one transaction. Every root and directory job carries `library:<id>` as its concurrency key. The existing queue key limit applies. Worker and all roles register the built-in handler on startup. An explicit custom scan handler takes precedence.

Each media file directly inside a movie folder becomes an imported Version of that folder's Item. Nested collection folders work. Loose videos at the library root are skipped. Titles and years come from folder names such as `Alien (1979) {tmdb-348}`. Version labels come from probe dimensions, codecs and HDR. Only explicit filename tags such as `{edition-Director's Cut}` contribute to those labels.

A shows library uses each top-level show folder as canonical. `Season N` folders and `Specials` hold Episodes, with Specials as season zero. Episode names use `SxxEyy`; a range such as `S01E02-E03` becomes one Episode carrying that range. Files ending in `partN`, `ptN` or `cdN` form ordered Files in one Version. Only Episodes hold Versions; Shows and Seasons are containers. Show folders carry provider ids the same way movie folders do, such as `The Expanse (2015) {tvdb-280619}` or Jellyfin's `[tvdbid-280619]`.

The literal `extras` directory is always reserved, case-insensitively, even for same-name videos. Use a dated folder such as `Extras (2005)` for a movie named Extras. Other extras-category names can identify movies when the filename matches the canonical title, including `Collection/Shorts/Shorts.mkv`.

The walker skips symlinks, excluded extras directories, extra filename suffixes, `.pendia` folders and `<source>.pendia` stores. Probe results persist in Postgres by library-relative path, byte size and nanosecond mtime. Changed files get one ffprobe for streams, duration and chapters. Unchanged scans reuse the cache across processes.

Directory writes preserve Item, Version, File and Stream identities and keep curated Item metadata. Completed directory scans publish `library.changed` through the existing permission-filtered SSE stream. An empty root scan publishes the event too. A root job completing means its directory jobs were queued, not that they finished.

Scans persist container keyframe indexes on Versions. The first imported Version establishes each cut's immutable segment timeline through the playback module. Later Versions reuse it and record their own alignment. Missing or unsupported indexes set lazyIndexPending for first-play indexing. Nonzero-start indexes remain stored but cannot establish a timeline under the current playback contract. Missing-file reconciliation and change signals are covered below. Metadata provider configuration is covered under Metadata and artwork settings.

Scan tests generate short MKV fixtures with ffmpeg and compare their stream lists with ffprobe. Both commands must be on PATH. Database-backed scan tests use the disposable database helper described above.

### Change detection

Sonarr and Radarr report file changes through webhook routes so scans stay current between manual runs. Create one API key per integration through the auth service's `createApiKey`. The token is shown once and becomes the secret URL segment. Point Sonarr at `<pendia-origin>/api/webhooks/sonarr/<secret>` and Radarr at `<pendia-origin>/api/webhooks/radarr/<secret>` with POST. Enable Download or import, Rename, Episode File Delete and Series Delete in Sonarr, and Download or import, Rename, Movie File Delete and Movie Delete in Radarr.

The secret must be a live API key owned by a caller with `manage-libraries`. Session tokens in the URL are rejected. Wrong, revoked or expired secrets answer 401. Treat the full webhook URL as a secret and redact it from logs. Accepted payloads answer 202 with the number of translated changes. Unknown Servarr event types are accepted with zero changes. Malformed payloads and paths outside the matching medium's Library answer 400.

Absolute writer paths become library-relative paths and debounce for 10 seconds per Library directory. A burst of events queues one scan job under the Library concurrency key `library:<id>`.

A rename updates the stored File and Item paths before the scan writes, so Item, Version, File and Progress identity survive. A delete removes the missing Version, and the Item goes only when no Version remains. Provider ids from Servarr persist on the Item. Sonarr and Radarr changes both queue scans through their matching medium.

The `api` and `all` roles run a directory-mtime repair pass after startup and every 24 hours. It walks movie and show Library directories without statting files, compares each directory mtime with a snapshot kept in process memory, and queues a directory scan for every changed canonical folder and every Item folder missing on disk. Repair and manual fan-out scans carry the reconcileMissing flag, so a scan removes imported Versions whose files disappeared and the emptied movie Items, show Episodes and Seasons they leave behind. An unavailable root is skipped without deleting rows. A restart rebuilds the snapshot, so every reachable directory is checked once after boot. `POST /api/libraries/{id}/scan` remains the manual full scan.

### Watcher

Media on NFS gives the api no inotify events, so `--role watcher` runs on the storage host instead. It needs no database. Configure it with three variables:

- `PENDIA_API_URL`: the api origin, such as `http://pendia.lan:3000`.
- `PENDIA_WATCHER_TOKEN`: an API key owned by a caller with `manage-libraries`.
- `PENDIA_WATCH`: `<library-id>=<local root>` pairs separated by commas. Use Library ids, because names are not unique. A local root is the Library's root as the storage host sees it, so mount points may differ from the api's.

The watcher watches each root recursively. After a file stays quiet for 200 ms, it posts the add, move or delete to `POST /api/watcher/events` with a library-relative path. A path that appears with the inode of a vanished path is a move, so renames keep Item and Progress identity. The api keeps changes to the medium's own files and debounces them like webhook changes. A failed post is logged and dropped; the repair pass heals what it missed.

The watcher also runs its Libraries' scans on local disk. It claims scan jobs through `POST /api/watcher/claim`, walks and probes, and posts the files and raw ffprobe output to `POST /api/watcher/jobs/<id>`. The api writes them like a local scan and fills the probe cache, which the next claim shares so unchanged files skip ffprobe. Each claim, and a heartbeat every 5 s during a scan, marks the watcher's Libraries as watched for 30 s. Workers leave scans of a watched Library queued. When the watcher stops, workers scan the Library again after 30 s. A report the api fails to take is retried every 5 s, because the running job holds the Library's concurrency key. A watcher killed during a scan leaves that job running, like a worker killed during a job.

All watcher routes take the API key as `Authorization: Bearer <key>`. Missing, wrong and session tokens answer 401.

On the storage host, run [compose.watcher.yaml](../../compose.watcher.yaml). It mounts `PENDIA_MEDIA` (default `/srv/media`) read-only at `/media`:

```sh
PENDIA_API_URL=http://pendia.lan:3000 \
PENDIA_WATCHER_TOKEN=<api key> \
PENDIA_MEDIA=/srv/media \
PENDIA_WATCH=<movies-library-id>=/media/movies,<shows-library-id>=/media/shows \
docker compose -f compose.watcher.yaml up -d
```

### Metadata and artwork settings

The `settings` row with key `metadata` holds one JSON object. Missing fields use these defaults:

```json
{
  "providerOrder": ["tmdb", "tvdb"],
  "confidenceThreshold": 0.9,
  "libraries": {},
  "tmdb": null
}
```

`providerOrder` sets the enabled providers in priority order. `tmdb` and `tvdb` are built in, and a plugin metadata provider joins by its id. TMDB handles movies and TVDB handles Shows, Seasons and Episodes, so each Item only reaches the provider for its kind. A `metadata` row that sets `providerOrder` without `tvdb` keeps TVDB off. `confidenceThreshold` is the inclusive minimum match confidence from 0 to 1.

TMDB title search compares the folder title with each result's `title` and `original_title`. When neither matches for any result, it also reads `/movie/{id}/translations` for the first five results, so a Radarr folder named with a translated title, such as `Die Verurteilten (1994)`, still matches. A search with a plain match makes no extra request.

TVDB matches a Show by its folder's TVDB id first. Without one, an IMDb id pins the Show through TVDB's remote id search, and otherwise title search compares the folder title with each result's name, aliases and translations, scored the way TMDB scores movies. Seasons and Episodes match by number in TVDB's official order, which is the aired order Sonarr names files in. Names and overviews come in the Show's primary language. Shows store their first and last air dates and their status in lowercase, such as `continuing` or `ended`; Seasons and Episodes store their air dates.

A show scan queues one provider-fetch for the Show whenever the Show or anything under it is `pending`. That job matches the Show, then each Season and Episode in number order, and stores each Item's primary artwork: a poster for Shows and Seasons and a thumb for Episodes. TVDB is read once per job: one login, one series request and one request per 500 Episodes. If any part of the tree fails, the Show goes back to `pending` and the job retries. The tree publishes one `library.changed` event at the end rather than one per Episode.

After every Show fetch, whether it succeeded or not, a `continuing` Show keeps exactly one provider-fetch queued a week ahead, marked `weekly: true` in its payload. Any other status keeps none, so `ended` and `upcoming` Shows refresh only on a rescan while `pending` or through `items.refresh`. Scans and `items.refresh` coalesce only onto a fetch that is already due, so the weekly job never absorbs one.

`libraries` maps a Library id to its provider list. A missing entry uses `providerOrder`, an explicit `[]` disables metadata for that Library, and an explicit `["tmdb"]` enables only TMDB:

```json
{
  "libraries": {
    "<movies-library-id>": ["tmdb"],
    "<shows-library-id>": []
  }
}
```

The TMDB API key lives in the separate `providers` settings row, written by the admin Provider keys screen or `settings.setProviderKey` with the name `tmdb`. Key values are write-only: `settings.get` returns names, never secrets. Storing or rotating `tmdb` marks every unmatched movie `pending`, so the next rescan queues a provider-fetch for each of them; a missing key means no TMDB provider, and scanned movies stay `pending` until a key arrives. A Library whose provider list is `[]` leaves its Items `pending` the same way. The embedded `metadata.tmdb.apiKey` field is still read as a backward-compatible fallback when no provider key is stored, but new deployments should use the provider key store.

Without a stored key, Pendia reads `TMDB_API_KEY` from the environment. With Compose, put it in `.env` at the repository root: `TMDB_API_KEY=<key>`, or run `scripts/tmdb-key-wizard.sh`, which opens TMDB, checks the key and writes it there. Use TMDB's v3 API key, the 32-character one; Pendia does not use the Read Access Token.

The TVDB API key lives in the same row under the name `tvdb`, and a subscriber PIN, when the key needs one, under `tvdb-pin`. Storing or rotating `tvdb` marks every unmatched Show, Season and Episode `pending`. Without a `tvdb` key there is no TVDB provider, and scanned Shows stay `pending` until one arrives.

Settings apply to the next provider-fetch job. A rescan enqueues enrichment only while an Item is `pending`: matched rescans stay quiet, a changed provider ID marks the Item `pending` again, and scans coalesce onto an already due fetch for the same Item while a fetch still running earns exactly one queued successor. `artworkRequiresAuth` stays in the separate `auth` settings row and defaults to false.

Configure the `providers` row with this PostgreSQL 18 transaction, replacing the `<tmdb-api-key>` placeholder. The admin UI and `settings.setProviderKey` remain the preferred path and perform the same reset; this is the manual fallback. The conflict clause merges with any keys already stored rather than replacing them, and the `UPDATE` requeues unmatched movies the same way the API does:

```sql
BEGIN;

INSERT INTO settings (id, key, value)
VALUES (
  uuidv7(),
  'providers',
  jsonb_build_object('keys', jsonb_build_object('tmdb', '<tmdb-api-key>'))
)
ON CONFLICT (key) DO UPDATE
SET value = jsonb_build_object(
      'keys',
      coalesce(settings.value->'keys', '{}'::jsonb) || (EXCLUDED.value->'keys')
    ),
    updated_at = clock_timestamp();

UPDATE items
SET metadata_state = 'pending',
    updated_at = clock_timestamp()
WHERE kind = 'movie'
  AND metadata_state = 'unmatched';

COMMIT;
```

Provider order, the confidence threshold and per-Library overrides remain independently configurable in the `metadata` row with the documented default JSON.

### Subtitles

`subtitleLanguages` in the `metadata` row lists the languages to fetch, as OpenSubtitles writes them: `["en", "nl", "pt-br"]`. It defaults to `[]`, which fetches nothing. When a movie or episode matches, its provider-fetch queues one `subtitle-fetch` job. That job asks every subtitle provider for the languages the Item has no track for, keeps the best match per language, skips forced-only and machine-translated matches, and writes the file to `<Item folder>/.pendia/subtitles/<item id>.<language>.<format>`. The Item folder must be writable.

OpenSubtitles joins when the `providers` row holds an `opensubtitles` key, an API consumer key from opensubtitles.com, set like the TMDB key. It searches by the OpenSubtitles hash of the Item's first video file, the title and year, or for an episode the Show title with season and episode numbers, plus IMDb and TMDB ids when the Item has them. Downloads without a user login count against OpenSubtitles' anonymous daily quota; a refused download fails the job, which retries.

`playback.plan` returns the stored tracks as `subtitles: [{ language, format, url }]`. `GET /api/subtitles/{itemId}/{language}.{format}` serves one to a session or API key that may view the Item.
