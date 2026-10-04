# #46 Release: image, compose, docs, readiness, CI publish

## Summary

Make Pendia installable. The image already builds with ffmpeg, the compiled server and the web app, and `compose.yaml` already starts it beside Postgres. This slice names the image in the registry, so compose pulls it when it can and builds it when it cannot. CI records the image size on every run and publishes the image to GHCR when a `v*` tag is pushed. One operations document covers the roles, the environment, health and the log format. The README gets a quick start. A test proves the api answers readiness only after migrations and the transcoder trial.

## Acceptance criteria

- [ ] On a clean machine, `docker compose up` from the README reaches the admin wizard.
- [ ] Readiness is false until migrations and the trial complete.
- [ ] CI publishes the image on a tag and the image size is recorded here. (Mia pushes the first tag; the publish job is ready.)

## TODOs

- [x] Prove that the api answers `/readyz` only after migrations and the startup trial: a `startPendia("all")` test holds the migration lock, then blocks the trial, and sees no ready answer until both finish.
  - Validation: `DATABASE_URL=... bun test src/roles.test.ts` in `apps/server`. Done: 12 pass.
- [x] Name the image `ghcr.io/mia-cx/pendia` in `compose.yaml` and `compose.watcher.yaml`, pinned by `PENDIA_VERSION`, with the build kept as the fallback, and give the healthcheck a start period for the trial.
  - Validation: `docker compose config` and `docker compose -f compose.watcher.yaml config` resolve. Done: both resolve, and so does the test override.
- [x] CI: the `image` job records the image size and the ffmpeg version in the run summary; a `publish` job pushes the image to GHCR on `v*` tags after `checks` and `image` pass.
  - Validation: the PR's `image` job shows the size; the `publish` job is skipped on the PR.
- [ ] Log a failed startup as a JSON line like every other line.
  - Validation: a test or a manual run with a bad `DATABASE_URL` prints one JSON line.
- [ ] Write `docs/operations.md`: roles, environment reference, health, log format and releases. Give the README a quick start and link the document; move the artwork store table there.
  - Validation: every variable the server reads appears once; links resolve.
- [ ] Follow the README quick start in an empty directory and reach the admin wizard; screenshot it. Run the full gate and record the results here.
  - Validation: wizard screenshot; `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `bun test` with and without `DATABASE_URL`.

## Notes

- Registry: GHCR, `ghcr.io/mia-cx/pendia`. The workflow pushes with `GITHUB_TOKEN` and `packages: write`, so no repository secret is needed. A new GHCR package is private, which matches the issue's "private registry".
- Compose names the registry image and keeps `build: .`. Compose pulls the image when the host can, and builds from the clone when the pull fails. A clone without registry access still starts.
- The wizard asks for a library root path, so compose mounts `PENDIA_MEDIA` (default `./media`) at `/media`. The image's `pendia` user rarely owns that folder, so colocated artwork would hit `EACCES`; compose sets `PENDIA_ARTWORK_PATH` to a `pendia-data` volume, the fallback the artwork store already has.
- In `all`, `startPendia` migrates, starts plugins and awaits the transcoder trial before it binds the api port. Until then `/readyz` has no answer, which every probe counts as not ready. The test pins that order.
- The spec's request id on log lines is not implemented anywhere yet; the log format section documents the lines as they are.
