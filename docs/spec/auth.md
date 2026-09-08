# Auth and users

## Identity

- Local accounts with argon2id password hashing.
- OIDC through Authentik, first-order: login button, account linking by email.
- Admins create users or send invite links. No self-signup. No third-party identity providers beyond OIDC.

## Sessions

- Opaque random tokens, stored hashed, one per device with client name, device name and last seen. Revocable from the admin.
- No expiry by default, because Infuse and Kodi expect that. Optional maximum age.
- API keys per integration. Arr webhooks carry a per-integration secret in the URL.

## Permissions and groups

- Permissions are a flat set: view a library, play, manage libraries, manage metadata, manage subtitles, manage users, manage plugins, manage transcoding, manage server.
- A Group is a named set of permissions. Built-in: admins, with everything, and users, with view and play on every library. Custom groups are admin-made.
- A user has groups and optional per-user overrides. Per-user settings: bitrate cap, content-rating ceiling.

## Artwork

Artwork routes accept anonymous requests by default, because Findroid sends no token and UUIDs make enumeration impractical. A toggle requires auth.

## Transport

- Plain HTTP is accepted. Cookie security flags apply on HTTPS only.
- Proxy headers are trusted from configured addresses only.
- Login is rate-limited per address and account. No built-in ACME.
