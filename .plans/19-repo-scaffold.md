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

- [x] Workspace root: `package.json` with Bun workspaces for `apps/*`, `packages/*`, `plugins/*`, `engines.bun >= 1.4.0`, `turbo.json` with `build`, `lint`, `check`, `test` and `dev`, `biome.json`, `.gitignore`, `.editorconfig`, and a root `tsconfig.base.json` with strict settings.
- [x] `packages/plugin-api`: publishes the declarations from `docs/spec/plugin-api.d.ts` unchanged as its types entry, version `0.1.0`, name `@pendia/plugin-api`.
- [x] `apps/server`: entry that parses `--role api|worker|transcoder|watcher|all` (default `all`), exits with a clear message on an unknown role, gates on Bun 1.4.0 or later with a message naming the requirement, logs structured JSON tagged with the role, and shuts down on SIGTERM. Worker, transcoder and watcher roles log that they started and idle.
- [x] `apps/server` api role: `Bun.serve` on `PENDIA_PORT` (default 3000) with `/healthz` answering 200 and `/readyz` answering 200 with a comment marking where migrations and the transcoder trial will gate it later.
- [x] `apps/web`: SvelteKit app whose build is served by the api process on the same origin for every non-API path, rendering a "Pendia" shell at `/`. SSR through the Bun adapter is allowed; a static build is acceptable if mounting the SSR handler into `Bun.serve` proves awkward. Record the choice in Notes.
- [x] `plugins/webhooks`: placeholder package with the `pendia` manifest block from `docs/spec/plugins.md` and an entry that calls `definePlugin` from `@pendia/plugin-api` and registers nothing yet.
- [x] Tests with `bun test`: role parsing accepts the five values and rejects an unknown one; the Bun version gate rejects `1.3.11` and accepts `1.4.0`; a started api server answers `/healthz` with 200.
- [ ] `Dockerfile`: multi-stage, build on `oven/bun:1.4`, runtime on Debian trixie with ffmpeg 7 installed, the server compiled with `bun build --compile` and the web build copied in, `--role all` as the default command. `compose.yaml` with Postgres 18 and Pendia, `DATABASE_URL` wired, port 3000 published.
- [ ] CI: a GitHub Actions workflow on pull requests running `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun test`, and a Docker build without push.
- [ ] README: a short "Develop" section with the commands to install, run, test and build the image.

## Notes

- Bun 1.4.2 is installed on the dev box for this slice; the audit in `docs/research/bun-capabilities.md` is why 1.4 is the floor.
- Implementation is delegated to Codex (gpt-5.6-sol); each TODO lands as one commit with `Refs #19`.
- TODO 1: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun install && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run build && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run lint && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run check` passed.
- TODO 2: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun install && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run build && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run lint && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run check && cmp --silent docs/spec/plugin-api.d.ts packages/plugin-api/plugin-api.d.ts` passed.
- TODO 3: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun install && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run build && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run lint && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run check` passed.
- TODO 4: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun install && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run build && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run lint && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run check` passed.
- TODOs 3 and 4 landed in one commit: the entry imports the api module, so a split commit would not typecheck. Orchestrator ran the runtime checks: an unknown role exits 1 with the message, the gate rejects 1.3.11 and accepts 1.4.0, /healthz and /readyz answer 200, SIGTERM stops the server, `--role all` starts every role.
- TODO 5 uses the SvelteKit static adapter. Bun serves the files directly, which keeps the API host independent of adapter runtime code.
- TODO 5: `PENDIA_PORT=3125 bun apps/server/src/index.ts --role api`, `curl -fsS http://localhost:3125/`, and `curl -s -o /dev/null -w '%{http_code}' http://localhost:3125/healthz` passed. The page contained `Pendia`, health returned 200, and SIGTERM stopped the server.
- TODO 6: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun install && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run build && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run lint && BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run check` passed.
- TODO 7: `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun test` passed with 9 tests across 2 files. `BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/pendia-bun-cache /home/mia/.bun/bin/bun run test` passed with 5 Turbo tasks.
- Orchestrator: `+layout.ts` now prerenders instead of disabling SSR, so the HTML at `/` carries the page and curl sees "Pendia" without JavaScript. Root `typescript` moved to 6.0.3 by Codex for svelte-check compatibility.
