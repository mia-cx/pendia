# Jellyfin client API usage

Research for [#3](https://github.com/mia-cx/pendia/issues/3). Feeds the translation layer scope ticket [#12](https://github.com/mia-cx/pendia/issues/12).

## Summary

1. Six clients, one shape: authenticate, list items, ask `POST /Items/{id}/PlaybackInfo`, fetch a stream URL, post three progress reports. About 40 endpoints cover login, browse, play and progress for all six.
2. The clients split into two route dialects. Swiftfin, Findroid and Android TV call the 10.10+ routes (`/UserViews`, `/UserItems/Resume`, `/Items/{id}?userId=`). jellyfin-web 10.11 and Kodi still call the `/Users/{userId}/...` routes that 10.11 keeps but hides from its OpenAPI spec. Pendia must serve both.
3. `Authorization: MediaBrowser Client="X", Device="Y", DeviceId="Z", Version="V", Token="T"`. Values may be quoted or bare, are URL-decoded, and order varies per client. Infuse sends the same payload in `X-Emby-Authorization` instead.
4. Query parameter names are matched case-insensitively by ASP.NET and clients rely on it: `Secret` vs `secret`, `Static` vs `static`, `ApiKey` vs `api_key`. Pendia has to match case-insensitively too.
5. Quick Connect is three calls: `POST /QuickConnect/Initiate`, poll `GET /QuickConnect/Connect?secret=`, then `POST /Users/AuthenticateWithQuickConnect`. Every open-source client polls at 5 seconds. Infuse does not implement it.
6. Access tokens never expire. They are revoked by `POST /Sessions/Logout`, `DELETE /Devices?id=` or `DELETE /Auth/Keys/{key}`.
7. Direct play vs transcode is decided by the client from `MediaSources[].SupportsDirectPlay` / `SupportsDirectStream` / `SupportsTranscoding` and the presence of `TranscodingUrl`. The server's job is to set those flags and hand over a URL.
8. Transcode URLs are opaque to Swiftfin, Android TV and web, which follow `TranscodingUrl` verbatim. Kodi rewrites it, so the path shape (`/videos/{id}/master.m3u8?...`) is load-bearing.
9. HLS is three levels: `master.m3u8` lists `main.m3u8?<same query>`, which lists `hls1/main/{n}.{ext}?<same query>&runtimeTicks=&actualSegmentLengthTicks=`, with an `#EXT-X-MAP` init segment at index `-1` for fMP4.
10. Findroid never transcodes: it sends an empty DeviceProfile and always plays `/Videos/{id}/stream?static=true`. jellyfin-web never calls PlaybackInfo for audio, building `/Audio/{id}/universal` from its own profile.
11. Websocket is `/socket`, authenticated by header (Kotlin SDK, Kodi) or by `?api_key=&deviceId=` (Swift SDK, web). Only four inbound message types matter: `KeepAlive`, `SessionsStart/Stop`, `ScheduledTasksInfoStart/Stop`, `ActivityLogEntryStart/Stop`.
12. Images are anonymous in 10.11. `GET /Items/{id}/Images/{type}[/{index}]` with `tag`, `maxWidth`/`maxHeight` or `fillWidth`/`fillHeight`, `quality`, `format`, `blur`.

## What was read, and at which commit

| Source | Pin |
| --- | --- |
| Jellyfin OpenAPI 10.11.11 | [`jellyfin-openapi-10.11.11.json`](https://api.jellyfin.org/openapi/stable/jellyfin-openapi-10.11.11.json), `info.version` `10.11.11`, 315 paths, 357 schemas |
| Jellyfin server | tag [`v10.11.11`](https://github.com/jellyfin/jellyfin/tree/v10.11.11) |
| Swiftfin | [`0f2f70b`](https://github.com/jellyfin/Swiftfin/tree/0f2f70be84010b72dc7504db1a131202fdecf0dc) (2026-09-06) |
| jellyfin-sdk-swift | [`50be9e5`](https://github.com/jellyfin/jellyfin-sdk-swift/tree/50be9e583438be414a15d4bba933ff64b6769a91) = v3.1.0, the revision Swiftfin pins |
| Findroid | [`bbee745`](https://github.com/jarnedemeulemeester/findroid/tree/bbee745c18aaa93643bffeba017b5f41c3c23ee2) (2026-09-06) |
| jellyfin-androidtv | [`fb4d05b`](https://github.com/jellyfin/jellyfin-androidtv/tree/fb4d05b1beb1b7627643a8b86aff9deb38e93a00) (2026-09-06) |
| jellyfin-sdk-kotlin | tag [`v1.8.12`](https://github.com/jellyfin/jellyfin-sdk-kotlin/tree/v1.8.12), pinned by both Findroid and Android TV |
| jellyfin-kodi | [`dd28460`](https://github.com/jellyfin/jellyfin-kodi/tree/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b) (2026-09-06) |
| jellyfin-web | tag [`v10.11.11`](https://github.com/jellyfin/jellyfin-web/tree/v10.11.11) = `35c0793` |
| jellyfin-apiclient-javascript | tag [`v1.11.0`](https://github.com/jellyfin/jellyfin-apiclient-javascript/tree/v1.11.0) = `0595869`, the client jellyfin-web 10.11 still routes most calls through |
| Infuse | FireCore support articles and release notes only. Closed source, so every Infuse claim below is labelled **documented** or **inferred** |

Master of jellyfin-web is already 12.0.0 and `api.jellyfin.org/openapi/jellyfin-openapi-stable.json` now serves 12.0.0, but 12.0 is still in release candidate ([`v12.0-rc7`, 2026-08-31](https://github.com/jellyfin/jellyfin/releases)). Everything here is pinned to 10.11.11, the newest stable, because that is what clients in the wild talk to.

Findroid and Android TV both pin `org.jellyfin.sdk:jellyfin-core` `1.8.12` ([findroid `gradle/libs.versions.toml:21`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/gradle/libs.versions.toml#L21), [androidtv `gradle/libs.versions.toml:32`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/gradle/libs.versions.toml#L32)).

## Endpoints by client

Legend: **M** must-have for login, browse, play or progress. **N** nice-to-have, the client works without it. **–** never called by that client. Infuse's column is inference from FireCore's docs unless marked otherwise; see [Infuse](#infuse).

### Auth and session

| Endpoint | web | Kodi | Swiftfin | Findroid | Android TV | Infuse |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /System/Info/Public` | M | M | M | M | M | M |
| `GET /System/Info` | N | M | N | – | N | N |
| `POST /Users/AuthenticateByName` | M | M | M | M | M | M |
| `GET /Users/Public` | M | M | M | M | M | – |
| `GET /Users/Me` | – | – | M | M | M | – |
| `GET /Users/{userId}` | M | M | N | – | – | – |
| `POST /QuickConnect/Initiate` | M | M | M | M | M | – |
| `GET /QuickConnect/Connect?secret=` | M | M | M | M | M | – |
| `POST /Users/AuthenticateWithQuickConnect` | M | M | M | M | M | – |
| `GET /QuickConnect/Enabled` | N | – | N | N | N | – |
| `POST /QuickConnect/Authorize` | N | – | N | – | – | – |
| `POST /Sessions/Capabilities/Full` | M | M | M | M | M | – |
| `POST /Sessions/Logout` | N | – | – | – | – | – |
| `DELETE /Auth/Keys/{key}` | N | – | N | – | – | – |
| `POST /Devices/Options` | – | – | N | N | – | – |

### Browse

| Endpoint | web | Kodi | Swiftfin | Findroid | Android TV | Infuse |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /Items` | M | M | M | M | M | M |
| `GET /Items/{itemId}` (10.10+ route) | – | – | M | M | M | ? |
| `GET /Users/{userId}/Items/{itemId}` (legacy) | M | M | – | – | – | ? |
| `GET /Users/{userId}/Items` (legacy) | M | M | – | – | – | ? |
| `GET /UserViews` | – | – | M | M | M | ? |
| `GET /Users/{userId}/Views` (legacy) | M | M | – | – | – | ? |
| `GET /UserItems/Resume` | – | – | M | M | M | ? |
| `GET /Users/{userId}/Items/Resume` (legacy) | M | M | – | – | – | ? |
| `GET /Items/Latest` | – | – | N | M | M | ? |
| `GET /Users/{userId}/Items/Latest` (legacy) | M | M | – | – | – | ? |
| `GET /Shows/NextUp` | M | M | M | M | M | ? |
| `GET /Shows/{seriesId}/Seasons` | M | M | M | M | M | M |
| `GET /Shows/{seriesId}/Episodes` | M | M | M | M | M | M |
| `GET /Items/Suggestions` | – | – | – | N | – | – |
| `GET /Users/{userId}/Suggestions` (legacy) | – | N | – | – | – | – |
| `GET /Movies/Recommendations` | N | M | – | – | – | – |
| `GET /Items/{itemId}/Similar` | N | – | N | – | N | – |
| `GET /Persons` | N | – | N | – | N | – |
| `GET /Genres` | N | M | N | – | N | – |
| `GET /Studios` | N | – | N | – | – | – |
| `GET /Items/Filters` (legacy) | – | – | N | – | – | – |
| `GET /Items/Filters2` | N | – | N | – | – | – |
| `GET /Search/Hints` | N | – | – | – | – | – |
| `GET /MediaSegments/{itemId}` | N | N | – | N | N | N (documented) |
| `GET /DisplayPreferences/{id}` | N | – | – | – | N | – |
| `GET /Branding/Configuration` | N | – | N | N | N | – |
| `GET /LiveTv/...` | N | N | N | – | N | – |
| `GET /SyncPlay/...` | N | – | – | – | – | – |

### Play

| Endpoint | web | Kodi | Swiftfin | Findroid | Android TV | Infuse |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /Items/{itemId}/PlaybackInfo` | M | M | M | M | M | M (inferred) |
| `GET /Videos/{itemId}/stream` | – | M | M | M | M | ? |
| `GET /Videos/{itemId}/stream.{container}` | M | – | – | – | – | ? |
| `GET /Videos/{itemId}/master.m3u8` | M | M | M | – | M | M (inferred) |
| `GET /Videos/{itemId}/main.m3u8` | M | M | M | – | M | M (inferred) |
| `GET /Videos/{itemId}/hls1/{playlistId}/{segmentId}.{container}` | M | M | M | – | M | M (inferred) |
| `GET /Videos/{itemId}/live.m3u8` | N | N | N | – | N | – |
| `GET /Audio/{itemId}/universal` | M | – | – | – | – | – |
| `GET /Audio/{itemId}/stream` | – | – | – | – | M | – |
| `GET /Audio/{itemId}/stream.{container}` | M | M | – | – | – | – |
| `POST /LiveStreams/Open` | M | M | – | – | – | – |
| `POST /LiveStreams/Close` | – | M | – | – | – | – |
| `DELETE /Videos/ActiveEncodings` | M | M | – | – | M | – |
| `GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}` | via `DeliveryUrl` | M | via `DeliveryUrl` | – | via `DeliveryUrl` | ? |
| `GET /Videos/{itemId}/Trickplay/{width}/{index}.jpg` | N | – | N | N | N | – |
| `GET /Playback/BitrateTest` | N | – | N | – | – | – |
| `GET /Items/{itemId}/Download` | N | – | N | – | – | N (documented) |

### Progress and user data

| Endpoint | web | Kodi | Swiftfin | Findroid | Android TV | Infuse |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /Sessions/Playing` | M | M | M | M | M | M (documented) |
| `POST /Sessions/Playing/Progress` | M | M | M | M | M | M (documented) |
| `POST /Sessions/Playing/Stopped` | M | M | M | M | M | M (documented) |
| `POST /Sessions/Playing/Ping` | – | – | – | – | – | – |
| `POST` / `DELETE /UserPlayedItems/{itemId}` | – | – | M | M | M | ? |
| `POST` / `DELETE /Users/{userId}/PlayedItems/{itemId}` (legacy) | M | M | – | – | – | ? |
| `POST` / `DELETE /UserFavoriteItems/{itemId}` | – | – | M | M | M | ? |
| `POST` / `DELETE /Users/{userId}/FavoriteItems/{itemId}` (legacy) | M | M | – | – | – | ? |
| `POST /UserItems/{itemId}/UserData` | – | – | – | N | – | – |
| `GET /socket` | M | M | M | – | M | – |

The HLS rows are marked must-have wherever the client transcodes, but only Kodi and jellyfin-web build those URLs themselves. Swiftfin and Android TV reach `master.m3u8` only by following the `TranscodingUrl` the server hands back, so the path is the server's choice. Findroid never transcodes and never reaches them.

The Kotlin SDK's `getVideoStreamUrl` and `getAudioStreamUrl` target `/Videos/{itemId}/stream` and `/Audio/{itemId}/stream` with `container` as a **query** parameter, not the `stream.{container}` route ([`VideosApi.kt:475`](https://github.com/jellyfin/jellyfin-sdk-kotlin/blob/v1.8.12/jellyfin-api/src/commonMain/kotlin-generated/org/jellyfin/sdk/api/operations/VideosApi.kt#L475), [`AudioApi.kt:423`](https://github.com/jellyfin/jellyfin-sdk-kotlin/blob/v1.8.12/jellyfin-api/src/commonMain/kotlin-generated/org/jellyfin/sdk/api/operations/AudioApi.kt#L423)). jellyfin-web and Kodi use the `stream.{container}` form. Both spellings need to work.

Findroid opens no websocket at all: a grep for `webSocket`, `WebSocket` or `/socket` across its Kotlin sources returns nothing. Swiftfin references SyncPlay only as a display string for a user policy field ([`SyncPlayUserAccessType.swift`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/SyncPlayUserAccessType.swift)), never calling a SyncPlay endpoint. Swiftfin does not call `/MediaSegments/{itemId}` either.

### Never called by any of the six

Of the 315 paths in the 10.11.11 spec, these families never appear in any client source read here: `/Trailers`, `/Backup/*` (Swiftfin admin only), `/Environment/*` (web dashboard only), `/Packages/*` (web dashboard only), `/Plugins/*` (web dashboard only), `/ClientLog/Document` (Android TV only), `/Library/VirtualFolders/*` (web dashboard only), `/Startup/*` (web setup wizard only). A media-serving translation layer can skip the dashboard families entirely and still satisfy all six clients for login, browse, play and progress.

## Auth

### The Authorization header

The scheme is `MediaBrowser` followed by comma-separated `Key=Value` pairs. The server parses it in [`AuthorizationContext.GetParts`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L276-L316): quotes around values are optional and stripped, values are URL-decoded, and keys are trimmed. Keys read are `DeviceId`, `Device`, `Client`, `Version`, `Token` ([`AuthorizationContext.cs:86-90`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L86-L90)).

Each client emits a different spelling of the same thing:

```
Kodi     Authorization: MediaBrowser Client=Jellyfin%20for%20Kodi, Device=…, DeviceId=…, Version=…, UserId=…, Token=…
Swift    Authorization: MediaBrowser DeviceId=…, Device=…, Client=…, Version=…, Token=…
Kotlin   Authorization: MediaBrowser Client="…", Version="…", DeviceId="…", Device="…", Token="…"
web      Authorization: MediaBrowser Client="…", Device="…", DeviceId="…", Version="…", Token="…"
Infuse   X-Emby-Authorization: MediaBrowser Token="#####", Client="Infuse-Direct", Version="7.7", Device="####", DeviceId="###-#-###"
```

- Kodi builds it unquoted and URL-encodes every value, and appends `UserId=` alongside `Token=` once logged in ([`jellyfin/http.py:247-274`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/http.py#L247-L274)). `UserId` is not a key the server reads.
- The Swift SDK builds it unquoted from a dictionary, so key order is not stable across runs ([`PassthroughAPIClientDelegate.swift:48`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/PassthroughAPIClientDelegate.swift#L48-L64)).
- The Kotlin SDK always quotes values, URL-encodes them, and rejects keys containing `=`, `,` or a leading/trailing quote ([`AuthorizationHeaderBuilder.kt`](https://github.com/jellyfin/jellyfin-sdk-kotlin/blob/v1.8.12/jellyfin-api/src/commonMain/kotlin/org/jellyfin/sdk/api/client/util/AuthorizationHeaderBuilder.kt)).
- jellyfin-web quotes values and omits any that are empty ([`apiClient.js:166-195`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L166-L195)).
- Infuse sends `X-Emby-Authorization`, not `Authorization`, and uses `Infuse-Direct` / `Infuse-Library` / `Infuse-Download` as the `Client` value depending on the connection mode ([FireCore, Connection Info for Emby, Jellyfin, and Plex](https://support.firecore.com/hc/en-us/articles/21072505575319-Connection-Info-for-Emby-Jellyfin-and-Plex)) — **documented**.

Fallbacks the server accepts, all gated behind `EnableLegacyAuthorization`, which defaults to `true` ([`ServerConfiguration.cs:290`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Configuration/ServerConfiguration.cs#L290)):

| Source | Gated behind legacy flag |
| --- | --- |
| `Authorization: MediaBrowser …` | no, always accepted |
| `?ApiKey=` query | no, always accepted |
| `X-Emby-Authorization` header | yes |
| `Authorization: Emby …` scheme name | yes |
| `X-Emby-Token` header | yes |
| `X-MediaBrowser-Token` header | yes |
| `?api_key=` query | yes |

Source: [`AuthorizationContext.cs:93-111`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L93-L111) and [`:229-239`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L229-L239). Since Infuse needs `X-Emby-Authorization` and the Swift SDK websocket needs `?api_key=`, Pendia has to accept the legacy set unconditionally rather than treating it as opt-in.

### Password login

`POST /Users/AuthenticateByName` with `{"Username": "...", "Pw": "..."}` and `Content-Type: application/json`. The response is `AuthenticationResult` with `User`, `SessionInfo`, `AccessToken`, `ServerId` (spec `components.schemas.AuthenticationResult`).

- Kodi posts to `Users/AuthenticateByName` with keys `username` and `Pw` — lowercase `username` ([`jellyfin/api.py:445-453`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L445-L453)). ASP.NET's JSON binder is case-insensitive, which is why this works.
- jellyfin-web posts to `Users/authenticatebyname`, lowercase path, with `Username` and `Pw` ([`apiClient.js:515-534`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L515-L534)). Route matching must be case-insensitive.
- Swiftfin goes through `Paths.authenticateUserByName(.init(pw:username:))` ([`JellyfinClient.swift:206`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinClient.swift#L206-L207)).
- Infuse "requires a direct server login" for Jellyfin, with no online account option ([FireCore, Streaming from Plex, Emby, and Jellyfin](https://support.firecore.com/hc/en-us/articles/360006462093-Streaming-from-Plex-Emby-and-Jellyfin)) — **documented**.

### Quick Connect

Three steps, identical in all five open-source clients:

1. `POST /QuickConnect/Initiate` returns `QuickConnectResult` with `Authenticated`, `Secret`, `Code`, `DeviceId`, `DeviceName`, `AppName`, `AppVersion`, `DateAdded`. The client shows `Code` to the user. `401` means Quick Connect is off on the server.
2. Poll `GET /QuickConnect/Connect?secret={Secret}` every 5 seconds until `Authenticated` is true. jellyfin-web sends `?Secret=` and Kodi sends `?Secret=`, while both SDKs send `?secret=` ([web `login/index.js:67`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/controllers/session/login/index.js#L67), [Kodi `api.py:553`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L553), [Swift `GetQuickConnectStateAPI.swift:15`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/Paths/GetQuickConnectStateAPI.swift#L15)). Query parameter matching must be case-insensitive.
3. `POST /Users/AuthenticateWithQuickConnect` with `{"Secret": "..."}` returns the same `AuthenticationResult` as password login.

Timing, from the server: the code is 6 digits and a pending request expires after 10 minutes ([`QuickConnectManager.cs:26,31`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/QuickConnect/QuickConnectManager.cs#L26-L31)). The poll interval is 5 seconds in web ([`login/index.js:105`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/controllers/session/login/index.js#L105)), 5 seconds in Android TV ([`UserLoginViewModel.kt:103`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/app/src/main/java/org/jellyfin/androidtv/ui/startup/UserLoginViewModel.kt#L103)) and 5 seconds by default in the Swift SDK, which also stops after 200 polls and gives up after 5 consecutive failures ([`QuickConnect.swift:52-56`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/QuickConnect.swift#L52-L56)). Pendia should hold a pending code for at least 10 minutes and tolerate a poll every 5 seconds per pending login.

An already-signed-in client authorises a code with `POST /QuickConnect/Authorize?code=&userId=`. Only Swiftfin and jellyfin-web implement that side.

Infuse does not implement Quick Connect. No release note mentions it, and three separate feature requests asking for it sit open in FireCore's own Suggestions forum, the most recent still unanswered as of 2026-05-23 ([community thread](https://community.firecore.com/t/support-quick-connect-for-jellyfin/59920)) — **inferred** from the absence of a release note plus the open requests.

### Token lifecycle

Access tokens carry no expiry. The token returned by `AuthenticateByName` is stored server-side against a device row and looked up on each request by `DeviceQuery { AccessToken = token }` ([`AuthorizationContext.cs:132-134`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L132-L134)). Clients keep it forever and only ever discard it on a 401.

Revocation paths in 10.11: `POST /Sessions/Logout` (current token), `DELETE /Devices?id=` (one device), `DELETE /Auth/Keys/{key}` (an API key). Swiftfin signs out with `Paths.revokeKey(key: accessToken)` ([`JellyfinClient.swift:246`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinClient.swift#L246)). Kodi validates a stored token by calling `GET system/info` with `Authorization: … , Token=…` and treating a non-200 as invalid ([`api.py:481-492`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L481-L492)).

The server also backfills `Client`, `Device` and `Version` from the stored device row when the header omits them, so a token alone is enough to identify a session.

## Playback

### The sequence

1. `POST /Sessions/Capabilities/Full` on connect, with `PlayableMediaTypes`, `SupportedCommands`, `SupportsMediaControl`. Kodi posts it from the websocket `on_open` handler after a 5 second sleep ([`ws_client.py:96-120`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/ws_client.py#L96-L120)); the Swift SDK posts it immediately before the socket handshake and again after the socket closes ([`JellyfinSocket.swift:496`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinSocket/JellyfinSocket.swift#L496)), noting in a comment that "the server drops the device from /Sessions once the socket closes".
2. `POST /Items/{itemId}/PlaybackInfo` with a `PlaybackInfoDto` body carrying `DeviceProfile`.
3. Pick a `MediaSource` from the response and build a URL from its flags.
4. `POST /Sessions/Playing`, then `POST /Sessions/Playing/Progress` on a timer, then `POST /Sessions/Playing/Stopped`.
5. Optionally `POST /LiveStreams/Close` and `DELETE /Videos/ActiveEncodings?DeviceId=&PlaySessionId=` to tear down the transcode.

### The PlaybackInfo request

Every client posts the body form, not the query form. Fields observed:

| Field | web | Kodi | Swiftfin | Findroid | Android TV |
| --- | --- | --- | --- | --- | --- |
| `DeviceProfile` | yes | yes | yes | yes | yes |
| `UserId` | yes | yes | yes | yes | – |
| `MaxStreamingBitrate` | yes | – | yes | yes | – |
| `StartTimeTicks` | yes | – | – | – | – |
| `IsPlayback` | yes | – | – | – | – |
| `AutoOpenLiveStream` | yes | yes | yes | – | yes (`false`) |
| `MediaSourceId` | yes | – | yes | yes | yes |
| `LiveStreamId` | yes | – | yes | – | – |
| `AudioStreamIndex` / `SubtitleStreamIndex` | yes | – | yes | – | – |
| `SecondarySubtitleStreamIndex` | yes | – | – | – | – |
| `EnableDirectPlay` / `EnableDirectStream` | yes | – | – | – | yes |
| `EnableTranscoding` | – | – | – | – | yes |
| `AllowVideoStreamCopy` / `AllowAudioStreamCopy` | yes | – | – | – | yes |
| `DirectPlayProtocols` | yes | – | – | – | – |
| `AlwaysBurnInSubtitleWhenTranscoding` | yes | – | – | – | – |
| `EnableMediaProbe` | yes | – | – | – | – |

Sources: [web `playbackmanager.js:415-503`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L415-L503), [Kodi `api.py:374-384`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L374-L384), [Swiftfin `MediaPlayerItem+Build.swift:74-90`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Objects/MediaPlayerManager/MediaPlayerItem/MediaPlayerItem%2BBuild.swift#L74-L90), [Findroid `JellyfinRepositoryImpl.kt:306-340`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/data/src/main/java/dev/jdtech/jellyfin/repository/JellyfinRepositoryImpl.kt#L306-L340), [Android TV `JellyfinMediaStreamResolver.kt:81-100`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/playback/jellyfin/src/main/kotlin/mediastream/JellyfinMediaStreamResolver.kt#L81-L100).

The response fields clients actually read are `MediaSources[]`, `PlaySessionId` and `ErrorCode`. Within a media source: `Id`, `ETag`, `Path`, `Protocol`, `Container`, `RunTimeTicks`, `SupportsDirectPlay`, `SupportsDirectStream`, `SupportsTranscoding`, `TranscodingUrl`, `TranscodingSubProtocol`, `TranscodingContainer`, `RequiresClosing`, `LiveStreamId`, `OpenToken`, `IsRemote`, `MediaStreams[]`, `DefaultAudioStreamIndex`, `DefaultSubtitleStreamIndex`.

### DeviceProfile shapes

The five open-source clients send wildly different profiles, so Pendia's `PlaybackInfo` handler must handle both extremes:

- **Findroid sends an empty profile.** `DeviceProfile(name = "Direct play all", maxStaticBitrate = 1_000_000_000, maxStreamingBitrate = 1_000_000_000, codecProfiles = emptyList(), containerProfiles = emptyList(), directPlayProfiles = emptyList(), transcodingProfiles = emptyList(), subtitleProfiles = [srt External, ass External])` ([`JellyfinRepositoryImpl.kt:311-335`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/data/src/main/java/dev/jdtech/jellyfin/repository/JellyfinRepositoryImpl.kt#L311-L335)). Empty `directPlayProfiles` with no transcoding profiles means Findroid ignores the negotiation and always plays `static=true`.
- **Kodi sends a small hand-written profile** with one video transcoding profile in container `m3u8`, plus 16 subtitle profiles covering srt/ass/sub/ssa/smi/pgssub/dvdsub/pgs in both Embed and External ([`playutils.py:423-518`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/helper/playutils.py#L423-L518)). For a `TvChannel` it prepends a `ts` / `hls` transcoding profile with `MinSegments: 1` and `BreakOnNonKeyFrames: true`.
- **Android TV probes the device's MediaCodec** and builds three transcoding profiles: `ts`/HLS, `mp4`/HLS (fMP4) and a `ts`/HLS fallback, all `EncodingContext.STREAMING` ([`deviceProfile.kt:162-196`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/app/src/main/java/org/jellyfin/androidtv/util/profile/deviceProfile.kt#L162-L196)).
- **Swiftfin builds the profile per player** (native AVPlayer vs VLCKit) and has a `.mostCompatible`, `.directPlay` and `.custom` mode; `.directPlay` sends direct play profiles and no transcoding profiles at all ([`DeviceProfile.swift:14-89`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/DeviceProfile.swift#L14-L89)).
- **jellyfin-web** builds a browser capability profile and, for audio, never asks the server at all.

### How each client picks direct play vs transcode

Android TV states it most plainly, in priority order ([`JellyfinMediaStreamResolver.kt:33-77`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/playback/jellyfin/src/main/kotlin/mediastream/JellyfinMediaStreamResolver.kt#L33-L77)):

1. `supportsDirectPlay` and video: `GET /Videos/{id}/stream?container=&static=true&mediaSourceId=&tag={eTag}&liveStreamId=`
2. `supportsDirectPlay` and audio: `GET /Audio/{id}/stream?container=&static=true&…`
3. `supportsDirectStream` and `transcodingUrl != null`: follow `transcodingUrl`, labelled remux
4. `supportsTranscoding` and `transcodingUrl != null`: follow `transcodingUrl`, labelled transcode

It also drops any media source whose `protocol != FILE` or whose `isRemote` is true before choosing.

jellyfin-web is close but adds a local-path case and an audio-only `StreamUrl` case ([`playbackmanager.js:2807-2880`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L2807-L2880)):

1. `mediaSource.enableDirectPlay` (a client-side flag set after probing the local file): play `mediaSource.Path` directly, `PlayMethod: DirectPlay`
2. `mediaSource.StreamUrl` present (audio only): play it, `PlayMethod: Transcode`
3. `SupportsDirectPlay || SupportsDirectStream`: `{Videos|Audio}/{id}/stream.{container}?Static=true&mediaSourceId=&deviceId=&ApiKey=&Tag=&LiveStreamId=`, `PlayMethod` is `DirectPlay` or `DirectStream`
4. `SupportsTranscoding`: `TranscodingUrl` verbatim; if `TranscodingSubProtocol === 'hls'` the content type becomes `application/x-mpegURL`

Swiftfin inverts the order and checks `transcodingURL` first, falling back to `static=true` with `tag`, `playSessionId` and `mediaSourceId` ([`MediaPlayerItem+Build.swift:187-230`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Objects/MediaPlayerManager/MediaPlayerItem/MediaPlayerItem%2BBuild.swift#L187-L230)).

Kodi is the outlier: it treats `Protocol == "Http"` or a locally reachable file as direct play of `mediaSource.Path`, otherwise direct-streams `Videos/{id}/stream?static=true&MediaSourceId=&ApiKey=`, otherwise transcodes ([`playutils.py:177-325`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/helper/playutils.py#L177-L325)). It also forces `SupportsDirectPlay = False` whenever the source has `RequiresClosing`, because "server returning live tv stream for direct play is hardcoded with 127.0.0.1".

**Kodi rewrites the transcode URL rather than following it.** It splits `TranscodingUrl` on `?`, strips `AudioBitrate` / `VideoBitrate` (and optionally `AudioStreamIndex` / `SubtitleStreamIndex`), re-adds its own, and replaces the last path segment: `base.replace("stream" if "stream" in base else "master", "live" if Protocol == "LiveTV" else "master", 1)` ([`playutils.py:239-292`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/helper/playutils.py#L239-L292)). So Pendia's `TranscodingUrl` must keep the `master.m3u8` path shape and a parseable query string, not just be a valid opaque URL.

### HLS conventions

Three levels, all under the same query string:

1. `GET /Videos/{itemId}/master.m3u8?<54 params>` returns a master playlist. Each variant line is `#EXT-X-STREAM-INF:BANDWIDTH=…` followed by `main.m3u8<queryString>`, reusing the exact incoming query string ([`DynamicHlsHelper.cs:188-212`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/DynamicHlsHelper.cs#L188-L212)). For live streams the variant is `live.m3u8` instead. When subtitles ride in the manifest, each is an `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",…,URI="{mediaSourceId}/Subtitles/{index}/subtitles.m3u8?SegmentLength=30&ApiKey={token}"` line ([`DynamicHlsHelper.cs:604-620`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/DynamicHlsHelper.cs#L604-L620)).
2. `GET /Videos/{itemId}/main.m3u8?<52 params>` returns a VOD media playlist: `#EXT-X-PLAYLIST-TYPE:VOD`, `#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE:0`, one `#EXTINF:…, nodesc` per segment, `#EXT-X-ENDLIST` ([`DynamicHlsPlaylistGenerator.cs:57-104`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L57-L104)).
3. Segment URLs are `hls1/main/{index}{extension}{queryString}&runtimeTicks={cumulativeSeconds}&actualSegmentLengthTicks={ticks}`. The literal path prefix is `hls1/main/` ([`DynamicHlsController.cs:1440`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1440)), so the concrete route is `GET /Videos/{itemId}/hls1/{playlistId}/{segmentId}.{container}` with `playlistId` fixed to `main`. For fMP4 the playlist opens with `#EXT-X-MAP:URI="hls1/main/-1{ext}?…&runtimeTicks=0&actualSegmentLengthTicks=0"`: **segment index -1 is the init segment.**

Route auth differs. `DynamicHlsController` is `[Authorize]` at class level ([`DynamicHlsController.cs:39-40`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L39-L40)), so `master.m3u8`, `main.m3u8` and every segment need a token. `VideosController` has no class-level `[Authorize]` and `GET /Videos/{itemId}/stream` has none either, so direct-stream URLs are anonymous even though every client appends `ApiKey`.

Query parameters accepted by all four video streaming routes (52 to 57 each, from the 10.11.11 spec): `static`, `params`, `tag`, `deviceProfileId`, `playSessionId`, `segmentContainer`, `segmentLength`, `minSegments`, `mediaSourceId`, `deviceId`, `audioCodec`, `enableAutoStreamCopy`, `allowVideoStreamCopy`, `allowAudioStreamCopy`, `breakOnNonKeyFrames`, `audioSampleRate`, `maxAudioBitDepth`, `audioBitRate`, `audioChannels`, `maxAudioChannels`, `profile`, `level`, `framerate`, `maxFramerate`, `copyTimestamps`, `startTimeTicks`, `width`, `height`, `maxWidth`, `maxHeight`, `videoBitRate`, `subtitleStreamIndex`, `subtitleMethod`, `maxRefFrames`, `maxVideoBitDepth`, `requireAvc`, `deInterlace`, `requireNonAnamorphic`, `transcodingMaxAudioChannels`, `cpuCoreLimit`, `liveStreamId`, `enableMpegtsM2TsMode`, `videoCodec`, `subtitleCodec`, `transcodeReasons`, `audioStreamIndex`, `videoStreamIndex`, `context`, `streamOptions`, `enableAudioVbrEncoding`, `alwaysBurnInSubtitleWhenTranscoding`. `master.m3u8` adds `enableAdaptiveBitrateStreaming` and `enableTrickplay`; `stream` adds `container`; the segment route adds `playlistId`, `segmentId`, `container`, `runtimeTicks`, `actualSegmentLengthTicks`.

Kodi appends its own `&maxWidth=&maxHeight=&VideoBitrate=&AudioBitrate=` and, for AV1, `&SegmentContainer=mp4`, mixing case freely with the spec's camelCase names.

### External subtitles

Most clients never build a subtitle URL. They read `MediaStream.DeliveryUrl` off the media source and fetch it as-is, prefixing the server base URL if it starts with `/`:

- jellyfin-web rewrites relative `DeliveryUrl` values to absolute ones when the player asks for it ([`playbackmanager.js:2818-2825`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L2818-L2825)).
- Swiftfin filters to `deliveryMethod == .external && deliveryURL != nil && isTextSubtitleStream` and resolves the path against the client base URL ([`MediaStream.swift:20-22,359`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/MediaStream.swift#L20-L22)).
- Kodi prefers `DeliveryUrl` when it starts with `/videos`, and otherwise constructs `{server}/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{codec}?ApiKey={token}` itself ([`playutils.py:733-745`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/helper/playutils.py#L733-L745)).

So Pendia must populate `MediaStream.DeliveryUrl` and `DeliveryMethod` on every external text subtitle, and also serve the hand-built path for Kodi.

### The audio shortcut

jellyfin-web skips PlaybackInfo entirely for audio when the player does not set `useServerPlaybackInfoForAudio`, and builds `GET /Audio/{itemId}/universal` from its own device profile with `UserId`, `DeviceId`, `MaxStreamingBitrate`, `Container` (a comma list of `container|codec` pairs), `TranscodingContainer`, `TranscodingProtocol`, `AudioCodec`, `MaxAudioSampleRate`, `MaxAudioBitDepth`, `ApiKey`, `PlaySessionId`, `StartTimeTicks`, `EnableRedirection`, `EnableRemoteMedia`, `EnableAudioVbrEncoding` ([`playbackmanager.js:305-352`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L305-L352)). `PlaySessionId` here is a plain incrementing integer, not a GUID.

### Progress reporting

`POST /Sessions/Playing`, `POST /Sessions/Playing/Progress` and `POST /Sessions/Playing/Stopped` all take a JSON body. Nobody calls `/Sessions/Playing/Ping`.

Kodi's start and progress bodies are identical and the richest of the five ([`player.py:111-124`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/player.py#L111-L124) and [`:409-424`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/player.py#L409-L424)):

```json
{"QueueableMediaTypes": "Video,Audio", "CanSeek": true, "ItemId": "...", "MediaSourceId": "...",
 "PlayMethod": "DirectPlay", "VolumeLevel": 100, "PositionTicks": 0, "IsPaused": false,
 "IsMuted": false, "PlaySessionId": "...", "AudioStreamIndex": 1, "SubtitleStreamIndex": 2}
```

Its stop body is only `ItemId`, `MediaSourceId`, `PositionTicks`, `PlaySessionId` ([`player.py:456-463`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/player.py#L456-L463)).

Swiftfin sends `AudioStreamIndex`, `ItemId`, `LiveStreamId`, `MediaSourceId`, `PlaySessionId`, `PositionTicks`, `SessionId`, `SubtitleStreamIndex` and, on progress, `IsPaused`; it sets `SessionId` to the play session id ([`MediaProgressObserver.swift:114-176`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Objects/MediaPlayerManager/MediaProgressObserver.swift#L114-L176)).

Findroid sends the least: `ItemId`, `CanSeek`, `IsPaused`, `IsMuted`, `PlayMethod` hardcoded to `DIRECT_PLAY`, `RepeatMode`, `PlaybackOrder`, plus `PositionTicks` on progress and stop. No `PlaySessionId` at all ([`JellyfinRepositoryImpl.kt:420-495`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/data/src/main/java/dev/jdtech/jellyfin/repository/JellyfinRepositoryImpl.kt#L420-L495)). Pendia must tolerate a missing `PlaySessionId` on progress reports.

jellyfin-web posts its whole `PlayState` object plus `ItemId`, `EventName` and, when reporting a playlist, `NowPlayingQueue` ([`playbackmanager.js:75-100`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L75-L100)). `PlayState` carries `VolumeLevel`, `IsMuted`, `IsPaused`, `RepeatMode`, `ShuffleMode`, `MaxStreamingBitrate`, `PositionTicks`, `PlaybackStartTimeTicks`, `PlaybackRate`, `SubtitleStreamIndex`, `SecondarySubtitleStreamIndex`, `AudioStreamIndex`, `BufferedRanges`, `PlayMethod`, `LiveStreamId`, `PlaySessionId`, `PlaylistItemId`, `MediaSourceId`, `CanSeek` ([`playbackmanager.js:2171-2203`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/components/playback/playbackmanager.js#L2171-L2203)). It rate-limits progress posts per `EventName`, with a forced post whenever the position drifts more than 5 seconds from the expected value ([`apiClient.js:3245-3262`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L3245-L3262)).

`PlayMethod` values seen across clients: `DirectPlay`, `DirectStream`, `Transcode`.

## BaseItemDto fields and ItemFields

### ItemFields the clients request

| Client | Values sent in `fields` |
| --- | --- |
| Kodi (video) | `Path,Genres,SortName,Studios,Writer,Taglines,LocalTrailerCount,OfficialRating,CumulativeRunTimeTicks,ItemCounts,Metascore,AirTime,DateCreated,People,Overview,Etag,ShortOverview,ProductionLocations,Tags,ProviderIds,ParentId,RemoteTrailers,SpecialEpisodeNumbers,MediaSources,VoteCount,RecursiveItemCount,PrimaryImageAspectRatio` ([`api.py:23-31`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L23-L31)) |
| Kodi (music) | `Etag,Genres,SortName,Studios,Writer,OfficialRating,CumulativeRunTimeTicks,Metascore,AirTime,DateCreated,MediaStreams,People,ProviderIds,Overview,ItemCounts` |
| Kodi (sync) | `Etag` alone, for change detection |
| Android TV (detail) | `CanDelete, ChannelInfo, Chapters, ChildCount, CumulativeRunTimeTicks, DateCreated, DisplayPreferencesId, Genres, ItemCounts, MediaSourceCount, MediaSources, MediaStreams, Overview, Path, PrimaryImageAspectRatio, Taglines, Trickplay` ([`ItemRepository.kt:6-23`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/app/src/main/java/org/jellyfin/androidtv/data/repository/ItemRepository.kt#L6-L23)) |
| Android TV (rows) | `CanDelete, ChildCount, DateCreated, Genres, Overview, PrimaryImageAspectRatio` — a deliberately lighter set for home screen rows |
| jellyfin-web | Almost always `PrimaryImageAspectRatio`, often with `MediaSourceCount`, `SortName`, `DateCreated`, `ChannelInfo`, `CanDelete`, `Path`, `ChildCount`, `Chapters`, `Trickplay`, `ItemCounts`, `Taglines`, `CanDownload` |
| Findroid | `Overview` for seasons; `Chapters, Trickplay` for the player queue. Nothing else |
| Swiftfin | `channelInfo` for live TV rows and `overview` for the episode library. It relies on `GET /Items/{id}?userId=` returning the full DTO instead of naming fields ([`BaseItemDto.swift:617-634`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/BaseItemDto/BaseItemDto.swift#L617-L634)) |

The practical rule: `PrimaryImageAspectRatio`, `Overview`, `Genres`, `MediaSources`, `MediaStreams`, `Chapters`, `Trickplay`, `Path`, `DateCreated`, `ChildCount`, `ItemCounts`, `Taglines`, `CanDelete` and `Etag` cover every request seen. **Swiftfin needs the item detail route to return everything regardless of `fields`.**

### BaseItemDto fields read by at least one client

Counted by matching each of the 154 `BaseItemDto` property names from the 10.11.11 spec against jellyfin-web (`.PascalCase`), Android TV and Findroid (`.camelCase`), and Swiftfin separately against the Swift SDK's property names. Counts are references, not distinct call sites, and short names such as `Height`, `Width`, `Status`, `Audio` and `Number` collide with other types, so treat those as noisy.

Read by all four measured clients: `Id`, `Name`, `Type`, `Path`, `Overview`, `Genres`, `IndexNumber`, `ParentIndexNumber`, `SeriesId`, `SeriesName`, `SeasonId`, `ProductionYear`, `PremiereDate`, `CommunityRating`, `OfficialRating`, `MediaSources`, `MediaStreams`, `Chapters`, `Trickplay`, `CollectionType`, `ParentId`, `AspectRatio`, `EndDate`.

Read by three of four: `MediaType`, `RunTimeTicks`, `ImageTags`, `UserData`, `IsFolder`, `Container`, `ChannelId`, `PrimaryImageAspectRatio`, `DateCreated`, `People`, `Taglines`, `OriginalTitle`, `ChildCount`, `SeasonName`, `IsSeries`, `IsMovie`, `Album`, `AlbumArtist`, `Artists`, `CriticRating`, `StartDate`, `ServerId`.

jellyfin-web only: `SortName`, `BackdropImageTags`, `ParentBackdropImageTags`, `ParentBackdropItemId`, `ParentLogoImageTag`, `ParentLogoItemId`, `ParentThumbImageTag`, `ParentThumbItemId`, `ParentPrimaryImageTag`, `ParentPrimaryImageItemId`, `SeriesPrimaryImageTag`, `SeriesThumbImageTag`, `ChannelPrimaryImageTag`, `AlbumPrimaryImageTag`, `Tags`, `IsHD`, `MediaSourceCount`, `VideoType`, `HasSubtitles`, `LocationType`, `ProgramId`, `ImageBlurHashes`, `ProductionLocations`, `ExtraType`, `ProviderIds`, `RecursiveItemCount`, `AirTime`, `AirDays`, `CompletionPercentage`, `ExternalUrls`, `CustomRating`, `Video3DFormat`, `SourceType`, `IsPlaceHolder`, `EnableMediaSourceDisplay`, `AirsBeforeSeasonNumber`, `AirsAfterSeasonNumber`, `AirsBeforeEpisodeNumber`, `GenreItems`, `SpecialFeatureCount`, `TrailerCount`, `ProgramCount`, `ArtistCount`, `MusicVideoCount`.

Findroid additionally reads `seriesPrimaryImageTag` and `backdropImageTags` to build image URLs, and `imageBlurHashes` for placeholders ([`FindroidImages.kt:18-67`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/data/src/main/java/dev/jdtech/jellyfin/models/FindroidImages.kt#L18-L67)). Swiftfin reads `imageBlurHashes` per image type and per tag ([`BaseItemDto+Images.swift:69-78`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/BaseItemDto/BaseItemDto%2BImages.swift#L69-L78)).

Read by none of the four: `Etag` (Kodi does use it), `DateLastMediaAdded`, `PlayAccess`, `ScreenshotImageTags`, `ParentArtItemId`, `ParentArtImageTag`, `SeriesStudio`, `IsoType`, `ChannelType`, and the whole photo EXIF block: `CameraMake`, `CameraModel`, `ExposureTime`, `FocalLength`, `ImageOrientation`, `Aperture`, `ShutterSpeed`, `Latitude`, `Longitude`, `Altitude`, `IsoSpeedRating`. For a video-first translation layer those 20 fields can be omitted or nulled.

## Websocket

The endpoint is `GET /socket`, upgraded. It does not appear in the OpenAPI spec, so it has to be implemented from client behaviour.

Two authentication styles, both in the wild:

| Client | How the socket authenticates |
| --- | --- |
| jellyfin-web | `?api_key={token}&deviceId={id}` on the URL, no header ([`apiClient.js:612-635`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L612-L635)). It also rewrites `emby/socket` to `embywebsocket` for old servers |
| Swiftfin (Swift SDK) | `?api_key={token}&deviceId={id}` **and** the `Authorization: MediaBrowser …` header ([`JellyfinClient.swift:316-336`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinClient.swift#L316-L336), [`JellyfinSocket.swift:504`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinSocket/JellyfinSocket.swift#L504)) |
| Android TV (Kotlin SDK) | `Authorization` header only, no query string ([`DefaultSocketApi.kt:60,260`](https://github.com/jellyfin/jellyfin-sdk-kotlin/blob/v1.8.12/jellyfin-api/src/commonMain/kotlin/org/jellyfin/sdk/api/sockets/DefaultSocketApi.kt#L60)) |
| Kodi | `Authorization` header only, with quoted values ([`ws_client.py:56-76`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/ws_client.py#L56-L76)) |

Every frame is `{"MessageType": "...", "Data": ...}`.

**Sent by clients (inbound to the server):**

| Message | Data | Sent by |
| --- | --- | --- |
| `KeepAlive` | `30` (Kodi) or absent | Kodi every 30 s, web on `ForceKeepAlive`, Swift SDK on a timer, Kotlin SDK on a timer |
| `SessionsStart` | `"0,1500"` | web dashboard, Swiftfin |
| `SessionsStop` | `null` | web dashboard, Swiftfin |
| `ScheduledTasksInfoStart` | `"1000,1000"` | web dashboard, Swiftfin |
| `ScheduledTasksInfoStop` | `null` | web dashboard, Swiftfin |
| `ActivityLogEntryStart` / `ActivityLogEntryStop` | interval string / none | Swiftfin |

The two data strings are `"{dueTimeMs},{periodMs}"`. Sources: [web `useLiveSessions.ts:56-61`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/apps/dashboard/features/sessions/hooks/useLiveSessions.ts#L56-L61), [web `useLiveTasks.ts:32-38`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/apps/dashboard/features/tasks/hooks/useLiveTasks.ts#L32-L38), [Swift `Subscription.swift:14-56`](https://github.com/jellyfin/jellyfin-sdk-swift/blob/50be9e583438be414a15d4bba933ff64b6769a91/Sources/JellyfinSocket/Subscription.swift#L14-L56), [Kodi `ws_client.py:165`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/ws_client.py#L165).

**Handled by clients (outbound from the server):**

| Message | web | Kodi | Swiftfin | Android TV |
| --- | --- | --- | --- | --- |
| `Play` | yes | yes | yes | yes |
| `Playstate` | yes | yes | yes | yes |
| `GeneralCommand` | yes | yes | yes | yes |
| `UserDataChanged` | yes | yes | – | – |
| `LibraryChanged` | yes | yes | – | yes |
| `KeepAlive` | yes | – | yes | yes |
| `ForceKeepAlive` | yes | – | – | yes |
| `Sessions` | yes | – | yes | – |
| `ScheduledTasksInfo` | yes | – | yes | – |
| `ActivityLogEntry` | yes | – | yes | – |
| `SyncPlayCommand` / `SyncPlayGroupUpdate` | yes | – | – | – |
| `ServerRestarting` / `ServerShuttingDown` | yes | yes | – | – |
| `RefreshProgress` | yes | ignored explicitly | – | – |

Sources: [web `serverNotifications.js:142-198`](https://github.com/jellyfin/jellyfin-web/blob/v10.11.11/src/scripts/serverNotifications.js#L142-L198), [Kodi `monitor.py:156-210`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/monitor.py#L156-L210) and [`entrypoint/service.py:180-345`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/entrypoint/service.py#L180-L345), [Swiftfin `ServerSocketManager.swift:229-243`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Services/ServerSocketManager.swift#L229-L243), [Android TV `SocketHandler.kt:98-150`](https://github.com/jellyfin/jellyfin-androidtv/blob/fb4d05b1beb1b7627643a8b86aff9deb38e93a00/app/src/main/java/org/jellyfin/androidtv/data/eventhandling/SocketHandler.kt#L98-L150).

`ForceKeepAlive` carries a timeout in seconds; web replies with a `KeepAlive` immediately and then schedules one at half that interval ([`apiClient.js:4042-4063`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L4042-L4063)). The `GeneralCommand` types clients actually act on are `DisplayMessage`, `DisplayContent`, `SendString`, `SetAudioStreamIndex`, `SetSubtitleStreamIndex`, `SetVolume`, `SetRepeatMode`, `SetShuffleQueue`, `Mute`, `Unmute`, `ToggleMute`, `VolumeUp`, `VolumeDown`, `PlayMediaSource`, `PlayTrailers`, plus the navigation set (`MoveUp`, `MoveDown`, `MoveLeft`, `MoveRight`, `Select`, `Back`, `PageUp`, `PageDown`, `GoHome`, `GoToSearch`, `GoToSettings`).

## Images

`GET /Items/{itemId}/Images/{imageType}` and `GET /Items/{itemId}/Images/{imageType}/{imageIndex}`. Neither declares a security requirement in the 10.11.11 spec, so both are anonymous. Findroid relies on that: it builds image URLs with only `?tag=` and no token ([`FindroidImages.kt:18-45`](https://github.com/jarnedemeulemeester/findroid/blob/bbee745c18aaa93643bffeba017b5f41c3c23ee2/data/src/main/java/dev/jdtech/jellyfin/models/FindroidImages.kt#L18-L45)). **Pendia must serve item images without authentication or Findroid shows no artwork.**

Parameters clients pass:

| Parameter | web | Kodi | Swiftfin | Findroid | Android TV |
| --- | --- | --- | --- | --- | --- |
| `tag` | yes | – | yes | yes | yes |
| `maxWidth` / `maxHeight` | yes | `MaxWidth` only | yes | – | yes |
| `fillWidth` / `fillHeight` | yes | – | – | – | yes |
| `quality` | yes (96 for cards) | – | yes, clamped 1..100 | – | – |
| `format` | – | `format=jpg` | `png` for logos | – | – |
| `blur` | yes | – | – | – | – |

Swiftfin multiplies the requested width and height by the display scale before sending them ([`BaseItemDto+Images.swift:101-126`](https://github.com/jellyfin/Swiftfin/blob/0f2f70be84010b72dc7504db1a131202fdecf0dc/Shared/Extensions/JellyfinAPI/BaseItemDto/BaseItemDto%2BImages.swift#L101-L126)); jellyfin-web does the same with `devicePixelRatio` ([`apiClient.js:4208-4236`](https://github.com/jellyfin/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js#L4208-L4236)). Kodi builds the URL by hand as `Items/{id}/Images/{art}?MaxWidth={n}&format=jpg` with an optional index segment ([`api.py:109-127`](https://github.com/jellyfin/jellyfin-kodi/blob/dd28460bae83b1676a7f4f2b6a5465e09e0ca55b/jellyfin_kodi/jellyfin/api.py#L109-L127)).

Other image routes in use: `GET /UserImage` (Swiftfin), `GET /Users/{userId}/Images/{imageType}` (web, Findroid, Android TV), `GET /Branding/Splashscreen` (Swiftfin, Android TV), `GET /Videos/{itemId}/Trickplay/{width}/{index}.jpg` (Swiftfin, Findroid, Android TV, web), `GET /Items/{itemId}/Images` for the image manager (Swiftfin, web).

## Infuse

Infuse is closed source. Every claim below is either **documented** by FireCore or **inferred** from documented behaviour plus what the Jellyfin API makes possible.

**Documented:**

- Infuse sends `X-Emby-Authorization: MediaBrowser Token="#####", Client="Infuse-Direct", Version="7.7", Device="####", DeviceId="###-#-###"`, `Accept: application/json` and `User-Agent: Infuse-Direct/7.7` ([Connection Info for Emby, Jellyfin, and Plex](https://support.firecore.com/hc/en-us/articles/21072505575319-Connection-Info-for-Emby-Jellyfin-and-Plex)).
- The `Client` value and User-Agent vary by connection mode: `Infuse-Direct` (default since 7.7, loads content on demand), `Infuse-Library` (pre-caches server data), `Infuse-Download` (offline downloads). Same article.
- Jellyfin "requires a direct server login" with no online account option ([Streaming from Plex, Emby, and Jellyfin](https://support.firecore.com/hc/en-us/articles/360006462093-Streaming-from-Plex-Emby-and-Jellyfin)).
- Infuse syncs watched history and playback progress with the server. Same article, and release note 6.4.7 "Record playback progress in Plex/Emby/Jellyfin for synced videos" ([release notes](https://firecore.com/releases)).
- Transcoding arrived in 8.5: "Added transcoding options for Emby, Jellyfin, and Plex", surfaced as a Transcoding setting and a version picker, with "Direct Play remains the best option whenever possible" ([Infuse 8.5 blog post](https://firecore.com/blog/infuse-85-smarter-streaming)).
- Multi-version support since 7.8: "Support for multiple video versions from Emby and Jellyfin" (release notes).
- Media segments since 8.0.4: "Skip Intro, Preview, and Credits for Jellyfin 10.10+" (release notes). 8.1.5 added automatic skipping.
- Version tracking: 7.4 "Support for Jellyfin 10.8", 7.7.6 "Support for Jellyfin 10.9", 8.2.1 "Support for Jellyfin 10.11", 8.3.6 "Fixed login flow for Jellyfin 10.12" (release notes).
- Dolby Atmos tags read since 8.4.7 (release notes).
- Redirect handling changed in 8.4.8: "Improved handling of redirects for Emby, Jellyfin, and Plex" (release notes).

**Inferred:**

- Infuse authenticates with `POST /Users/AuthenticateByName` and holds the returned `AccessToken`. The documented header carries `Token="…"`, which is what that endpoint returns, and no other Jellyfin route hands out a token for username and password.
- No Quick Connect. Three open feature requests in FireCore's Suggestions forum ask for it, and no release note has ever announced it ([thread](https://community.firecore.com/t/support-quick-connect-for-jellyfin/59920)).
- Infuse calls `POST /Items/{id}/PlaybackInfo` with a DeviceProfile. It is the only route that returns per-source `SupportsDirectPlay` and a `TranscodingUrl`, and 8.5's transcoding options plus 7.8's multi-version list both need that response.
- Infuse reads `MediaSources[]` and `MediaStreams[]`: the multi-version picker, edition labels (8.1.4) and Atmos tags (8.4.7) all come from those arrays.
- Infuse calls `GET /MediaSegments/{itemId}`, since that route is the only source of intro, preview and credits markers referenced by 8.0.4's "Jellyfin 10.10+" qualifier.
- Infuse follows the server's `TranscodingUrl` as HLS rather than constructing its own, matching every other client that transcodes.
- Which browse routes Infuse uses, and whether it prefers the 10.10+ or legacy user-scoped routes, is **unknown**. The 8.3.6 note "Fixed login flow for Jellyfin 10.12" hints it tracks route changes closely rather than pinning old ones.

Note that Kodi is the only client here whose direct-play mode reads `mediaSource.Path` from disk; Infuse's Direct Mode is a metadata-caching strategy, not filesystem access, so it always streams over HTTP.

## Open questions for the translation layer scope ticket (#12)

1. Does Pendia serve both route dialects, or does it ship the 10.10+ routes and treat Kodi and jellyfin-web 10.11 as needing a legacy shim? Serving both is roughly 15 extra route aliases with identical handlers.
2. Does Pendia expose a real `TranscodingUrl` with a `master.m3u8` path shape, or refuse to transcode at all? Findroid works fine with a server that never transcodes; Kodi actively rewrites the URL, so a synthetic one will break it.
3. Is `/Audio/{id}/universal` in scope for v1? jellyfin-web plays all music through it and never calls PlaybackInfo for audio, so the Jellyfin translation layer needs it even though [ADR 0004](../adr/0004-translation-layer-per-medium.md) puts music behind OpenSubsonic.
4. Anonymous image serving is required, not optional. Does that conflict with Pendia's own auth model?
5. Which websocket subscriptions does Pendia implement? `Play`, `Playstate` and `GeneralCommand` are remote-control features that need a session registry; `LibraryChanged` and `UserDataChanged` are cheap and let Kodi keep its local database in sync.
6. Is Live TV in scope? Android TV and jellyfin-web reference it heavily (57 and 121 hits), Findroid not at all. Excluding it means those two clients show empty guides rather than failing.
