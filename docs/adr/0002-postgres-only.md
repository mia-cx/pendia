---
status: accepted
date: 2026-09-07
---

# Postgres only

Single-node Docker is a must and Kubernetes scale-out is first-order. SQLite would make the single-node stack simpler, but scale-out needs a shared writer, and two database backends leak dialect differences everywhere. Pendia requires Postgres: CloudNativePG on Kubernetes, one container in the compose stack.

## Consequences

The job queue and search also live in Postgres for v1, so the single-node stack is two containers. A dedicated queue or search engine is added only when measured.
