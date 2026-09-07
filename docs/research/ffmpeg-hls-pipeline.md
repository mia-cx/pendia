---
ticket: https://github.com/mia-cx/pendia/issues/4
date: 2026-09-07
ffmpeg: 7.1.5-0+deb13u1 (Debian 13), measured on a Ryzen 9 7950X, 24 threads, no GPU
sources: ffmpeg 7.1.1 docs and source, jellyfin v10.11.11, ErsatzTV 5bb3ddf, RFC 8216, Apple HLS authoring spec, hls.js
---

# Driving ffmpeg 7.x for on-demand HLS

## Summary

1. Write the media playlist yourself. Do not serve ffmpeg's own `.m3u8` for on-demand playback; a synthetic playlist is ready before ffmpeg has produced a byte.
2. On remux, the source GOP decides segment length. `-hls_time 6` on a 10-second GOP gave 10-second segments in every case measured here.
3. On transcode, force keyframes at the segment period and cap the GOP, then the playlist math is exact.
4. Measured time to the first 6-second segment: 0.08 s remux, 1.06 s for a 1080p CPU transcode. At 2-second segments the transcode drops to 0.64 s.
5. A segment file is incomplete while ffmpeg writes it. Serve it once the next one exists, or set `-hls_flags temp_file` and serve on rename.
6. Seek restarts ffmpeg with input `-ss` at the segment boundary plus `-start_number`. Seeking to 150 s cost 1.51 s to first segment, not 1.06 s.
7. MPEG-TS carried 2.67% more bytes than fMP4 for the same remux. fMP4 needs `EXT-X-VERSION:7`, TS runs at version 3.
8. Apple asks for a 6-second target duration and an IDR every 2 seconds. hls.js needs Media Source Extensions and transmuxes TS itself.
9. `-hls_init_time` is a no-op when `-hls_list_size` is 0, so it cannot shorten the first segment of a VOD playlist.
10. Stock ffmpeg 7.1 tone maps with `tonemap_vaapi`, `vpp_qsv=tonemap=1`, `tonemap_opencl` and `libplacebo`. There is no `tonemap_cuda`.
11. NVENC and QSV honour `-force_key_frames` only with `-forced-idr` / `-forced_idr` set.
12. ErsatzTV runs one ffmpeg per playout item, appends with `append_list`, and stitches items with `EXT-X-DISCONTINUITY`.

## The playlist is yours, not ffmpeg's

Jellyfin never serves the `.m3u8` that ffmpeg writes for on-demand video. `GetVariantPlaylistInternal` calls `DynamicHlsPlaylistGenerator.CreateMainPlaylist`, which computes segment boundaries and emits a complete `VOD` playlist with `#EXT-X-ENDLIST` before any transcode starts. Source: [DynamicHlsController.cs L1408](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1408) and [DynamicHlsPlaylistGenerator.cs L34](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L34).

Two boundary strategies live in that generator.

- Transcode: equal-length segments from the runtime, because ffmpeg will be told to put a keyframe there. `ComputeEqualLengthSegments` at [L183](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L183).
- Remux: real keyframe positions read from the file, because the muxer can only cut where the source already has a keyframe. `ComputeSegments` at [L155](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L155), gated on `IsRemuxingVideo` at [L38](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L38).

Each segment URL carries `runtimeTicks` and `actualSegmentLengthTicks` as query parameters ([L84-L99](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L84)). The server then knows the exact start time of a requested segment without recomputing it. That is the piece that makes seek cheap.

