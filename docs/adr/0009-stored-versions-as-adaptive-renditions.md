---
status: accepted
date: 2026-09-08
---

# Stored Versions as adaptive renditions

Mia has more storage than compute, and a homelab without a transcoding GPU. Jellyfin transcodes live for every mismatch, one rendition per session. Pendia instead lists an Item's stored Versions as the variant streams of one HLS master playlist and lets the client switch between them; each variant's segments are a remux. A live transcode is the fallback when no stored Version passes. To make switching seamless, every Item has one segment timeline, derived from its first Version and forced on every Version Pendia produces, and Pendia owns pre-transcoding so that alignment is guaranteed. Audio is not stored: tracks are selected per session and a stereo fallback is transcoded on demand, because audio is cheap and a client's output does not change mid-session.

## Considered options

- Live multi-rendition transcoding: ruled out by compute.
- Tdarr-only generation of stored Versions: kept as an input, but its outputs join the adaptive group only when aligned, since Tdarr cannot read the segment timeline.
