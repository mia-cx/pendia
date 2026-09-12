# #22 Auth core: local accounts, sessions, groups and permissions

## Summary

Add local identity and access behind reusable server functions. Expose setup, login, logout and me as JSON under `/api/auth`. Reuse the existing access tables and built-in group seed. Keep OIDC, invites, admin screens and oRPC for their own slices.

## Acceptance criteria

- [x] Login returns a per-device token; a revoked token is rejected on the next call.
- [x] Permission checks resolve through groups and per-user overrides; the built-in groups behave as the spec says.
- [x] The rate limit trips after the configured attempts and clears after the window.
- [x] Forwarded headers from an untrusted address are ignored.
- [x] The first-run path creates the admin exactly once, even under two concurrent requests.

## TODOs

- [x] Implement permission checks and group assignment.
  - Add one shared permission helper over enabled users, group union, user overrides and library access. Admins bypass checks. Library denies win ties.
  - Add permission-checked custom group creation, membership replacement and user override changes. Preserve built-in groups.
  - Validate with colocated Postgres tests for built-ins, custom group union, overrides, library precedence and forbidden mutations. Run the server typecheck and build.
  - Done: auth/errors.ts, auth/permissions.ts, auth/permissions.test.ts. bun test permissions.test.ts: 7 pass / 0 fail (50 expects) against pendia-test-pg-22, including a two-client concurrent replacement test; setUserGroups locks the target user row FOR UPDATE. tsc check, bun build and biome check clean. Evidence: .devin/todo1-evidence.md.
- [x] Implement local accounts and atomic first-run setup.
  - Hash local passwords with Bun.password argon2id. Setup creates only one admin account and membership under a transaction advisory lock. Persist setup completion in settings.
  - Add permission-checked local account creation with the users group by default. Return public user fields, never password hashes.
  - Validate simultaneous setup through two database clients, repeat rejection, argon2id storage, case-insensitive account uniqueness and permission checks. Run the server typecheck and build.
  - Done: auth/accounts.ts, auth/accounts.test.ts; postgresCode moved to auth/errors.ts. bun test accounts.test.ts: 4 pass / 0 fail (35 expects) against pendia-test-pg-22. Concurrent two-client setup yields exactly one admin/membership, marker persists after user deletion, duplicate normalized username CONFLICT. tsc check, bun build and biome check clean. Evidence: .devin/todo2-evidence.md.
- [x] Implement device sessions and integration API keys.
  - Return random opaque tokens once and persist SHA-256 digests. Authenticate against Postgres on every call, update last seen and reject revoked, expired or disabled credentials.
  - Add session listing and revocation for the owner or a user with manage-users. API keys have integration names and the same ownership checks.
  - Validate login, independent devices, immediate revocation, optional expiry, no default expiry, API keys and disabled users. Run the server typecheck and build.
  - Done: auth/sessions.ts, auth/sessions.test.ts. bun test sessions.test.ts: 4 pass / 0 fail (35 expects) against pendia-test-pg-22: opaque base64url tokens, SHA-256 digests, lastSeen/lastUsed touch on authenticate, immediate revocation, DB-clock expiry, owner-or-manager rules, disabled owner rejection. tsc check, bun build and biome check clean. Evidence: .devin/todo3-evidence.md.
- [x] Add persisted auth settings, login limits and trusted proxy handling.
  - Read auth settings from Postgres. Default to no session maximum age, five login attempts per fifteen minutes and no trusted proxies.
  - Share independent address and case-insensitive account windows across processes using settings rows and a short transaction lock. Count attempts before password work and clear expired windows.
  - Derive client address and protocol only through configured exact proxy addresses. Walk forwarded chains from the trusted peer toward the first untrusted hop.
  - Validate configured attempt limits, independent address/account limits, concurrent callers, window reset, live settings and spoofed forwarded headers. Run the server typecheck and build.
  - Done: auth/settings.ts, auth/rate-limit.ts, auth/transport.ts; login now takes a client address and consumes shared windows before password work, authenticate enforces configured session max age live. bun test (rate-limit+transport+sessions): 16 pass / 0 fail (81 expects) against pendia-test-pg-22; review cleanup fixed retryAfter to only count blocking counters and unparseable-peer trust. tsc check, bun build and biome check clean. Evidence: .devin/todo4-evidence.md.
