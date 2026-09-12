# Auth and users

## Identity

- OIDC links to an existing account only on a verified email claim from the configured issuer.
- Local accounts with argon2id password hashing.
- OIDC through Authentik, first-order: login button, account linking by email.
- Admins create users or send invite links. No self-signup. No third-party identity providers beyond OIDC.

## Sessions

- Opaque random tokens, stored hashed, one per device with client name, device name and last seen. Revocable from the admin.
- No expiry by default, because Infuse and Kodi expect that. Optional maximum age.
- API keys per integration. Arr webhooks carry a per-integration secret in the URL.

## Permissions and groups

- Precedence: the union of a user's group permissions, then per-user overrides. Library access rows override the global view permission. An explicit deny wins a tie. Admins bypass every check.
- Permissions are a flat set: view a library, play, manage libraries, manage metadata, manage subtitles, manage users, manage plugins, manage transcoding, manage server.
- A Group is a named set of permissions. Built-in: admins, with everything, and users, with view and play on every library. Custom groups are admin-made.
- A user has groups and optional per-user overrides. Per-user settings: bitrate cap, content-rating ceiling.

## Artwork

Artwork routes accept anonymous requests by default, because Findroid sends no token and UUIDs make enumeration impractical. A toggle requires auth.

## Transport

- Plain HTTP is accepted. Cookie security flags apply on HTTPS only.
- Proxy headers are trusted from configured addresses only.
- Login is rate-limited per address and account. No built-in ACME.

## Playback URLs

A video element and Safari's native HLS cannot send headers, so playback URLs carry a per-session playback token in the query string: signed, short-lived, scoped to one session and one Item, refreshed by the client before it expires. The same-origin web client uses a cookie instead. Artwork stays anonymous. The account token never appears in a URL.
