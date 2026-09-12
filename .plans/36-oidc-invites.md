# #36 OIDC login and invite links

## Summary

Add invite-only account creation and generic OIDC login to the existing auth slice. OIDC uses discovery, authorization code flow, PKCE, state, nonce, and the configured client secret. Existing accounts link only when the configured issuer supplies a verified email claim. New local and OIDC users need a live invite, so public self-signup stays closed.

## Acceptance criteria

- [x] A login round trip against the mock provider creates a new user or links an existing one by email.
- [x] An unverified email claim does not link an existing account.
- [x] An invite link works once and an expired one is rejected.
- [x] A valid invite creates either a local account or an OIDC-linked account.
- [ ] Setup against Authentik is documented with the exact `id.mia.cx` settings. Mia verifies the live provider after merge.
- [x] OIDC uses discovery and the authorization code flow with PKCE.
- [x] OIDC and invite acceptance reuse the auth slice's session issuance.
- [x] New accounts cannot be created without setup or a valid invite.

## TODOs

- [x] Parse the generic OIDC provider from the live `auth` setting and add the OIDC protocol dependency. The setting is either absent or contains `issuer`, `clientId`, `clientSecret`, and `scopes`, with `openid` required. Validation: `bun test apps/server/src/auth/settings.test.ts` and `bun run --cwd apps/server check` pass.
- [x] Add invite creation and local invite acceptance behind auth service functions. Creation requires `manage-users`; acceptance atomically checks email, expiry, and single use, creates a users-group member, and issues a device session. Validation: focused Postgres tests prove successful local acceptance, one-time use, expiry rejection, permission checks, and no account creation on failure.
- [x] Expose invite creation and local acceptance through the auth HTTP handler. The authenticated creation route returns the token once. The anonymous acceptance route requires the token and local account plus device fields. Validation: handler tests prove the complete HTTP flow and stable error responses.
- [x] Add generic OIDC login and callback routes. Store short-lived flow state in an HttpOnly SameSite=Lax cookie, use discovery, state, nonce, PKCE S256, confidential client authentication, ID token validation, and UserInfo subject validation. Existing issuer and subject links log in. A verified email may link one unlinked account. A new user requires a matching live invite. Validation: a mock provider round trip proves discovery and PKCE, existing account linking, invited account creation, session issuance, unverified-email rejection, and no-invite signup rejection.
- [ ] Document the routes, auth setting, and exact Authentik provider values for `id.mia.cx`, then run the repository validation gate. Validation: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55436/pendia bun test`, and `bun test` without `DATABASE_URL` pass with their real results recorded below.

## Notes

- Public test seams are the auth service functions and `/api/auth` HTTP routes. OIDC tests use a real local mock provider. Database behavior uses disposable databases on the configured Postgres server.
- OIDC configuration stays in the existing Postgres `auth` setting so replicas share it and changes apply on the next request.
- OIDC endpoints are `GET /api/auth/oidc/login` and `GET /api/auth/oidc/callback`. Login accepts device metadata and an optional invite token. Callback returns the same token, user, and session shape as local login and sets `pendia_session`.
- Invite endpoints are `POST /api/auth/invites` and `POST /api/auth/invites/accept`. The first requires an authenticated actor with `manage-users`. The second accepts a local account and device metadata.
- A user already linked by configured issuer and subject can log in without an invite. A verified email can link an existing local account without an invite. Every new account needs an invite whose email matches case-insensitively.
- OIDC account names come from `preferred_username`, then the email local part. Invalid characters become hyphens and a short random suffix resolves collisions.
- `oauth4webapi` 3.8.7 is used because 3.8.8 was published less than seven days before this work.
- OIDC links existing accounts by verified email only; an unverified claim skips linking but a matching live invite still creates a new OIDC-linked user.
- TODO 4 verified: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55436/pendia bun test apps/server/src/auth/oidc.test.ts apps/server/src/auth/http.test.ts apps/server/src/auth/invites.test.ts apps/server/src/auth/sessions.test.ts apps/server/src/auth/settings.test.ts` → 28 pass, 0 fail, 286 expect() calls; `bun run --cwd apps/server check` → exit 0.
- TODO 3 verified: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55436/pendia bun test apps/server/src/auth/http.test.ts apps/server/src/auth/invites.test.ts` → 12 pass, 0 fail, 138 expect() calls; `bun run --cwd apps/server check` → exit 0.
- TODO 2 verified: `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55436/pendia bun test apps/server/src/auth/invites.test.ts apps/server/src/auth/sessions.test.ts apps/server/src/auth/accounts.test.ts apps/server/src/auth/rate-limit.test.ts` → 22 pass, 0 fail, 145 expect() calls; `bun run --cwd apps/server check` → exit 0.
- TODO 1 verified: `bun add --cwd apps/server oauth4webapi@3.8.7` (installed 3.8.7); `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55436/pendia bun test apps/server/src/auth/settings.test.ts apps/server/src/auth/rate-limit.test.ts` → 10 pass, 0 fail, 46 expect() calls; `bun run --cwd apps/server check` → exit 0.
- UI and email delivery are outside this issue. The later admin UI can call the invite endpoint and render links. The later login UI can open the OIDC login endpoint.
