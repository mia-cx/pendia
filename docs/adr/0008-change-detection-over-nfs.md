---
status: accepted
date: 2026-09-07
---

# Change detection over NFS

Media lives on an NFS export, and an NFS client only sees its own writes: inotify and fanotify report local operations only, and the Linux NFS server on kernel 6.12 sends no directory notifications. Pendia therefore treats arr webhooks as the primary change signal. Sonarr and Radarr are the only writers into the share, they fire after the import copy completes, and the payload names the absolute path, the previous path on a rename, and the provider ids. An optional watcher role runs next to the disks: it watches with inotify there and runs walks and probes on local disk, reporting paths relative to the library root so mount points may differ. A directory-mtime walk on startup and nightly repairs anything missed. There is no content hashing: at 20 TiB over NFS it would take days.

## Considered options

- Polling from a worker over NFS as the primary signal. The attribute cache gives a 30 to 60 s blind window and every stat is a network round trip.
- Hashing for move detection. Rejected for cost; arr rename events and a size, mtime and duration match cover moves.
