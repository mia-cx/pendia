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

Dolby Vision profiles 7 and 8 carry an HDR10 base layer and play as HDR10 on clients without DV. Profile 5 has none and tone maps on the CPU path. TrueHD and DTS-HD pass only on direct play; in HLS they follow the audio rule.

## Play method

- Direct play: every stream passes and the container is accepted. The file goes out over HTTP range requests.
- Remux: every stream passes but the container or a subtitle format is not accepted. fMP4 HLS, no re-encode.
- Transcode: any stream re-encodes. fMP4 HLS.

## Segment timeline

One per Item, or one per cut when an Item has several cuts. Pendia derives it once from the Item's first Version: the subset of that Version's keyframes closest to a 4 s target. Every Version Pendia produces forces keyframes at those timestamps. A Version from elsewhere joins the adaptive group only when its keyframes include every timeline timestamp. Every media playlist, live or stored, uses these boundaries.

## Renditions

- Video variants: the Versions in the Item's adaptive group that pass the video rule, in the client's best supported codec family, sorted by bitrate. The client's HLS player switches between them. A live transcode variant appears only when no stored Version passes.
- Audio: one rendition per audio Stream of the selected Version, tagged with `CODECS` and `CHANNELS`, so a headphone client picks stereo and a receiver picks 5.1 or Atmos. When no stereo track exists, an AAC stereo rendition is transcoded on demand. Audio is selected per session and switched per track; nothing audio is stored.
- Subtitles: text tracks as WebVTT renditions, converted on demand.

## Stored Versions

Pendia owns pre-transcoding. A store job runs the transcode pipeline with a persist flag and writes the output into the Pendia store path, keyed by Item id, never into the canonical folder. A per-library policy names the rungs to store and the condition, for example a 1080p H.264 8 Mbit/s AAC stereo Version for every Item whose best Version is 4K, HEVC or HDR. Manual per-Item requests exist. Store jobs run on workers at low priority inside an idle window. Files transcoded elsewhere still become Versions when they land in the canonical folder, and join the adaptive group only when aligned.

## Caps and ladder

Global default, per-user override, session request; the lowest wins. Ladder: 20, 10, 6, 3 and 1.5 Mbit/s, resolution following. One live transcode rendition per session.

## Hardware

A startup trial encode per backend fills a capability table: codecs, tone mapping per HDR flavour. Preference order QSV, VAAPI, NVENC, Vulkan, CPU. The MVP runs on CPU, so the engine's first job is avoiding re-encodes.
