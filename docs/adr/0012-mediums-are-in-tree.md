---
status: accepted
date: 2026-09-10
---

# Mediums are in-tree modules

Pendia has a plugin system, so the obvious move is to make each medium a plugin. It does not. A medium contributes database tables, scan rules, client routes and a translation layer, which is far more than the JSON-serialisable plugin boundary carries, and the contract is still moving: live TV and self-hosted channels do not fit the current interface. Mediums stay in-tree, behind one `Medium` interface, until that interface has survived enough mediums to freeze.

## Consequences

Adding a medium means a Pendia release. Plugins extend mediums that exist, through providers and shelves.
