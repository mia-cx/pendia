# Jellyfin translation layer

Pendia speaks enough of the Jellyfin API that existing clients work without changes. Field-level detail is in the research findings on branch `research/jellyfin-client-api`.

## Promised clients

Infuse and Swiftfin are the clients Mia tests. Findroid and Jellyfin Android TV are expected to work. Any client that talks to a Jellyfin server over its API is welcome; the promise is the endpoint list below, not a client list.

Not promised: Kodi and jellyfin-web, which both call the pre-10.10 `/Users/{userId}/...` routes. Pendia serves the 10.10 and later dialect only. If Kodi matters later, a Pendia Kodi plugin beats serving a second dialect forever.

## Endpoints

Auth
- `POST /Users/AuthenticateByName`
- `POST /QuickConnect/Initiate`, `GET /QuickConnect/Connect`, `POST /Users/AuthenticateWithQuickConnect`
- `POST /Sessions/Logout`
- `GET /System/Info`, `GET /System/Info/Public`, `GET /Users/Me`

Browse
- `GET /UserViews`
- `GET /Items`, `GET /Items/{id}`
- `GET /UserItems/Resume`
- `GET /Shows/NextUp`, `GET /Shows/{id}/Seasons`, `GET /Shows/{id}/Episodes`

Play
- `POST /Items/{id}/PlaybackInfo`
- `GET /Videos/{id}/stream`
- `GET /videos/{id}/master.m3u8`, `main.m3u8`, segment routes
- `GET /Videos/{id}/{source}/Subtitles/{index}/Stream.vtt`

Progress and marks
- `POST /Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped`
- `POST` and `DELETE /UserPlayedItems/{id}`
- `POST` and `DELETE /UserFavoriteItems/{id}`

Images
- `GET /Items/{id}/Images/{type}`, anonymous, with `tag`, `maxWidth`, `fillWidth`, `quality`

Websocket `/socket`
- `KeepAlive`, `LibraryChanged`, `UserDataChanged`

Absent
- Live TV: endpoints answer with empty lists, so a guide is empty rather than broken.
- Music and audio: deferred with the medium.
- Remote control, `Play`, `Playstate`, `GeneralCommand`, and SyncPlay: deferred.

## Mapping

- A Jellyfin GUID is the Pendia UUID without dashes, for Items and users alike, so no mapping table exists.
- A client's DeviceProfile becomes the playback engine's client profile through one table. An unknown codec string counts as unsupported.
- Pendia serves a real transcode URL in Jellyfin's `master.m3u8` shape, and clients follow it as given.
- Query parameter names are matched case-insensitively, as ASP.NET does and clients rely on.
