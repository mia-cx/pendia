---
status: accepted
date: 2026-09-08
---

# oRPC for the first-party API

Pendia needs one API that serves the SvelteKit client, future native apps, plugins and scripts. oRPC defines each procedure once with an Effect Schema, and exposes it twice: as an RPC endpoint the SvelteKit client calls with end-to-end types, and as OpenAPI REST endpoints everyone else calls, with the OpenAPI document generated. Realtime goes over server-sent events; WebSockets exist only for the Jellyfin translation layer.

## Considered options

- Effect HttpApi: REST, OpenAPI and a typed client from one definition, but no RPC link and Effect at the client boundary.
- tRPC: no OpenAPI, so every non-TypeScript consumer is on its own.
- GraphQL: more general than the two shapes, card and detail, the clients need.
