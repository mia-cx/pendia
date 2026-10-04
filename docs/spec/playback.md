# Playback decisions

How Pendia decides what a client receives for an Item. Every rule here is meant to be encoded by a test.

## Inputs

- The client profile: accepted containers, video codecs with profile, level and maximum resolution, audio codecs with maximum channels, subtitle formats, HDR flavours, maximum bitrate. Known clients that lie get an admin-editable override entry.
- The effective cap: the lowest of the global default, the per-user override and the session request. No cap on the LAN.
- The Item's Versions with their Streams and the flags the probe precomputed: codec, profile, level, resolution, HDR flavour, Dolby Vision profile, bitrate, audio channels and languages, subtitle formats, keyframe index.
- The Item's segment timeline.

## Per-stream rules

| Stream | Pass when | Otherwise |
|---|---|---|
| Video | codec, profile, level, resolution and HDR flavour supported, bitrate under the cap | re-encode to the best supported codec at the nearest ladder rung under the cap, tone map if the HDR flavour is unsupported |
| Audio | codec supported, channels within the client maximum | EAC3 5.1 when supported and the source has 6 or more channels, else AAC stereo downmix |
| Text subtitles | client renders the format | convert to WebVTT, delivered on the side, never burned in |
| Bitmap subtitles | client renders PGS or VobSub | burn in, which forces a video re-encode |

Dolby Vision profiles 7 and 8 carry an HDR10 base layer and play as HDR10 on clients without DV. Profile 5 has none and tone maps on the CPU path. An HLS stream copy takes only the fMP4-safe codecs (H.264, HEVC, AV1, VP9, MPEG-4 and MPEG-2 video; AAC, AC-3, E-AC-3, Opus, FLAC, MP3, ALAC and DTS audio); anything else follows the video or audio rule.

## Stream selection

A plan may name one audio Stream and one subtitle Stream, or no subtitles, by the File's Stream index. The session stores the choice with its decision, and only the chosen Streams count for the rules above.

- No audio named: the default-flagged audio Stream, else the first.
- No subtitle named: every subtitle Stream counts, so a bitmap one the client cannot draw is burned in.
- Subtitles off: nothing is burned in and the master playlist lists no subtitle rendition.
- A named text subtitle is the only WebVTT rendition, marked `DEFAULT`.
- A named bitmap subtitle is burned in whenever the session plays over HLS, since HLS carries only WebVTT, even for a client that draws it.
- A direct play gets the File's default audio, so naming another audio Stream plays over HLS. Stored rungs carry the first audio Stream, so naming another plays live.

## Play method

- Direct play: every stream passes and the container is accepted. The file goes out over HTTP range requests.
- Remux: every stream passes but the container or a subtitle format is not accepted. fMP4 HLS, no re-encode.
- Transcode: any stream re-encodes. fMP4 HLS.

## Segment timeline

One per Item, or one per cut when an Item has several cuts. Pendia derives it once from the Item's first Version: the subset of that Version's keyframes closest to a 4 s target. Every Version Pendia produces forces keyframes at those timestamps. A Version from elsewhere joins the adaptive group only when its keyframes include every timeline timestamp. Every media playlist, live or stored, uses these boundaries.

## Renditions

- Video variants: the Versions in the Item's adaptive group that pass the video rule, in the client's best supported codec family, sorted by bitrate. The client's HLS player switches between them. A live transcode variant appears only when no stored Version passes.
- Audio: one rendition per audio Stream of the selected Version, tagged with `CODECS` and `CHANNELS`, so a headphone client picks stereo and a receiver picks 5.1 or Atmos. When no stereo track exists, an AAC stereo rendition is transcoded on demand. Audio is selected per session and switched per track. A stored Version carries the tracks it was encoded with; no separate audio renditions are stored.
- Subtitles: text tracks as WebVTT renditions, converted on demand.

## Fetched subtitles

Subtitle providers, OpenSubtitles first, fetch the admin's subtitle languages for each matched movie and episode. A track lands in the Item's folder as `.pendia/subtitles/<item id>.<language>.<format>`, in the provider's format: SubRip, ASS or WebVTT. The file is the record: the play plan lists the tracks found there for every play method, each with a URL that serves the file to callers who may view the Item, and deleting the file removes the track. One track per language; a forced-only track does not count.

## Stored Versions

Pendia owns pre-transcoding, with the quality profile, never the live profile. When transcoding is enabled for a library or an Item, a store job segments the source into a folder next to the source file, named after it with a `.pendia` suffix, one subfolder per rung. The source rung is a remux. A Stored Version is offered only when every segment is present; otherwise the client gets a live transcode for that rung. A per-library policy names the rungs to store and the condition, for example a 1080p H.264 8 Mbit/s AAC stereo Version for every Item whose best Version is 4K, HEVC or HDR. Manual per-Item requests exist. Store jobs run on workers at low priority inside an idle window. When the source file is deleted, its derived folder goes with it. Files transcoded elsewhere still become Versions when they land in the canonical folder, and join the adaptive group only when aligned. Live transcodes are never kept.

## Caps and ladder

Global default, per-user override, session request; the lowest wins. Ladder: 20, 10, 6, 3 and 1.5 Mbit/s, resolution following. One live transcode rendition per session.

## Hardware

A startup trial encode per backend fills a capability table: codecs, tone mapping per HDR flavour. Preference order QSV, VAAPI, NVENC, Vulkan, CPU. The MVP runs on CPU, so the engine's first job is avoiding re-encodes.
