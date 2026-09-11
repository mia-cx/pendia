# Transcode pipeline

How a transcoder role runs ffmpeg for live sessions and for store jobs. Playback decisions are in [playback.md](./playback.md).

## Two profiles

- Live: a fast preset tuned for start time. Output is discarded when the session ends.
- Store: a quality preset. Output becomes a Stored Version.

Both force keyframes on the Item's segment timeline and write fMP4: one `init.mp4` and numbered `.m4s` segments.

## Live sessions

- A session starts on the master playlist request and keeps alive on segment requests. After 60 s without a request, ffmpeg stops and the scratch is deleted.
- Scratch is local to the transcoder. ffmpeg writes with `temp_file` and rename; the transcoder emits a ready event per segment, in-process on one node and over Postgres NOTIFY across nodes.
- The media playlist is built from the timeline and complete from the first byte. A request for a segment not yet ready waits for its event up to 20 s, then answers 503.
- Seek is a request for segment N: present in scratch, serve; absent, kill ffmpeg and restart it at the timeline timestamp with `-start_number N`. One ffmpeg per session.
- Admission: a per-transcoder cap on concurrent ffmpeg processes, 2 on a 12 vCPU node. Sessions beyond it queue and the session state says queued.

## Across roles

A session registry in Postgres maps a session to its transcoder. On one node the api serves scratch directly. Across nodes the api proxies segment requests to the owning transcoder. A shared scratch volume is the alternative, decided in scale-out.

## Store jobs

- A Stored Version has no File rows. Its folder, rung and complete flag live on the Version, and the manifest lists the segments.
- Run on workers at low priority inside the idle window, per the library policy or a manual request.
- Write to `<source file>.pendia/<rung>/` next to the source: `init.mp4`, `n.m4s`, and `manifest.json` with the timeline id, the rung and a complete flag written last.
- Resume by skipping segments already present. A folder whose rung the policy no longer wants is deleted. Deleting the source deletes its derived folder.
- Only a complete rung is offered as a Stored Version.

## Startup trial

Each transcoder runs a 2 s trial encode per backend at startup and records a capability table per node: codecs, and tone mapping per HDR flavour.
