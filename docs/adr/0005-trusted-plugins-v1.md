---
status: accepted
date: 2026-09-07
---

# Trusted plugins for v1, sandbox-ready interface

Plugins run trusted and in-process for v1, like Jellyfin and Plex plugins today. The host interface is the only door: plugins never import core internals and declare the capabilities they use in their manifest. That keeps a later sandbox, a worker or subprocess per plugin, a host-side change that needs no plugin rewrite.
