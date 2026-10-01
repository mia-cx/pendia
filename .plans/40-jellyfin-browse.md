# #40 Jellyfin layer: auth and browse

## Summary

Serve the Jellyfin 10.10 dialect for login, Quick Connect, logout, system info, the current user, and browsing: user views, items, item by id, resume, next up, seasons and episodes. Item images answer anonymously. The layer parses the MediaBrowser header in any spelling, matches routes and query names case-insensitively, and writes GUIDs as UUIDs without dashes. It builds DTOs from core service functions and runs no queries of its own.

Read contracts: CONTEXT.md, docs/spec/jellyfin-layer.md, docs/spec/auth.md, docs/research/jellyfin-client-api-usage.md, ADR 0004 and 0010. Builds on apps/server/src/auth, apps/server/src/api and apps/server/src/metadata/artwork-http.ts.

## Acceptance criteria

- [ ] Contract tests pass against the request and response shapes recorded in the Jellyfin research document.
- [ ] Quick Connect completes with a 5 s poll from a test client.
- [ ] Swiftfin and Infuse log in and browse a seeded library; the result is noted on the issue by hand.
- [ ] Legacy per-user routes answer 404 cleanly.

## TODOs

- [ ] 1. Add the Jellyfin request layer in `apps/server/src/jellyfin/`: MediaBrowser header parsing with quoted or bare values in any order, from `Authorization` or `X-Emby-Authorization`; GUID mapping; case-insensitive query names and JSON keys; a route table matched case-insensitively; JSON 404 for unmatched paths under Jellyfin's PascalCase roots, which covers legacy `/Users/{userId}/...`. Mount it in the api server ahead of the SPA fallback. Validation: unit tests for header spellings from the research document, GUID round trips and query lookup; HTTP tests show legacy routes answer 404 JSON and web routes still reach the SPA.
- [ ] 2. Add login by name, logout, `/System/Info`, `/System/Info/Public` and `/Users/Me`, backed by `login`, `authenticate`, `revokeSession` and a stable server id in settings. Validation: contract tests check AuthenticationResult, UserDto, SessionInfoDto, SystemInfo and PublicSystemInfo against the non-nullable fields of the pinned 10.11.11 schemas; logout revokes the token; wrong passwords answer 401.
- [ ] 3. Add Quick Connect: a `quick_connect_requests` table and migration, `apps/server/src/auth/quick-connect.ts` with initiate, poll, authorize and one-time authenticate, and the Jellyfin routes for Initiate, Connect, Authorize, AuthenticateWithQuickConnect and Enabled. Validation: a test client initiates, polls every 5 s, a signed-in client authorizes the code, the next poll reports Authenticated and the secret logs in exactly once; expired and unknown secrets fail.
- [ ] 4. Add core browse services: offset-paged Item views with medium fields, selected artwork, provider ids and the caller's marks, plus the libraries a user may view. Validation: database tests cover library scoping, parent and ancestor filters, kinds, ids, search, sort, offset and total, and per-user marks.
- [ ] 5. Add the browse routes: `/UserViews`, `/Items`, `/Items/{id}`, `/UserItems/Resume`, `/Shows/NextUp`, `/Shows/{id}/Seasons` and `/Shows/{id}/Episodes`, with BaseItemDto and query result DTOs. Validation: contract tests check BaseItemDto, UserItemDataDto and BaseItemDtoQueryResult shapes; HTTP tests browse a seeded movie and show library as Swiftfin and Findroid do, including access denial.
- [ ] 6. Serve `GET /Items/{id}/Images/{type}` and `/{index}` anonymously through the artwork handler, honouring `maxWidth` and `fillWidth`. Validation: a Findroid-style request without a token gets the poster; an unknown type answers 404; with artwork auth on, the token from the MediaBrowser header is honoured.
- [ ] 7. Run the full gate and record results. Validation: frozen install, lint, check, build, tests with and without DATABASE_URL all pass.

## Notes

- Work in /home/mia/mia-cx/pendia/.worktrees/jellyfin-browse on feat/40-jellyfin-browse. Test Postgres: container pendia-test-pg-40 on port 55540.
- Routing for #41: routes live in one table in `apps/server/src/jellyfin/routes.ts` style modules, each `{ method, path, auth, handle }`. Playback adds rows. GUID parsing and formatting live in one module.
- Route paths match case-insensitively, as ASP.NET does. Unmatched paths are claimed only when their first segment is a Jellyfin root in Jellyfin's own casing, such as `Users` or `Shows`. The web client's lowercase screens, such as `/shows/:id`, keep reaching the SPA.
- A Jellyfin access token is a Pendia device session token. The header's Client, Device and DeviceId become the session's client, device name and device id.
- The token is read from `Authorization: MediaBrowser ...` (also the `Emby` scheme name) and `X-Emby-Authorization`. Query `ApiKey`/`api_key` belongs to playback and the websocket in #41.
- `/Users/Public` answers `[]`, `/QuickConnect/Enabled` answers true and `POST /Sessions/Capabilities/Full` answers 204. The research marks all three must-have in the login flow of the promised clients, so login would break without them. They touch no data.
- `POST /QuickConnect/Authorize?code=` is included so a signed-in Jellyfin app can approve a code. Without it Quick Connect has no approval path, since the web client has no screen for it yet.
- System info reports ProductName `Jellyfin Server` and Version `10.10.7`, the last 10.10 release, so clients pick the 10.10 dialect. ServerName is `Pendia`.
- Contract tests pin the non-nullable fields of the 10.11.11 OpenAPI schemas the research document cites. The Kotlin SDK treats those as required, so a missing one breaks Findroid and Android TV.
- Resume reuses `continueWatching` and next up reuses the shows medium's `nextUp`; both then hydrate Item views by id. Resume pages over the first 100 entries, the own API's page cap.
- `Fields` is ignored: every response carries the full DTO, which Swiftfin needs from the detail route anyway. MediaSources, MediaStreams and Chapters belong to playback in #41.
- Image `tag` is the selected artwork id. The route serves the current selection and ignores `quality`, `maxHeight` and `fillHeight`; the artwork handler resizes by width only.
