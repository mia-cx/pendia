# Jellyfin translation layer

Thalia mirrors Jellyfin's official stable OpenAPI contract. Every documented operation has a route, including HEAD requests.
The adapter uses Thalia's core functions. It runs no database queries and does not put Jellyfin DTOs in the core.

## Contract

- Jellyfin 12.2.0, released as [v12.2](https://github.com/jellyfin/jellyfin/releases/tag/v12.2).
- Downloaded 2026-10-10 from [the official stable document](https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json).
- Committed as `apps/server/src/jellyfin/openapi/jellyfin-12.2.0.json`, with source and SHA-256 in `openapi/source.json`.
- 364 operations across 45 tag groups. The committed document decides paths, methods, response schemas, and authorization policies.
- `coverage.test.ts` generates registration and seeded response checks from that document. Every operation runs; none are skipped as known gaps.
- `coverageSummary()` counts 133 real adapters, 231 neutral responses, and zero missing or unclassified operations.

## Coverage decisions

Neutral reads return an empty result or default configuration. Neutral writes use the contract's accepted response, preferably 204.
Real operations connect the supported movie/show concepts to the core. An operation can have neutral branches for unsupported media or resources.
Operations marked `RequiresElevation` or `FirstTimeSetupOrElevated` require an admin session, including neutral operations.

| Tag group | Behaviour | Notes |
| --- | --- | --- |
| System | Real / neutral | Real identity, endpoint locality, ping, and UTC time. Default configuration; empty logs/storage; accepted configuration/restart/shutdown writes. |
| Authentication | Real / neutral | Real local login, Quick Connect, and admin-managed recoverable integration keys. Password recovery requests direct clients to the administrator. |
| User | Real / neutral | Account listing, creation, rename, deletion, password changes, disabled/admin/play/subtitle/bitrate policy, and stored configuration. Public users remain hidden through a neutral empty list. Unsupported policy capabilities stay disabled. |
| UserView, Show | Real | Authorized library views, grouping options, seasons, episodes, next-up, and upcoming episodes. |
| Library | Real / neutral | Real browse/detail, catalogue removal, physical paths, scan/refresh, downloads/files, and media/provider notifications. Themes, intros, collections, extras, and Jellyfin-only provider option pages return neutral results. |
| Device | Real | Live session-backed devices, custom names, and revocation. |
| DisplayPreference | Real | Schema-validated preferences stored per user, client, and preference id. Owners and administrators have access. |
| Session | Real / neutral | Live device sessions, stored client capabilities/viewing state, current playback and player state, heartbeats, and playback reports. Remote commands, additional session users, and server messages have no core transport and are neutral. |
| Filter, Genre, Person, Year, Search | Real | Authorized genre/tag/rating/year/language facets, contributor credits, and paged item/person/genre search hints. Genre and year ids remain stable across restarts. |
| Studio | Neutral | No studio model. Empty lists and default item responses. |
| LibraryStructure | Real / neutral | Create, rename, remove, and scan movie/show libraries; add/remove roots and round-trip library options. Other media have no core medium. Jellyfin-only options are stored client preferences and do not change core scanning. |
| ItemUpdate | Real / neutral | Edit movie/show/season/episode and contributor metadata, dates, provider ids, genres/tags, and credits. Library item names rename the library. Legacy content-type overrides have no separate core model and are accepted no-ops. |
| ItemLookup | Real / neutral | Search configured movie/show metadata providers, read external-id descriptors, and apply a chosen identity and metadata. Missing credentials retain selected ids and queue a fetch. Music, books, box sets, trailers, and remote person lookup have no matching core provider capability. |
| RemoteImage | Real / neutral | List configured item artwork providers, fetch candidates for stored identifiers, page/filter candidates, and download a selected original. Library/person/facet image owners do not exist in the core. |
| Movie, Suggestion | Real | Suggestions use unplayed items. Movie recommendations and similar lists use available movies and matching genres. |
| Image | Real / neutral | Read selected item originals and image info, upload base64 or raw images, replace/delete originals, and serve GET/HEAD aliases. Resize respects width/height bounds and encodes JPEG, PNG, or WebP; other format requests use PNG. One original per core image kind; reordering and other image owners are neutral. |
| MediaInfo | Real / neutral | Source discovery, profile-based playback planning, and bounded bitrate-test bytes. No live-stream resource; accepted open/close responses are neutral. |
| UserData | Real | Read/import partial progress, play counts/dates, favourites, numeric ratings, and independent likes/dislikes. Played marks also update descendants. |
| Video | Real / neutral | Authorized GET/HEAD direct files and container aliases. Multipart files are not separate Items; additional-part Items, attachments, and manual version-group overrides have no core model. Their reads/writes are neutral. |
| Subtitle | Real / neutral | Search/download configured providers, upload/delete stored tracks, expose external tracks in source discovery, and serve embedded/stored WebVTT, SRT, ASS, JSON cue events, time windows, and HLS playlists. Native ASS delivery preserves styles and positioning. Full, forced, and hearing-impaired tracks remain distinct. Embedded originals stay inside source files. No fallback-font store; font reads are neutral. |
| Artist, Audio, MusicGenre, InstantMix, Lyric | Neutral | No music medium. Empty lists/defaults, accepted writes, empty binary responses. |
| LiveTv, Channel | Neutral | No tuner, channels, programmes, recordings, or listing providers. |
| SyncPlay | Neutral | No synchronized playback groups. Empty group lists and accepted no-op controls. |
| Collection, Playlist | Neutral | No collection or playlist model. Empty results and accepted no-op writes. |
| Plugin, ScheduledTask, Backup, Environment | Neutral | Jellyfin-specific plugins, tasks, backups, and host configuration have no Thalia equivalent. |
| Branding, Localization, Startup | Neutral | Default branding/localization/setup responses. Thalia is already configured. |
| MediaSegment, Trailer, TrickPlay | Neutral | No detected intro/outro segments, trailers, or trickplay tiles. Empty results and valid neutral media. Core file chapters belong in item detail. |

## Mapping

- A Jellyfin GUID is the Thalia UUID without dashes, for Items and users alike, so no mapping table exists.
- A client's DeviceProfile becomes the playback engine's client profile through one table. An unknown codec string counts as unsupported.
- Thalia serves a real transcode URL in Jellyfin's `master.m3u8` shape, and clients follow it as given.
- PlaybackInfo takes `AudioStreamIndex` and `SubtitleStreamIndex` from the body or the query and plans the session with them; `SubtitleStreamIndex=-1` turns subtitles off. Both indexes stay on the transcode URL, and `DefaultAudioStreamIndex` and `DefaultSubtitleStreamIndex` name the session's choice.
- Query parameter names are matched case-insensitively, as ASP.NET does and clients rely on.
- Specific literal routes precede parameter routes. `/Items/Latest` never resolves as an Item id.
- Browse requests use the signed-in user's permissions. Administrators may specify another user id; that user's library access still applies.
- Device sessions and ordinary API keys remain hash-only. Administrator-created integration keys also retain an authenticated encrypted copy for Jellyfin's key listing workflow.
- Password changes verify the owner's current password and revoke other device sessions atomically. Administrator resets require a session credential. Intentionally passwordless local accounts remain distinct from external-auth accounts.
- Policy changes apply atomically, including re-enabling disabled accounts. Account deletion, disabling, and group changes preserve an enabled administrator.
- Library roots retain Thalia's absolute-path and non-overlap rules. Catalogue deletion removes database entries and stored artwork while retaining source media files.
- Manual metadata edits use the same library/item locks and contributor creation lock as provider metadata. Explicit provider ids replace the editor's supplied set.
- Interactive lookup and background jobs share credentialed built-in/plugin providers. Identifying a Show queues its descendants to follow the chosen root identity, preserving explicitly pinned children. Artwork replacement removes obsolete selections; preservation fills missing types only. Queued fetches retain that choice. One original per core artwork type is selected.
- Item artwork covers Primary, Backdrop, Logo, and Thumb at index zero. Uploads share bounded decoding and original storage with provider downloads. HEAD returns GET headers without a body, including on errors. JPEG/PNG/WebP and quality choices belong to the core resize cache key. Image effects and playback overlays have no core renderer and leave the image undecorated.
- Playback source discovery does not start a play. A requested user controls source visibility; planned sessions and tokens retain the authenticated player's identity. Device listings use active core plays and retain per-device position, pause, mute, volume, and selected streams. Stopped plays disappear; heartbeats never count a play.
- Personal-state imports preserve omitted and null fields and never start playback. An explicit position retains or restores its Version association. Positions use that Version's duration. Likes/dislikes and numeric ratings are separate opinions; the rating-delete operation clears the binary opinion only.
- Subtitle jobs and interactive searches share credentialed built-in/plugin providers. Uploads and downloads use core asset roots and management permissions. Stored tracks receive shared indexes after the Item's embedded streams, and external selection disables embedded subtitle output. Converted text uses a bounded file-revision cache. ASS delivery keeps native styles and dialogue overrides. Jellyfin Web's `js`/`json` delivery uses timed cue events. Time windows clip cues and optionally retain source timestamps; HLS segment URLs retain header or query authentication and WebVTT time maps.
