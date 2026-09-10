---
status: accepted
date: 2026-09-10
---

# Plugins receive a host object

A plugin could import Pendia's modules directly, as Jellyfin plugins do with the server assembly. Pendia injects instead: a plugin calls `definePlugin(host => ...)` and reaches the server only through the object it is handed. Pendia builds that object per plugin from the capabilities the manifest declares and the admin approves, so a plugin without the `files` capability has no `host.files` to call. Everything across the boundary is JSON-serialisable and every call returns a plain Promise.

The serialisable rule is what makes ADR 0005's sandbox-readiness real: moving plugins into a subprocess later becomes a change of transport behind the same object. It also keeps Effect, which the host uses internally, out of plugin code.

## Consequences

A plugin cannot hold a file handle or a stream. It asks Pendia to act on a path, so operations that need bulk data, such as video processing, must be added to the host rather than done inside a plugin.
