# Thalia

A self-hosted media server, written from scratch to be fast where Jellyfin is slow: scanning, browsing, playback start and startup.

One image, one binary. Movies, series, music, photos, ebooks, audiobooks, live TV and channels, each with a browser built for that medium. Plugins are TypeScript. The apps you already use keep working through translation layers: the Jellyfin API for video, OpenSubsonic for music, OPDS for ebooks.

## Status

Planning. The architecture is decided ticket by ticket on the [Thalia v1 map](https://github.com/mia-cx/pendia/issues?q=label%3Awayfinder%3Amap). The glossary is [CONTEXT.md](./CONTEXT.md), decisions live in [docs/adr](./docs/adr).

## Run

You need git and Docker with Compose. The image is private: log in to GHCR with a GitHub token that has `read:packages`.

```sh
git clone https://github.com/mia-cx/pendia.git
cd thalia
docker login ghcr.io
docker compose up -d
```

Open http://localhost:3000 and create the admin account in the setup wizard. Inside Thalia, your media lives under `/media`: put it in `./media`, or set `THALIA_MEDIA` to its folder before `docker compose up`.

Movie metadata and artwork come from TMDB. Put your TMDB v3 API key, the 32-character one, in `.env` as `TMDB_API_KEY=<key>`, or run `scripts/tmdb-key-wizard.sh` to write it there. Then run `docker compose up -d` again. Thalia does not use the Read Access Token.

Without access to the image, build it from the clone instead:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

[docs/operations.md](./docs/operations.md) covers roles, environment variables, health, logs and releases.

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

Build the image from your checkout and start it with Postgres. Set `THALIA_HOST_PORT` when 3000 is taken on the host.

```sh
docker compose -f compose.yaml -f compose.build.yaml up --build
```

Database and S3 tests skip without a server. Set `DATABASE_URL` to a test Postgres and `TEST_S3_URL` to a test S3-compatible server, such as `http://<key>:<secret>@127.0.0.1:7070/<bucket>`.
