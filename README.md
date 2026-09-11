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
