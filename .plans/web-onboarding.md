# #75 #64 Web onboarding: invites and OIDC in the browser

## Summary

Two unauthenticated web flows over auth routes the server already has.

- #75: an invited person redeems an invite at `/invite/<token>`. The page collects a username, a display name and a password, shows the invite's own failure states, and lands the new user on the home screen signed in. The admin users screen shows a copyable invite link next to the one-time token.
- #64: the login page shows a "Sign in with <provider name, or SSO>" button when OIDC is configured. The OIDC callback navigates the browser back into the app instead of answering JSON, and failures land on the login page with a plain message. The admin settings screen can set and replace the OIDC client secret, which stays write-only.

## Acceptance criteria

- [x] `/invite/<token>` collects username, display name and password and signs the new user in on success, landing on `/`.
- [x] The invite page shows unknown, expired and already accepted invites in plain words, without the form.
- [x] The admin users screen shows a copyable `/invite/<token>` link built from the page origin, alongside the token.
- [x] `setup.status` says whether OIDC is configured, and carries the provider's display name when one is set.
- [x] The login page shows the OIDC button only when OIDC is configured; it links to `GET /api/auth/oidc/login`.
- [x] The OIDC callback answers 303 to `/` with the session cookie on success, and 303 to `/login?error=<code>` on failure. The login page shows a plain message per code.
- [x] The admin settings screen sets and replaces the OIDC client secret, shows only whether one is set, and the server never returns it.

## TODOs

- [x] Server: the OIDC setting tolerates a missing client secret and gains an optional display `name`; `settings.update` writes `oidcClientSecret` and `settings.get` reports `oidcClientSecretSet`. Validation: `settings.test.ts` and `api/admin.test.ts` on Postgres, server `check`.
- [x] Server: `setup.status` reports `oidcConfigured` and `oidcName`. Validation: `api/admin.test.ts` on Postgres.
- [x] Server: the OIDC login and callback routes redirect the browser. Success is 303 to `/` with the session cookie; failure is 303 to `/login?error=<code>`. Validation: `oidc.test.ts` on Postgres.
- [x] Server: `POST /api/auth/invites/status` reads an invite token as live, expired, accepted or unknown. Validation: `http.test.ts` on Postgres.
- [x] Web: `/invite/[token]` page with its failure states, an SSO option when OIDC is configured, and the invite link on the admin users screen. Validation: web `check`, browser run against a live server.
- [x] Web: the login page OIDC button and callback error messages. Validation: web `check`, browser run with and without OIDC.
- [x] Web: the settings screen OIDC client secret field. Validation: web `check`, browser run setting and replacing a secret.
- [x] Full gate, screenshots in the PR. Validation: the commands in the brief, results below.

## Notes

- The accept endpoint already sets `pendia_session`, so the invite page navigates to `/` after a 201 without a second sign-in.
- The server collapses unknown, expired and accepted invites into `INVALID_INVITE`. The page needs them apart, so a status read runs on load. The accept call keeps its contract; on `INVALID_INVITE` the page reads the status again and shows the precise state. The status route takes the token in a JSON body so it stays out of access logs. A 256-bit token makes the extra state no help to enumeration.
- Callback JSON callers: only `oidc.test.ts` reads the body. No client in the repository (web, Jellyfin compat, plugins) calls the callback, and the provider redirects a browser to it, so no `Accept: application/json` mode is kept. Tests read the user through `/api/auth/me` with the issued cookie instead.
- The OIDC login route also redirects its failures (discovery down, bad device fields) to `/login?error=<code>`, because the button is its only caller and a raw JSON error page is the same dead end the callback had.
- Error codes in the redirect are the lowercased `AuthError` codes, such as `oidc_failed` and `invalid_invite`; an unexpected failure is `internal_error`.
- OIDC turns on once issuer, client ID, secret and scopes are all stored. A missing field leaves OIDC off; a present but malformed one still fails closed. This lets the README SQL set the issuer and client ID while the secret goes through the settings screen, out of shell history, and an admin who sets the secret first does not lock everyone out.
- Display name: the stored setting had none, so `oidc.name` is optional and set with the issuer. The button reads "Sign in with SSO" without it.
- The invite page offers "Sign in with <provider>" with the invite token when OIDC is configured. New OIDC accounts already need an invite on the server, and without this an invited OIDC-only person had no way in from the browser. A new identity without an invite comes back as `oidc_failed`, so that message points newcomers at their invite link.
- The SSO link carries `data-sveltekit-reload`. Without it the client router tried to render `/api/auth/oidc/login` as an app route first and logged a not-found error before falling back.
- Discovered, not fixed here, filed as #95: drizzle's `bun-sql` driver stores `jsonb` writes as a JSON string (`"{\"oidc\":...}"`). Reads parse it back, so the app works, but raw SQL that merges with `||` turns the row into an array. The README upsert now unwraps the row with `#>> '{}'`; checked against both an object row and a string row on Postgres 18.
- Browser checks ran in headless Chromium over CDP against `--role api` on a disposable database, with the web build served from `PENDIA_WEB_ROOT`. Invite: link equals `<origin>/invite/<token>`, a taken username shows the conflict sentence, a fresh account lands on `/` and `/api/auth/me` answers it, then the same link shows "already used", an unknown token shows "does not exist", and an expired one shows "expired". Login: no button without OIDC; "Sign in with Authentik" with it; clicking it against a dead issuer lands on `/login?error=oidc_failed` with its sentence. Settings: Not set to Set, the field clears, the stored secret changes on replace, and `settings.get` never contains it.
- Gate after merging `origin/main` at 22dd0b1: `bun install --frozen-lockfile` no changes; `bun run lint` 379 files, no errors; `bun run check` 6 tasks successful; `bun run build` 4 tasks successful; `DATABASE_URL=… bun test` 1319 pass, 3 skip, 0 fail across 121 files; `bun test` without `DATABASE_URL` 774 pass, 566 skip, 0 fail.
- Gate again after merging `origin/main` at 3347cb9 (#94): install no changes; lint 379 files clean; check 6 tasks successful; build 4 tasks successful; with `DATABASE_URL` 1324 pass, 3 skip, 0 fail; without it 774 pass, 571 skip, 0 fail.