The playlist version depends on the container: `7` for fMP4, `3` for MPEG-TS ([L53](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L53)). RFC 8216 section 7 requires version 6 or greater for `EXT-X-MAP` in a playlist without `EXT-X-I-FRAMES-ONLY`; the ffmpeg docs say fMP4 "may be used in HLS version 7 and above". Sources: [RFC 8216 section 7](https://datatracker.ietf.org/doc/html/rfc8216#section-7), [ffmpeg hls muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2).

## Segment duration, and what the muxer actually does

The muxer cuts on the next keyframe after `hls_time` has passed. The docs are explicit: "Segment will be cut on the next key frame after this time has passed" ([ffmpeg hls muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2)). Same page: "Make sure to require a closed GOP when encoding and to set the GOP size to fit your segment time constraint."

Measured here on a 300 s 1080p25 file with a fixed 10-second GOP, remuxed with `-hls_time 6`:

| container | segments | EXTINF | TARGETDURATION | EXT-X-VERSION | total bytes |
| --- | --- | --- | --- | --- | --- |
| fMP4 | 30 | 10.000 s each | 10 | 7 | 230,238,175 plus a 1,315-byte init |
| MPEG-TS | 30 | 10.000 s each | 10 | 3 | 236,384,248 |

Source file: 230,244,886 bytes. MPEG-TS carries 6,146,073 bytes more than fMP4, which is 2.67%. That is the 188-byte packet framing and the PAT/PMT repetition.

Two consequences for the decision engine.

- Asking for a 6-second segment on remux does not produce a 6-second segment. Read the keyframe index, or accept whatever the GOP gives.
- `EXT-X-TARGETDURATION` follows the longest segment. RFC 8216 section 4.3.3.1: "The EXTINF duration of each Media Segment in the Playlist file, when rounded to the nearest integer, MUST be less than or equal to the target duration." Source: [RFC 8216 section 4.3.3.1](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.3.1).

### What the clients need

Apple's HLS authoring specification, quoting clause numbers:

- 7.5: "Target durations SHOULD be 6 seconds."
- 7.6: "Segment durations SHOULD be nominally 6 seconds (for example, NTSC 29.97 may be 6.006 seconds)."
- 7.7: "Media Segments MUST NOT exceed the target duration by more than 0.5 seconds."
- 7.4: "Video segments MUST start with an IDR frame."
- 1.13: "Key frames (IDRs) SHOULD be present every two seconds."
- 1.2: "The container format for H.264 video MUST be fragmented MP4 (fMP4) files or MPEG transport streams."
- 1.5: "The container format for HEVC video MUST be fMP4."
- 1.39: "The container format for AV1 video MUST be fMP4."
- 2.3: "Stereo audio in AAC, HE-AAC v1, or HE-AAC v2 format MUST be provided."

Source: [HLS authoring specification for Apple devices](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices).

So HEVC and AV1 force fMP4. H.264 can go either way, and TS is the only option below `EXT-X-VERSION:6`.

hls.js is the other constraint. It "is only compatible with browsers supporting MediaSource extensions (MSE) API with 'video/MP4' mime-type inputs", and it transmuxes "MPEG-2 Transport Stream and AAC/MP3 streams into ISO BMFF (MP4) fragments" in a Web Worker. Serving TS to hls.js therefore adds a transmux step on the client that fMP4 skips. On Apple platforms "Safari browsers (iOS, iPadOS, and macOS) have built-in HLS support through the plain video tag source URL", so those clients take the native path and the Apple rules above apply directly. Source: [hls.js README](https://github.com/video-dev/hls.js/blob/master/README.md).

Recommendation: fMP4 by default, MPEG-TS only as a fallback for clients that reject version 7.

### Segment duration against start time

Shorter segments start faster and cost more requests. Measured, 1080p25 to H.264 with libx264 veryfast:

| configuration | first segment on disk | ready to serve |
| --- | --- | --- |
| `-hls_time 6` | 1.06 s | 1.33 s |
| `-hls_time 2` | 0.64 s | 0.72 s |

"Ready to serve" is the moment the next segment file also exists, which is Jellyfin's readiness rule (below). At 2-second segments a 2-hour film needs 3600 segment requests instead of 1200.

Jellyfin splits the difference by container path: 6 seconds when the video is copied, 3 seconds when it is transcoded ([StreamState.cs L74](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/Streaming/StreamState.cs#L74)).

### hls_init_time does not help a VOD playlist

The obvious trick, a short first segment and long later ones, does not work through the hls muxer. In `hlsenc.c`:

```c
hls->recording_time = hls->init_time && hls->max_nb_segments > 0 ? hls->init_time : hls->time;
```

`max_nb_segments` is `hls_list_size` ([hlsenc.c L3151](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/hlsenc.c#L3151)), and setting `hls_playlist_type` to `vod` or `event` forces it to 0 ([hlsenc.c L1180](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/hlsenc.c#L1180)). Source line: [hlsenc.c L2980](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/hlsenc.c#L2980).

Verified here. With `-hls_time 6 -hls_init_time 2 -hls_playlist_type vod` every `#EXTINF` came out at 6.000000. With `-hls_time 6 -hls_init_time 2 -hls_list_size 20` and no playlist type, the first 20 segments came out at 2.000000 and `EXT-X-TARGETDURATION` dropped to 2. The "init list" is `hls_list_size` segments long, not one segment ([hlsenc.c L2484](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/hlsenc.c#L2484)).

An alternative exists. The segment muxer takes an explicit list of cut points with `segment_times`, "a list of comma separated duration specifications, in increasing order" ([ffmpeg segment muxer docs](https://ffmpeg.org/ffmpeg-formats.html#segment_002c-stream_005fsegment_002c-ssegment)). Tested here with `-f segment -segment_times 1,2,4,8,14,20,26 -segment_format mp4`, ffmpeg produced segments of 1.08, 1.08, 2.08, 4.08, 6.08, 6.08, 6.08 and 4.08 seconds. Each of those segments carries its own `moov`, so there is no shared init segment and no `EXT-X-MAP` to point at. Whether hls.js and AVPlayer accept self-initialising fMP4 segments in an HLS playlist is **unverified**. Treat the ramp as an experiment for the perf prototype, not a v1 design.

## Command skeletons

The hardware skeletons below were not run on this box, which has no GPU. Their shape comes from the ffmpeg documentation and Jellyfin's filter chain builder; the filter names and options are checked against `ffmpeg -filters` and `ffmpeg -h filter=...` on ffmpeg 7.1.5.

### Remux to fMP4 HLS

```bash
ffmpeg -hide_banner -loglevel error \
  -i input.mkv \
  -map 0:v:0 -map 0:a:0 \
  -c copy -copyts -avoid_negative_ts disabled -start_at_zero \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_flags temp_file+independent_segments \
  -hls_segment_filename 'seg%d.m4s' out.m3u8
```

`-copyts -avoid_negative_ts disabled` and `-start_at_zero` are what Jellyfin uses on the copy path so a later seek lands on a known timestamp ([DynamicHlsController.cs L1667](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1667), `-start_at_zero` at [L1886](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1886)).

`independent_segments` is only emitted "when all the segments of that playlist are guaranteed to start with a key frame" ([ffmpeg hls muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2)), which the muxer knows because it only cuts on keyframes.

### Video and audio transcode on CPU

```bash
ffmpeg -hide_banner -loglevel error \
  -i input.mkv \
  -map 0:v:0 -map 0:a:0 \
  -vf 'scale=-2:720:flags=bicubic' \
  -c:v libx264 -preset veryfast -crf 23 -maxrate 4M -bufsize 8M -pix_fmt yuv420p \
  -force_key_frames:0 'expr:gte(t,n_forced*6)' -g 150 -keyint_min 150 -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_flags temp_file+independent_segments \
  -hls_segment_filename 'seg%d.m4s' out.m3u8
```

The keyframe expression and the GOP cap both matter. Jellyfin's comment explains why the expression alone is not enough: "we encoded half of desired length, then codec detected scene cut and inserted a keyframe; next forced keyframe would be created outside of segment, which breaks seeking" ([EncodingHelper.cs L1948-L1975](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L1948)). `-g` and `-keyint_min` are set to `ceil(segmentLength * framerate)`. For libx264 Jellyfin also adds `-sc_threshold:v:0 0` "to prevent the libx264 from post processing to break the set keyframe" ([L2001-L2004](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L2001)).

Jellyfin's default preset is `veryfast` for on-demand and `superfast` for live ([DynamicHlsController.cs L43-L44](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L43)).

### VAAPI

```bash
ffmpeg -hide_banner -loglevel error \
  -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va \
  -hwaccel vaapi -hwaccel_output_format vaapi \
  -i input.mkv \
  -noautoscale -map 0:v:0 -map 0:a:0 \
  -vf 'scale_vaapi=w=1280:h=720:format=nv12:extra_hw_frames=24' \
  -c:v h264_vaapi -rc_mode VBR -b:v 4M -maxrate 4M -bufsize 8M \
  -force_key_frames:0 'expr:gte(t,n_forced*6)' -g 150 -keyint_min 150 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'seg%d.m4s' out.m3u8
```

The VAAPI encoders "only accept input in VAAPI hardware surfaces. If you have input in software frames, use the `hwupload` filter to upload them to the GPU" ([ffmpeg VAAPI encoder docs](https://ffmpeg.org/ffmpeg-codecs.html#VAAPI-encoders)). With `-hwaccel_output_format vaapi` the frames never leave the GPU. `-noautoscale` stops ffmpeg inserting a software scaler behind a hardware decoder; Jellyfin adds it whenever a hardware decoder is in use ([EncodingHelper.cs L1323-L1328](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L1323)).

Jellyfin puts `h264_vaapi`, `hevc_vaapi` and `av1_vaapi` in the `-force_key_frames` branch, so forced keyframes are considered reliable on VAAPI ([EncodingHelper.cs L1992-L1998](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L1992)).

### QSV

```bash
ffmpeg -hide_banner -loglevel error \
  -init_hw_device qsv=hw,child_device=/dev/dri/renderD128 -filter_hw_device hw \
  -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv \
  -i input.mkv \
  -noautoscale -map 0:v:0 -map 0:a:0 \
  -vf 'vpp_qsv=w=1280:h=720:format=nv12:async_depth=2' \
  -c:v h264_qsv -preset veryfast -b:v 4M -maxrate 4M -bufsize 8M \
  -forced_idr 1 -force_key_frames:0 'expr:gte(t,n_forced*6)' -g 150 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'seg%d.m4s' out.m3u8
```

`-hwaccel qsv` "does not enable accelerated decoding (that is used automatically whenever a qsv decoder is selected), but accelerated transcoding, without copying the frames into the system memory", and "both the decoder and the encoder must support QSV acceleration" ([ffmpeg CLI docs, -hwaccel](https://ffmpeg.org/ffmpeg.html#toc-Advanced-Video-options)). So name the `_qsv` decoder explicitly with `-c:v`.

This build is configured `--disable-libmfx --enable-libvpl`, so QSV runs through oneVPL rather than the old Media SDK.

### NVENC

```bash
ffmpeg -hide_banner -loglevel error \
  -init_hw_device cuda=cu:0 -filter_hw_device cu \
  -hwaccel cuda -hwaccel_output_format cuda \
  -i input.mkv \
  -noautoscale -map 0:v:0 -map 0:a:0 \
  -vf 'scale_cuda=1280:720:format=yuv420p' \
  -c:v h264_nvenc -preset p4 -tune hq -rc vbr -b:v 4M -maxrate 4M -bufsize 8M \
  -forced-idr 1 -force_key_frames:0 'expr:gte(t,n_forced*6)' -g 150 -no-scenecut 1 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'seg%d.m4s' out.m3u8
```

`-forced-idr` is documented as "If forcing keyframes, force them as IDR frames" and `-no-scenecut` as "When lookahead is enabled, set this to 1 to disable adaptive I-frame insertion at scene cuts" (both from `ffmpeg -h encoder=h264_nvenc` on 7.1.5). `h264_qsv` has the same option spelled `-forced_idr`.

Jellyfin does not use `-force_key_frames` for `h264_qsv`, `h264_nvenc`, `hevc_qsv`, `hevc_nvenc`, `av1_qsv` or `av1_nvenc`; it comments "Unable to force key frames using these encoders, set key frames by GOP" and emits `-g`/`-keyint_min` only ([EncodingHelper.cs L1977-L1991](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L1977)). Given that ffmpeg 7.1 exposes the forced-IDR flags, GOP-only is the conservative choice rather than the only one. Whether forced keyframes land exactly on the segment period on real NVENC and QSV hardware is **unverified**.

### Vulkan

```bash
ffmpeg -hide_banner -loglevel error \
  -init_hw_device vulkan=vk:0 -filter_hw_device vk \
  -hwaccel vulkan -hwaccel_output_format vulkan \
  -i input.mkv \
  -noautoscale -map 0:v:0 -map 0:a:0 \
  -vf 'libplacebo=w=1280:h=720:format=nv12,hwdownload,format=nv12' \
  -c:v libx264 -preset veryfast -crf 23 ...
```

This build has `h264_vulkan` and `hevc_vulkan` encoders and Vulkan hwaccel decode for h264, hevc and av1 (`ffmpeg -h decoder=h264` lists "cuda vaapi vdpau vulkan"). Vulkan encode in ffmpeg 7.1 is new and Jellyfin does not use it; it uses Vulkan only as a filtering device for `libplacebo`, mapped in from VAAPI ([EncodingHelper.cs L5375-L5376](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L5375)). Treat Vulkan encode as **unverified** for v1.

### HDR to SDR tone mapping per backend

Stock ffmpeg 7.1 ships exactly four hardware tone-mapping paths. Checked against `libavfilter/allfilters.c` at n7.1.1: `ff_vf_tonemap`, `ff_vf_tonemap_opencl`, `ff_vf_tonemap_vaapi`, `ff_vf_libplacebo`, `ff_vf_vpp_qsv`. There is no `tonemap_cuda`, no `tonemap_vulkan`, no `tonemap_videotoolbox` and no `tonemapx`. Source: [allfilters.c](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavfilter/allfilters.c#L496). Those four names appear in Jellyfin's code because jellyfin-ffmpeg patches them in; Jellyfin's own docs warn that "Using FFmpeg binaries downloaded from somewhere else will result in partial acceleration" ([Jellyfin hardware acceleration docs](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/)).

**VAAPI.** Scale first, then tone map, which is the order Jellyfin uses ([EncodingHelper.cs L5110-L5117](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L5110)):

```bash
-vf 'scale_vaapi=w=1920:h=1080:format=p010:extra_hw_frames=24,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709:extra_hw_frames=32'
```

`tonemap_vaapi` "currently only accepts HDR10 as input" ([ffmpeg filter docs, tonemap_vaapi](https://ffmpeg.org/ffmpeg-filters.html#tonemap_005fvaapi)). HLG and Dolby Vision profile 5 need a different path. Jellyfin's gate agrees: VPP tone mapping is offered only for HDR10, HDR10+ and Dolby Vision with an HDR10 base layer ([EncodingHelper.cs L397-L423](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L397)).

**QSV.**

```bash
-vf 'vpp_qsv=w=1920:h=1080:tonemap=1:format=nv12:async_depth=2'
```

`vpp_qsv` exposes `tonemap` as "Perform tonemapping (0=disable tonemapping, 1=perform tonemapping if the input has HDR metadata)" (`ffmpeg -h filter=vpp_qsv` on 7.1.5). Jellyfin emits the identical string ([EncodingHelper.cs L4548](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L4548)) but prefers `tonemap_vaapi` on Linux "for supporting Gen9/KBLx", because "`vpp_qsv` requires VPL, which is only supported on Gen12/TGLx and newer" ([EncodingHelper.cs L406-L410](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L406)).

**NVENC.** No CUDA tone-mapping filter exists in stock ffmpeg 7.1. Three fallbacks, in descending order of expected speed:

```bash
# OpenCL interop, unverified on this box
-vf 'hwmap=derive_device=opencl,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390:desat=0,hwmap=derive_device=cuda:reverse=1,format=cuda'

# Vulkan filtering device with libplacebo, unverified on this box
-vf 'hwmap=derive_device=vulkan,libplacebo=format=nv12:tonemapping=bt.2390:peak_detect=0:color_primaries=bt709:color_trc=bt709:colorspace=bt709'

# CPU fallback, always works, costs a full GPU-to-host copy per frame
-vf 'hwdownload,format=p010le,zscale=t=linear:npl=100,tonemap=tonemap=bt2390:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p'
```

The libplacebo option string follows Jellyfin's `GetLibplaceboFilter` ([EncodingHelper.cs L3681-L3735](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L3681)), which writes `bt.2390` for the `bt2390` algorithm and pins `peak_detect=0`. Note that Jellyfin only offers Vulkan tone mapping for 10-bit HDR, and calls Dolby Vision support "partial" ([EncodingHelper.cs L384-L395](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L384)).

**Dolby Vision.** Jellyfin only tone maps DOVI when the decoder can parse the RPU, which limits it to the software decoder, NVDEC, VAAPI, D3D11VA and VideoToolbox ([EncodingHelper.cs L349-L378](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L349)). QSV is absent from that list.

### Audio-only transcode

```bash
ffmpeg -hide_banner -loglevel error \
  -ss 150 -i input.mkv \
  -vn -map 0:a:0 -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -start_number 25 -hls_segment_filename 'seg%d.m4s' out.m3u8
```

Jellyfin adds `-vn` on the audio-only path and copies the codec when the client already accepts it ([DynamicHlsController.cs L1716](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1716)). Measured here: AAC re-encode of one stereo track ran at 162x realtime, and the first segment appeared in 0.10 s. Opus, DTS, TrueHD and FLAC need `-strict -2` in the mp4 muxer on older ffmpeg; Jellyfin drops the FLAC case from ffmpeg 6.0 onward ([DynamicHlsController.cs L47](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L47), used at [L1708](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1708)).

### Subtitles: extract or burn in

Extraction is nearly free and keeps the video on the copy path. Burn-in forces a full re-encode.

Text subtitle to WebVTT, then reference it as an HLS rendition:

```bash
ffmpeg -hide_banner -loglevel error -i input.mkv -map 0:s:0 -c:s webvtt -f webvtt subs.vtt
```

Measured: 0.095 s wall, 0.06 s user, for a SubRip track in a 20-second file. Cost scales with the subtitle track, not the video.

The rendition line Jellyfin writes into the master playlist:

```
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="{0}",DEFAULT={1},FORCED={2},AUTOSELECT=YES,URI="{3}",LANGUAGE="{4}"
```

Source: [DynamicHlsHelper.cs L604](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/DynamicHlsHelper.cs#L604).

Burn-in for text subtitles:

```bash
-vf "subtitles=f='/path/to/subs.ass'"
```

Jellyfin builds the same filter, adding `charenc` for external files with a known language and `alpha`, `sub2video` and `fontsdir` where needed ([EncodingHelper.cs L1898-L1921](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L1898)).

Burn-in for graphical subtitles (PGS, VOBSUB, DVBSUB) goes through an overlay:

```bash
-filter_complex "[0:v:0][0:s:0]overlay=eof_action=pass:repeatlast=0"
```

Jellyfin uses exactly `overlay=eof_action=pass:repeatlast=0` on every backend ([EncodingHelper.cs L3873](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L3873)). For external graphical subtitles it feeds an `alphasrc` canvas so the overlay has a timebase ([EncodingHelper.cs L3365](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L3365)).

Two decision rules worth copying:

- Stream copy and burn-in are mutually exclusive. Jellyfin: "Can't stream copy if we're burning in subtitles" ([EncodingHelper.cs L2362-L2365](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L2362)).
- DVBSUB cannot be remuxed usefully. Jellyfin forces it to burn-in: "This is tricky to remux in, after converting to dvdsub it's not positioned correctly" ([EncodingHelper.cs L7515-L7527](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L7515)).

Measured cost of burn-in, 120 s of 1080p25 to H.264 veryfast on 24 threads: 5.82 s without subtitles (20.6x realtime), 6.09 s with an ASS overlay (19.7x realtime). The filter itself costs about 4%. The real cost is that the same content remuxes at roughly 1100x realtime, so burn-in is a 55x throughput drop compared to copying.

## Starting playback before the first segment finishes

Jellyfin's on-demand start has three moves.

**One.** Serve a synthetic playlist immediately. `CreateMainPlaylist` needs the runtime and the segment length, both of which come from the library database, so the response does not wait on ffmpeg ([DynamicHlsController.cs L1408](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1408)).

**Two.** Start ffmpeg on the first segment request, not on the playlist request. `GetDynamicSegment` looks for the segment file; if it is missing it takes a per-playlist lock and decides whether to spawn ffmpeg ([DynamicHlsController.cs L1448](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1448)). The fMP4 init segment is requested as index `-1` and also triggers the start:

```csharp
if (segmentId == -1)
{
    _logger.LogDebug("Starting transcoding because fmp4 init file is being requested");
    startTranscoding = true;
    segmentId = 0;
}
```

**Three.** Hold the HTTP request until the segment is safe to serve. `GetSegmentResult` polls every 100 ms and applies this rule ([DynamicHlsController.cs L1974-L1998](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1974)):

```csharp
// To be considered ready, the segment file has to exist AND
// either the transcoding job should be done or next segment should also exist
if (segmentExists)
{
    if (transcodingJob.HasExited || System.IO.File.Exists(nextSegmentPath))
```

A short circuit skips the wait entirely: if the requested index is below `GetCurrentTranscodingIndex`, the file cannot still be growing, so it is served at once ([DynamicHlsController.cs L1964-L1971](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1964)). `GetCurrentTranscodingIndex` finds the newest segment file by modification time and parses the index out of the filename ([L2039-L2070](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L2039)).

The live and event path is different and slower. It starts ffmpeg on the playlist request and then blocks on `WaitForMinimumSegmentCount`, which reads ffmpeg's own m3u8 and counts `#EXTINF:` lines, polling with a 100 ms delay and then a further 50 ms ([HlsHelpers.cs L27](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/HlsHelpers.cs#L27), called from [DynamicHlsController.cs L330](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L330)). `MinSegments` defaults to 3, or 2 when segments are 10 seconds or longer ([StreamState.cs L111-L120](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/Streaming/StreamState.cs#L111)).

### What limits Jellyfin's start time

Four things, in order of size.

1. **Two segments, not one.** The readiness rule waits for segment N+1. At 3-second segments that is 6 seconds of encoded video before the first byte reaches the client. Measured here at 6-second segments: 1.06 s to write segment 0, 1.33 s to write segment 1.
2. **Polling granularity.** 100 ms per poll in `GetSegmentResult`, 150 ms per loop in `WaitForMinimumSegmentCount`. On a fast encode this is a meaningful share of the total.
3. **Encoder throughput.** 20.6x realtime for 1080p veryfast on 24 threads here. On a 4-thread NAS the same job runs near or below realtime, and the two-segment rule turns into a multi-second stall.
4. **Input probing.** `-analyzeduration` and `-probesize` are applied on every restart ([EncodingHelper.cs L7195-L7213](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L7195)). Pendia already has stream metadata in the database, so it can set both low.

Point 1 is avoidable. `-hls_flags temp_file` makes ffmpeg "Write segment data to `filename.tmp` and rename to filename only once the segment is complete" ([ffmpeg hls muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2)). With that flag, the appearance of the final filename is itself the readiness signal, and the server can serve segment 0 as soon as it is complete instead of waiting for segment 1. That halves the encoded-video-before-playback figure. An inotify watch on the output directory removes the polling delay in point 2 as well.

## Seek

The client does not ask for a seek. It asks for a segment.

Because the playlist is a full VOD list with every segment enumerated, a seek in the player is just a request for segment `floor(seekSeconds / segmentLength)`. Jellyfin embeds the exact start time in the URL so the server does not need to recompute it: `&runtimeTicks=<start>&actualSegmentLengthTicks=<duration>` ([DynamicHlsPlaylistGenerator.cs L84-L99](https://github.com/jellyfin/jellyfin/blob/v10.11.11/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs#L84)).

The server then decides whether the running ffmpeg can reach that segment or a restart is cheaper ([DynamicHlsController.cs L1498-L1520](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1498)):

```csharp
var segmentGapRequiringTranscodingChange = 24 / state.SegmentLength;

if (segmentId == -1)                                        { startTranscoding = true; segmentId = 0; }
else if (currentTranscodingIndex is null)                   { startTranscoding = true; }
else if (segmentId < currentTranscodingIndex.Value)         { startTranscoding = true; }
else if (segmentId - currentTranscodingIndex.Value > segmentGapRequiringTranscodingChange) { startTranscoding = true; }
```

In words: restart if seeking backwards, restart if seeking more than 24 seconds ahead of the encoder, otherwise let the existing process catch up. On restart it kills the old job, sets `StartTimeTicks` from the segment's `runtimeTicks`, and passes the segment index as `-start_number` ([DynamicHlsController.cs L1526-L1541](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1526)).

The seek itself is an input seek, `-ss` before `-i`, which is what makes it cheap ([EncodingHelper.cs L2953-L2996](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L2953)). Three details from that function:

- On the remux path it adds 0.5 s to the requested time, because "ffmpeg will seek to previous keyframe when the exact time is the input" and the extra offset lands on the intended keyframe on most files.
- It clamps the seek to `[0, runtime - 5 s]` so the muxer still receives packets.
- It adds `-noaccurate_seek` for fMP4 output but not for MPEG-TS, noting fMP4 needs it "otherwise the audio can't be synced to the video".

Measured on this box, 1080p25, seeking to 150 s in a 300 s file, first segment written:

| path | from 0 s | from 150 s |
| --- | --- | --- |
| remux to fMP4 | 0.08 s | 0.07 s |
| libx264 veryfast | 1.06 s | 1.51 s |
| libx264 slow | not measured | 1.41 s |

Input seek costs essentially nothing on a seekable local file. The 0.45 s difference on the transcode path is process start plus decoder priming, not the seek.

### The pre-transcode alternative

The other approach is to transcode the whole file ahead of time and serve static segments. It trades start latency for storage and a first-play wait.

- Start time drops to disk read, so the same 0.08 s as remux.
- Seek becomes free, and every segment is exact.
- Cost: a full encode before first play, plus roughly the size of one rendition per stored variant. A 90-minute film at 4 Mbps is 2.7 GB per rendition.
- Jellyfin does not do this. ErsatzTV does a bounded version of it, transcoding up to one minute ahead of the play position (see below).

The middle ground is a work-ahead buffer: start on demand, but let ffmpeg run faster than realtime until it is N seconds ahead, then throttle. ErsatzTV's numbers are 60 seconds of buffer and a 30-second floor ([HlsSessionWorker.cs L249-L252](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Streaming/HlsSessionWorker.cs#L249)).

## Hardware acceleration matrix for ffmpeg 7.1

Two things get confused here, so they are separated. The first table is what ffmpeg 7.1 has code for. The second is what silicon generation you need. A build can have `av1_vaapi` and still fail on a GPU that cannot encode AV1.

### What ffmpeg 7.1 exposes

Taken from `ffmpeg -hwaccels`, `ffmpeg -encoders`, `ffmpeg -decoders` and `ffmpeg -h decoder=<codec>` on 7.1.5-0+deb13u1, and cross-checked against [allfilters.c at n7.1.1](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavfilter/allfilters.c).

| backend | H.264 | HEVC | AV1 | VP9 | VP8 | tone mapping |
| --- | --- | --- | --- | --- | --- | --- |
| CPU | dec + enc (libx264) | dec + enc (libx265) | dec (libdav1d) + enc (libsvtav1, librav1e, libaom) | dec + enc (libvpx-vp9) | dec + enc (libvpx) | `tonemap` with `zscale` |
| VAAPI | dec + enc | dec + enc | dec + enc | dec + enc | dec + enc | `tonemap_vaapi`, HDR10 input only |
| QSV | dec + enc | dec + enc | dec + enc | dec + enc | dec only | `vpp_qsv=tonemap=1` |
| NVENC / NVDEC | dec + enc | dec + enc | dec + enc | dec only | dec only | none in mainline |
| Vulkan | dec + enc | dec + enc | dec only | none | none | `libplacebo` |
| OpenCL | filtering only | filtering only | filtering only | filtering only | filtering only | `tonemap_opencl` |

Notes on the cells.

- VAAPI decode comes from the native decoders with `-hwaccel vaapi`; `ffmpeg -h decoder=h264` lists "cuda vaapi vdpau vulkan", `-h decoder=vp9` lists "cuda vaapi vdpau", `-h decoder=vp8` lists "vaapi cuda".
- QSV uses standalone decoders: `h264_qsv`, `hevc_qsv`, `av1_qsv`, `vp9_qsv`, `vp8_qsv`, `vvc_qsv`, `mpeg2_qsv`, `vc1_qsv`, `mjpeg_qsv`.
- QSV encoders present: `h264_qsv`, `hevc_qsv`, `av1_qsv`, `vp9_qsv`, `mpeg2_qsv`, `mjpeg_qsv`.
- VAAPI encoders present: `h264_vaapi`, `hevc_vaapi`, `av1_vaapi`, `vp8_vaapi`, `vp9_vaapi`, `mpeg2_vaapi`, `mjpeg_vaapi`.
- NVENC encoders present: `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`. NVDEC via `-hwaccel cuda`, plus the `*_cuvid` decoders.
- Vulkan encoders present: `h264_vulkan`, `hevc_vulkan`. This is new in ffmpeg 7 and **unverified** in practice.
- `scale_npp` exists in mainline but needs the nonfree CUDA SDK, so it is absent from the Debian build. Use `scale_cuda`.
- The "none" for CUDA tone mapping is the important cell. `tonemap_cuda` is a jellyfin-ffmpeg patch, not upstream.

### What the silicon needs

| feature | requirement | source |
| --- | --- | --- |
| NVENC AV1 encode | Ada Lovelace and Blackwell; NO on Ampere, Turing, Volta, Pascal, Maxwell | [NVIDIA support matrix](https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new) |
| NVDEC AV1 decode | Ampere 5th-gen NVDEC, Ada Lovelace, Blackwell; NO on Turing and older | [NVIDIA support matrix](https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new) |
| Intel AV1 decode | TGLx, DG1/SG1, DG2/ATSM, MTLx, LNL, BMG, PTL, NVL | [intel/media-driver README](https://github.com/intel/media-driver/blob/master/README.md) |
| Intel AV1 encode | DG2/ATSM, MTLx, LNL, BMG, PTL, NVL; decode only on TGLx and DG1/SG1 | [intel/media-driver README](https://github.com/intel/media-driver/blob/master/README.md) |
| Intel HEVC 10-bit encode | ICL, EHL/JSL, TGLx, DG1/SG1, DG2/ATSM, MTLx, LNL, BMG, PTL, NVL; KBLx decode only | [intel/media-driver README](https://github.com/intel/media-driver/blob/master/README.md) |
| `vpp_qsv` tone mapping | needs oneVPL, so Gen12/TGLx and newer | [Jellyfin EncodingHelper.cs L406-L410](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L406) |
| AMD VAAPI AV1 encode | RDNA3 and newer | **unverified**, no first-party matrix fetched |

`ffmpeg -hwaccels` is not a capability check: "List all hardware acceleration components enabled in this build of ffmpeg. Actual runtime availability depends on the hardware and its suitable driver being installed" ([ffmpeg CLI docs](https://ffmpeg.org/ffmpeg.html#toc-Advanced-Video-options)). The only reliable probe is a short trial encode at startup, which is what Jellyfin's `SupportsFilter` and `SupportsHwaccel` checks approximate ([EncodingHelper.cs L261-L322](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs#L261)).

## What ErsatzTV does differently

ErsatzTV streams a continuous channel, not a file, so its constraints invert: there is no runtime to divide, and the playlist never ends. Reference commit `5bb3ddf` (2026-09-06).

**One ffmpeg per playout item, appended into one playlist.** Every item gets its own process writing into the same `live.m3u8` with `append_list`, which "Append[s] new segments into the end of old segment list, and remove[s] the `#EXT-X-ENDLIST` from the old segment list" ([ffmpeg hls muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2)). Every process after the first also sets `discont_start` so the join carries an `EXT-X-DISCONTINUITY`:

```
-hls_flags program_date_time+omit_endlist+append_list+discont_start+independent_segments
```

Source: [OutputFormatHls.cs L113-L132](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.FFmpeg/OutputFormat/OutputFormatHls.cs#L113).

**4-second segments with 2-second keyframes.** Constants, not options ([OutputFormatHls.cs L8-L9](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.FFmpeg/OutputFormat/OutputFormatHls.cs#L8)):

```csharp
public const int SegmentSeconds = 4;
public const int KeyframeIntervalSeconds = 2;
```

`-g` is `frameRate * 2` and `-force_key_frames expr:gte(t,n_forced*2)` is set alongside it, so keyframes land twice per segment. That matches Apple clause 1.13 exactly and buys mid-segment seek resolution at the cost of bitrate.

**The playlist is rewritten on every request.** `IptvController.GetLivePlaylist` calls `worker.TrimPlaylist(now - 30 s, ...)`, which parses ffmpeg's playlist, drops segments older than the cutoff, keeps at most 10, renumbers `EXT-X-MEDIA-SEQUENCE` and `EXT-X-DISCONTINUITY-SEQUENCE`, and writes fresh `EXT-X-PROGRAM-DATE-TIME` per segment. Sources: [IptvController.cs L158](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV/Controllers/IptvController.cs#L158), [HlsSessionWorker.cs L128-L135](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Streaming/HlsSessionWorker.cs#L128), [HlsPlaylistFilter.cs L205-L256](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Core/FFmpeg/HlsPlaylistFilter.cs#L205). Same conclusion as Jellyfin, reached from the other end: the server owns the playlist, ffmpeg's output is an intermediate.

**Work-ahead with a throttle.** The session keeps a transcode buffer and switches between faster-than-realtime and `-re` realtime based on it ([HlsSessionWorker.cs L246-L262](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Streaming/HlsSessionWorker.cs#L246)):

```csharp
if (transcodedBuffer <= TimeSpan.FromMinutes(1))
{
    // only use realtime encoding when we're at least 30 seconds ahead
    bool realtime = transcodedBuffer >= TimeSpan.FromSeconds(30);
```

There is also a global `_workAheadCount` capped by configuration, so N channels cannot all sprint at once ([HlsSessionWorker.cs L228 and L844](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Streaming/HlsSessionWorker.cs#L228)). That admission control is the piece Jellyfin lacks and Pendia will need once several transcodes run at once.

**Readiness is a segment count, not a file-existence race.** `WaitForPlaylistSegments` waits for the playlist file to exist, then polls `TrimPlaylist` every 200 ms until the trimmed playlist has at least `max(1, initialSegmentCount)` segments; the configured default is 1 ([HlsSessionWorker.cs L303-L345](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Streaming/HlsSessionWorker.cs#L303), default at [GetTroubleshootingInfoHandler.cs L272](https://github.com/ErsatzTV/ErsatzTV/blob/5bb3ddfcc4b73b0491a733d6f0c476a248eb1c99/ErsatzTV.Application/Troubleshooting/Queries/GetTroubleshootingInfoHandler.cs#L272)). One segment, because a segment that appears in ffmpeg's own playlist is already closed.

That last point is the cleanest readiness signal of the three approaches seen here: ffmpeg only writes a segment into its m3u8 once it is finished, so the playlist is the completion notification. It costs a file read per poll rather than a stat.

## Measurements

All on ffmpeg 7.1.5-0+deb13u1, AMD Ryzen 9 7950X, 24 threads, tmpfs-backed `/tmp`, no GPU. Source: 300 s of `testsrc2` at 1920x1080p25, H.264 at 6 Mbps with a fixed 10-second GOP, plus 48 kHz AAC.

Time from process launch to the first segment file appearing, and to the following segment appearing:

| configuration | first | next |
| --- | --- | --- |
| remux to fMP4, `-hls_time 6` | 0.08 s | 0.10 s |
| remux to MPEG-TS, `-hls_time 6` | 0.08 s | 0.08 s |
| remux to fMP4, seek to 150 s | 0.07 s | 0.08 s |
| libx264 veryfast 1080p, `-hls_time 6` | 1.06 s | 1.33 s |
| libx264 veryfast 1080p, `-hls_time 2` | 0.64 s | 0.72 s |
| libx264 veryfast 720p downscale, `-hls_time 6` | 0.34 s | 0.51 s |
| libx264 veryfast 1080p with ASS burn-in | 0.81 s | 1.09 s |
| libx264 veryfast 1080p, seek to 150 s | 1.51 s | 1.76 s |
| libx264 slow 1080p, seek to 150 s | 1.41 s | 2.09 s |
| AAC audio only | 0.10 s | 0.15 s |

Sustained throughput over 120 s of input:

| job | wall | speed |
| --- | --- | --- |
| `-c copy` remux | 0.11 s | ~1100x realtime |
| AAC audio only | 0.74 s | 162x realtime |
| libx264 veryfast 1080p + AAC | 5.82 s | 20.6x realtime |
| same with ASS burn-in | 6.09 s | 19.7x realtime |
| WebVTT extraction from SubRip | 0.095 s | not rate-bound |

Read these as ratios, not absolutes. A 4-thread NAS will not hit 20x realtime on 1080p veryfast, and the two-segment readiness rule scales directly with that number.

## Questions this raises

**For the playback decision engine (#8).**

1. Does the engine pick segment duration, or is it fixed? The evidence says it has to be a per-decision output: 6 s for remux to satisfy Apple clause 7.5, 2 to 3 s for transcode to halve start time, and on remux it is not a choice at all because the source GOP wins.
2. Does the engine get to see the keyframe index? Exact `EXTINF` on the remux path needs one. Extracting it costs a full-file scan on first play unless it is cached at scan time.
3. What is the fallback when tone mapping is unavailable for the input? `tonemap_vaapi` refuses anything but HDR10, there is no CUDA path in stock ffmpeg, and QSV needs Gen12. The engine needs a per-backend, per-HDR-flavour capability table, not a single "can tone map" boolean.
4. Is MPEG-TS ever chosen? If the answer is "only for clients that reject `EXT-X-VERSION:7`", say so, and the pipeline gets one container instead of two.

**For the transcode pipeline (#9).**

5. Readiness signal: `temp_file` plus a rename watch, or ffmpeg's own m3u8 like ErsatzTV? Both beat Jellyfin's next-segment-exists rule, which spends a whole extra segment of encode time before the first byte ships.
6. Is there a work-ahead budget and an admission cap? ErsatzTV has both. Without them, three simultaneous 4K transcodes make every session miss its deadline.
7. Which ffmpeg do we ship? Jellyfin's tone-mapping quality depends on patched filters that mainline does not have. Shipping stock ffmpeg means the NVENC HDR path goes through OpenCL, Vulkan or the CPU, and all three need measuring on real hardware.
8. Do we validate hardware at startup with a trial encode? `-hwaccels` lists build support, not runtime support, and a failing hardware path at play time is a worse failure than a slower software one.
