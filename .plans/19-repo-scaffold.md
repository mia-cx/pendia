# #19 Repo scaffold: workspace, roles CLI, web shell, image and compose

## Summary

The skeleton every later slice lands in: a Bun workspace with Turborepo, the server as a Bun host that takes `--role`, logs JSON and answers liveness and readiness, the SvelteKit app served by the api role from the same origin, the plugin API types package, a placeholder for the webhooks plugin, Biome, one Docker image with ffmpeg 7, a compose file with Postgres, and CI. Bun 1.4 or later is enforced at startup.

## Acceptance criteria

- [ ] `bun install` and `bun run build` succeed from a clean clone; lint and typecheck run in CI on every PR.
- [ ] `docker compose up` starts Postgres and Pendia; `/healthz` answers 200 and the web shell renders at `/`.
- [ ] Every role value is accepted and logged; an unknown one fails with a clear message.
- [ ] Bun below 1.4 exits at startup with a message naming the requirement.
- [ ] The plugin API package builds and exports the types from the spec unchanged.

## TODOs

- [ ] Workspace root: `package.json` with Bun workspaces for `apps/*`, `packages/*`, `plugins/*`, `engines.bun >= 1.4.0`, `turbo.json` with `build`, `lint`, `check`, `test` and `dev`, `biome.json`, `.gitignore`, `.editorconfig`, and a root `tsconfig.base.json` with strict settings.
- [ ] `packages/plugin-api`: publishes the declarations from `docs/spec/plugin-api.d.ts` unchanged as its types entry, version `0.1.0`, name `@pendia/plugin-api`.
- [ ] `apps/server`: entry that parses `--role api|worker|transcoder|watcher|all` (default `all`), exits with a clear message on an unknown role, gates on Bun 1.4.0 or later with a message naming the requirement, logs structured JSON tagged with the role, and shuts down on SIGTERM. Worker, transcoder and watcher roles log that they started and idle.
- [ ] `apps/server` api role: `Bun.serve` on `PENDIA_PORT` (default 3000) with `/healthz` answering 200 and `/readyz` answering 200 with a comment marking where migrations and the transcoder trial will gate it later.
- [ ] `apps/web`: SvelteKit app whose build is served by the api process on the same origin for every non-API path, rendering a "Pendia" shell at `/`. SSR through the Bun adapter is allowed; a static build is acceptable if mounting the SSR handler into `Bun.serve` proves awkward. Record the choice in Notes.
- [ ] `plugins/webhooks`: placeholder package with the `pendia` manifest block from `docs/spec/plugins.md` and an entry that calls `definePlugin` from `@pendia/plugin-api` and registers nothing yet.
- [ ] Tests with `bun test`: role parsing accepts the five values and rejects an unknown one; the Bun version gate rejects `1.3.11` and accepts `1.4.0`; a started api server answers `/healthz` with 200.
- [ ] `Dockerfile`: multi-stage, build on `oven/bun:1.4`, runtime on Debian trixie with ffmpeg 7 installed, the server compiled with `bun build --compile` and the web build copied in, `--role all` as the default command. `compose.yaml` with Postgres 18 and Pendia, `DATABASE_URL` wired, port 3000 published.
- [ ] CI: a GitHub Actions workflow on pull requests running `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun test`, and a Docker build without push.
- [ ] README: a short "Develop" section with the commands to install, run, test and build the image.

## Notes

- Bun 1.4.2 is installed on the dev box for this slice; the audit in `docs/research/bun-capabilities.md` is why 1.4 is the floor.
- Implementation is delegated to Codex (gpt-5.6-sol); each TODO lands as one commit with `Refs #19`.
