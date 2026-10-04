# #46 Release: image, compose, docs, readiness, CI publish

## Summary

Make Pendia installable. The image already builds with ffmpeg, the compiled server and the web app, and `compose.yaml` already starts it beside Postgres. This slice names the image in the registry, so compose pulls it when it can and builds it when it cannot. CI records the image size on every run and publishes the image to GHCR when a `v*` tag is pushed. One operations document covers the roles, the environment, health and the log format. The README gets a quick start. A test proves the api answers readiness only after migrations and the transcoder trial.

## Acceptance criteria

- [x] On a clean machine, `docker compose up` from the README reaches the admin wizard.
- [x] Readiness is false until migrations and the trial complete.
- [ ] CI publishes the image on a tag and the image size is recorded here. (Mia pushes the first tag; the publish job is ready. Image size from the PR's `image` job: 625 MB.)

## TODOs

- [x] Prove that the api answers `/readyz` only after migrations and the startup trial: a `startPendia("all")` test holds the migration lock, then blocks the trial, and sees no ready answer until both finish.
  - Validation: `DATABASE_URL=... bun test src/roles.test.ts` in `apps/server`. Done: 12 pass.
- [x] Name the image `ghcr.io/mia-cx/pendia` in `compose.yaml` and `compose.watcher.yaml`, pinned by `PENDIA_VERSION`, with the build kept as the fallback, and give the healthcheck a start period for the trial.
  - Validation: `docker compose config` and `docker compose -f compose.watcher.yaml config` resolve. Done: both resolve, and so does the test override.
- [x] CI: the `image` job records the image size and the ffmpeg version in the run summary; a `publish` job pushes the image to GHCR on `v*` tags after `checks` and `image` pass.
  - Validation: the PR's `image` job shows the size; the `publish` job is skipped on the PR.
- [x] Log a failed startup as a JSON line like every other line.
  - Validation: a test or a manual run with a bad `DATABASE_URL` prints one JSON line. Done: `DATABASE_URL=not-a-url bun src/index.ts --role api` and `--role nope` each print one `server.failed` line and exit 1.
- [x] Write `docs/operations.md`: roles, environment reference, health, log format and releases. Give the README a quick start and link the document; move the artwork store table there.
  - Validation: every variable the server reads appears once; links resolve. Done: the 15 variables `rg` finds outside tests are all in the table, and the README, server README, compose and anchor links resolve.
- [x] Follow the README quick start in an empty directory and reach the admin wizard; screenshot it. Run the full gate and record the results here.
  - Validation: wizard screenshot; `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `bun test` with and without `DATABASE_URL`.
  - Quick start: in an empty folder, `git clone --branch feat/46-release` (the branch, since `main` lacks the change), then `PENDIA_HOST_PORT=3846 docker compose -p pendia-46 up -d`. The GHCR pull answered `denied`, compose built the image from the clone, and `/readyz` answered ready. `/` opened the setup wizard: https://i.mia.cx/file/2026/10/pendia-46-wizard-compose.png. Inside the container `/media` was read-only to `pendia` and `/var/lib/pendia` was writable, which confirms the artwork fallback is needed. Torn down with `down -v`; the image and the 19 build cache entries the build made were removed by id.
  - After the compose split, at 431d5fb, in a second empty folder: `docker compose up -d` without a GHCR login stops at `denied`. The README's build line, `docker compose -f compose.yaml -f compose.build.yaml up -d --build`, built `pendia:local`, answered ready and opened the wizard: https://i.mia.cx/file/2026/10/pendia-46-wizard-compose-build.png. Torn down and pruned the same way. The pull path waits for the first published image.
  - Image size: 625 MB in the PR's CI `image` job, with ffmpeg 7.1.5. The local build showed 888 MB disk usage and 243 MB compressed.
  - Gate at 1972ce0: install no changes; lint clean (376 files); check 6 of 6; build 4 of 4. With DATABASE_URL: 1316 pass, 3 skip, 0 fail. Without: 774 pass, 563 skip, 0 fail.

## Notes

- Registry: GHCR, `ghcr.io/mia-cx/pendia`. The workflow pushes with `GITHUB_TOKEN` and `packages: write`, so no repository secret is needed. A new GHCR package is private, which matches the issue's "private registry".
- `compose.yaml` and `compose.watcher.yaml` only pull a release. A first cut kept `build: .` as the fallback, but Pullfrog showed that a failed pull of `PENDIA_VERSION=1.2.3` then built the checkout and tagged it `1.2.3`, and a self-built `latest` would block later pulls. `compose.build.yaml` now builds the checkout as `pendia:local`.
- The wizard asks for a library root path, so compose mounts `PENDIA_MEDIA` (default `./media`) at `/media`. The image's `pendia` user rarely owns that folder, so colocated artwork would hit `EACCES`; compose sets `PENDIA_ARTWORK_PATH` to a `pendia-data` volume, the fallback the artwork store already has.
- In `all`, `startPendia` migrates, starts plugins and awaits the transcoder trial before it binds the api port. Until then `/readyz` has no answer, which every probe counts as not ready. The test pins that order.
- The spec's request id on log lines is not implemented anywhere yet; the log format section documents the lines as they are.
