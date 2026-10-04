# Operating Pendia

How to run, configure, probe and upgrade Pendia. The [README](../README.md) has the quick start. The [server README](../apps/server/README.md) goes deeper into each part.

## Roles

One binary runs every role, chosen with `--role`. The image runs `all` unless you pass another.

| Role | Runs | Needs |
| --- | --- | --- |
| `all` | Every role below except `watcher`, in one process. | Postgres |
| `api` | The web app, the API, auth, the Jellyfin layer, webhooks and the watcher routes on `PENDIA_PORT`. Applies migrations at startup. | Postgres |
| `worker` | Jobs: scans, probes, provider fetches, store encodes and plugin jobs. | A migrated Postgres |
| `transcoder` | The startup trial, then live HLS sessions on `PENDIA_TRANSCODER_PORT`. | A migrated Postgres, local scratch disk |
| `watcher` | File changes and scans for media on its own disks, pushed to the api. | The api's URL and an API key |

Start an `api` or `all` process first: it applies migrations under a Postgres advisory lock, so replicas wait for each other. The api, worker and transcoder read media at each library's root path, so mount the shares at the same path in each. The watcher runs on the storage host, next to the disks; [compose.watcher.yaml](../compose.watcher.yaml) is an example.

## Environment

Environment variables only bootstrap a process. Everything else lives in Postgres and is edited in the admin UI.

| Variable | Roles | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | all but `watcher` | required | The Postgres URL. |
| `PENDIA_PORT` | `api`, `all` | `3000` | The api's HTTP port. |
| `PENDIA_WEB_ROOT` | `api`, `all` | `/app/web` in the image | The built web app. |
| `PENDIA_TRANSCODER_PORT` | `transcoder`, `all` | `3001` | The transcoder's HTTP port. |
| `PENDIA_TRANSCODER_URL` | `transcoder`, `all` | `http://127.0.0.1:<port>` | The address other api processes reach this transcoder at. Set it when they run on other hosts. |
| `PENDIA_SCRATCH_DIR` | `transcoder`, `all` | `pendia-scratch` in the OS temp folder | Live session scratch. Use local disk, never NFS. |
| `PENDIA_TRANSCODE_SLOTS` | `transcoder`, `all` | `2` | Live sessions that re-encode video at once. Later ones queue. |
| `PENDIA_ARTWORK_STORE` | `api`, `worker`, `all` | `colocated` | Where artwork originals live: `colocated`, `path` or `s3`. See [Artwork store](#artwork-store). |
| `PENDIA_ARTWORK_PATH` | `api`, `worker`, `all` | none | An absolute folder for artwork. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` | `api`, `worker`, `all` | none | The bucket for `s3`. The `AWS_` names work too. |
| `PENDIA_PLUGIN_DIR` | `api`, `worker`, `all` | `pendia-plugins` in the OS temp folder | Where plugins install. Use local disk. |
| `PENDIA_NPM_REGISTRY` | `api`, `worker`, `all` | `https://registry.npmjs.org` | Where npm plugin specs resolve. |
| `PENDIA_API_URL` | `watcher` | required | The api's origin, such as `http://pendia.lan:3000`. |
| `PENDIA_WATCHER_TOKEN` | `watcher` | required | An API key whose owner has `manage-libraries`. |
| `PENDIA_WATCH` | `watcher` | required | `<library-id>=<absolute path>` pairs, separated by commas. |

The compose files read three more. They configure Docker, not Pendia.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PENDIA_VERSION` | `latest` | The image tag, such as `1.2.3`. |
| `PENDIA_HOST_PORT` | `3000` | The host port for the api. |
| `PENDIA_MEDIA` | `./media`; `/srv/media` for the watcher | The media folder, mounted at `/media`. |

### Artwork store

Pendia keeps artwork originals in one store, chosen once at setup. Moving existing artwork to another store is unsupported.

| `PENDIA_ARTWORK_STORE` | Originals live in | Also set |
| --- | --- | --- |
| `colocated` (default) | each Item's `.pendia/artwork` folder | `PENDIA_ARTWORK_PATH` to fall back to when Pendia cannot write to the media folder |
| `path` | `PENDIA_ARTWORK_PATH` | `PENDIA_ARTWORK_PATH`, an absolute path |
| `s3` | an S3-compatible bucket | `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, plus `S3_ENDPOINT` and `S3_REGION` as the server needs |

Every role that serves the API or runs jobs reads the same settings and refuses to start when they are invalid. `compose.yaml` keeps the default and falls back to the `pendia-data` volume.

## Health

The api and the transcoder each answer two probes on their own port. A worker and a watcher serve no HTTP.

- `/healthz` answers 200 while the process runs.
- `/readyz` answers 200 `{"status":"ready"}` when the process can take traffic, and 503 with the reason otherwise. The api is ready when Postgres answers. A transcoder is ready when its startup trial finished and Postgres answers; it says `starting` before that and `stopping` while it drains.

The api opens its port only after migrations finish and, in `all`, after the transcoder trial. Until then neither probe answers, which every orchestrator counts as a failure. In Kubernetes, give the api a startup probe long enough for the first migration. The compose healthcheck gives startup 30 seconds before failures count.

## Logs

Every log line is one JSON object, on stdout or stderr. Filter on `level`, not the stream.

| Field | On | Meaning |
| --- | --- | --- |
| `level` | every line | `info`, `warn` or `error` |
| `message` | every line | A dotted event name, such as `database.migrated` or `jobs.error` |
| `role` | most lines | The role that wrote the line |
| `error` | errors | The error message |
| `plugin` | plugin lines | The plugin's name |
| `timestamp` | `database.migrated`, `role.started`, `api.listening`, `transcoder.listening`, `server.stopping` and plugin lines | ISO 8601 in UTC |

Other fields belong to the event, such as `port` on `api.listening` or `backends` on `transcoder.trial`. A clean start logs `database.migrated`, then `role.started` per role. A failed start logs `server.failed` and exits with code 1. For a time on every line, ask the runtime: `docker compose logs --timestamps`.

## Releases

A release is a `vX.Y.Z` tag on `main`. Pushing it runs CI: the checks, the image build, then the publish job. That job pushes `ghcr.io/mia-cx/pendia` as `X.Y.Z`, `X.Y` and `latest`. A pre-release tag such as `v1.0.0-rc.1` publishes only its own version. Every CI run prints the image size in its summary.

The image is private. Log in before you pull, with a GitHub token that has `read:packages`:

```sh
docker login ghcr.io
```

To upgrade, pull and restart. The api applies new migrations as it starts.

```sh
docker compose pull
docker compose up -d
```

Set `PENDIA_VERSION` to stay on one release.
