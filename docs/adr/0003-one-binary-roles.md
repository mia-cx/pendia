---
status: accepted
date: 2026-09-07
---

# One binary, many roles

One image and one binary run every role: `--role api|worker|transcoder|watcher|all`. Docker runs `all`. Kubernetes scales each role on its own and pins transcoders to GPU nodes. The watcher role exists because media lives on NFS, where inotify cannot see remote writes: it runs next to the disks and pushes change events to the api.

## Consequences

Roles share one codebase and one config. Segment storage and session routing between api and transcoder are decided on the map, not here.
