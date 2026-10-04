# Pendia

A self-hosted media server, written from scratch to be fast where Jellyfin is slow: scanning, browsing, playback start and startup.

One image, one binary. Movies, series, music, photos, ebooks, audiobooks, live TV and channels, each with a browser built for that medium. Plugins are TypeScript. The apps you already use keep working through translation layers: the Jellyfin API for video, OpenSubsonic for music, OPDS for ebooks.

## Status

Planning. The architecture is decided ticket by ticket on the [Pendia v1 map](https://github.com/mia-cx/pendia/issues?q=label%3Awayfinder%3Amap). The glossary is [CONTEXT.md](./CONTEXT.md), decisions live in [docs/adr](./docs/adr).

## License

[MCX](./LICENSE): MPL 2.0 with network use counted as distribution.

## Layout

A Bun workspace with Turborepo. `apps/server` is the Bun host with the mediums and the first-party providers in-tree. `apps/web` is the SvelteKit client and admin UI. `packages/plugin-api` holds the published plugin types. `plugins/webhooks` is the first-party plugin that ships through the official registry.

## Develop

Install dependencies.

```sh
bun install
```

Run the development servers.

```sh
bun run dev
```

Run the tests.

```sh
bun test
```

Build the image and start Pendia with Postgres. Set `PENDIA_HOST_PORT` when 3000 is taken on the host.

```sh
docker compose up --build
```

Database and S3 tests skip without a server. Set `DATABASE_URL` to a test Postgres and `TEST_S3_URL` to a test S3-compatible server, such as `http://<key>:<secret>@127.0.0.1:7070/<bucket>`.

## Artwork store

Pendia keeps artwork originals in one store, chosen once at setup with environment variables. Moving existing artwork to another store is unsupported.

| `PENDIA_ARTWORK_STORE` | Originals live in | Also set |
| --- | --- | --- |
| `colocated` (default) | each Item's `.pendia/artwork` folder | `PENDIA_ARTWORK_PATH` to fall back to when the media share is read-only |
| `path` | `PENDIA_ARTWORK_PATH` | `PENDIA_ARTWORK_PATH`, an absolute path |
| `s3` | an S3-compatible bucket | `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, plus `S3_ENDPOINT` and `S3_REGION` as the server needs. The `AWS_` names work too. |

Every role that serves the API or runs jobs reads the same settings and refuses to start when they are invalid.
