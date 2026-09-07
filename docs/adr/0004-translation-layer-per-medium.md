---
status: accepted
date: 2026-09-07
---

# A translation layer per medium

Pendia has its own API and its own client. Existing apps keep working through translation layers, one per medium, speaking the protocol its best apps already use: the Jellyfin API for video, OpenSubsonic for music, OPDS for ebooks, HDHomeRun for live TV. A translation layer is an adapter over the own API and never the primary model, so Jellyfin's item shape does not leak into the core.

## Considered options

- Jellyfin-API compatible server only: every client on day one, but Jellyfin's DTOs would shape the core and the UX would stay Jellyfin's.
- Own API only: clean, but no TV, phone or car client until Pendia ships its own.
