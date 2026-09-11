# Topology and operations

What the single-node design must not preclude, and how one binary runs on one box or many.

## Roles

One binary, `--role api|worker|transcoder|watcher|all`. `all` is one process running every role in one event loop, with ffmpeg as its subprocesses. Kubernetes runs one Deployment per role. The watcher runs outside the cluster, next to the disks.

## Across processes

- A session registry in Postgres maps a live session to its transcoder. The segment route carries the session id, and an api proxies to the owner when it is not the owner itself. On one node the api serves scratch directly.
- Live scratch is local disk, never NFS, and is deleted at session end.
- Every event that crosses processes, segment ready, library changed, session state, job progress, goes over Postgres LISTEN and NOTIFY. Each api pushes to the SSE clients it holds. No broker.
- The transcoder capability table is per node, from the startup trial.

## Storage

- Media: the library shares, read by every role. Stored Versions live next to their source in `.pendia` folders, see [transcoding.md](./transcoding.md).
- Artwork store: originals fetched from providers live in one of three configurable backends: colocated in the Item's `.pendia` folder, which is the default; a configured path; or S3-compatible object storage. Resized copies are a local per-process cache and are recomputable.
- Postgres: everything else, including settings, the plugin lockfile, the session registry and the job queue.

## Jobs

One jobs table on Postgres, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. Columns: type, payload, priority, attempts, max attempts, run after, concurrency key, state, error. Workers are woken by NOTIFY and poll on a slow interval as the fallback. The concurrency key caps parallel probes per library over NFS. Run after implements the idle window for store jobs. A failed job retries with backoff and stops at max attempts with its error kept. Job types in the MVP: scan, probe, provider fetch, store, plugin job.

## Config

Environment variables bootstrap a process: the database URL, the role, the port, the scratch directory, and for a watcher the api URL and its token. Everything else lives in Postgres and is edited in the admin UI, applied without a restart wherever the setting allows.

## Plugins across processes

Installed plugins are a lockfile in Postgres: name, version, source, integrity. Every process installs from it into a local folder at startup and imports a plugin on first use. Installing a plugin writes the lockfile and notifies running processes, which install the addition.

## Observability

Structured JSON logs on stdout, tagged with role and request id. `/healthz` for liveness. `/readyz` for readiness: Postgres reachable, and for a transcoder the startup trial finished. No metrics endpoint in the MVP.

## Migrations

One Drizzle migration set covers the core and every in-tree medium. The api role applies it at startup under a Postgres advisory lock, so replicas do not race.