- [x] Wire thin JSON auth handlers into api and all roles.
  - Serve POST setup/login/logout and GET me under `/api/auth`. Accept bearer tokens and same-origin cookies. Keep account tokens out of URLs.
  - Validate JSON input at the handler boundary. Use stable error codes, no-store responses and HTTP-only same-site cookies, with Secure only on HTTPS.
  - Validate real HTTP login/me/logout, concurrent setup, HTTP and trusted HTTPS cookies, invalid requests and unchanged role health behavior. Run focused auth and role tests, server typecheck and build.
  - Done: auth/http.ts (createAuthHandler), api.ts third auth arg, index.ts wiring, http.test.ts. bun test http+api+roles: 15 pass / 0 fail against pendia-test-pg-22: concurrent two-server setup 201/409, login cookie semantics, bearer+cookie me, immediate logout rejection, real-peer rate limit 429, trusted-proxy Secure cookie, malformed/405/404/CSRF rejections, API key me/logout. tsc check, bun build and biome check clean. Evidence: .devin/todo5-evidence.md.
- [ ] Run final checks and record the integration contract.
  - Update the server README with auth functions, routes, settings and proxy assumptions.
  - Run frozen install, lint, check, build, all tests with disposable Postgres, and tests without DATABASE_URL. Record actual results below.
  - File a non-draft PR after rebasing on origin/main. Address repository bot findings until the pushed head is green, clean and mergeable. Remove only the test container created for this issue when finished.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/auth`, branch `feat/22-auth-core`, starting at `4a2921e`. Keep all edits here. Commit each TODO separately with `Refs #22`. Keep `.devin` uncommitted.
- Sources read include issue #22, CONTEXT.md, auth and topology specs, plugin API types, ADR 0002, server roles, API, database schema and migrations, jobs and their tests, and the server README.
- The run is unattended. The selected test seams are exported auth functions and HTTP handlers over real disposable databases. Database inspection is reserved for storage guarantees such as token hashing and setup cardinality.
- All required auth columns exist. No migration is planned. The settings table holds auth configuration, setup completion and expiring login counters.
- Configuration uses one `auth` settings value with `sessionMaxAgeSeconds`, `loginMaxAttempts`, `loginWindowSeconds` and `trustedProxyAddresses`. Missing fields use defaults. Invalid stored configuration fails closed.
- Setup completion remains recorded even if someone later deletes all users. Existing users also close setup. Only first-run setup is anonymous account creation.
- Library rows override the global view result. Any matching library deny beats a matching allow. Admin membership means the seeded built-in admins group, not a custom name.
- Exact IP addresses, including normalized IPv4-mapped addresses, define proxy trust. CIDR configuration is outside this slice. A trusted proxy must sanitize forwarded protocol headers.
- Every login attempt consumes both applicable fixed windows, including successful logins. A blocked attempt does not extend a window. Unknown accounts follow the same password verification path.
- Request input limits keep password hashing and metadata bounded. Error responses do not reveal whether an account exists.
- Plain HTTP remains supported. HttpOnly and SameSite=Lax protect cookies on both transports; Secure applies only when the effective protocol is HTTPS.
- Review posture is adversarial at the HTTP boundary. Apply the trigger test to every finding. Use only existing CodeRabbit, Codex and Pullfrog reviews, with no independent reviewer workers.
- Test Postgres will be `pendia-test-pg-22` on port 55422, using `postgresql://pendia:pendia@127.0.0.1:55422/pendia`. Tests create and drop unique databases and preserve the named database.
- Push only after the pre-PR rebase so no force-push is needed. The parent owns merging.
