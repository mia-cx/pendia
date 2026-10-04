# #43 Webhooks plugin, OpenSubtitles provider and official registry

## Summary

Three first-party pieces on the #42 plugin host. The webhooks plugin listens for the server events an admin picks and sends each one to a configured URL with a method, headers and a body template rendered from the event, retrying when the receiver answers 5xx or cannot be reached. OpenSubtitles implements the subtitle provider contract in-tree: a `subtitle-fetch` job searches by file hash and name for each configured language, downloads the best match, and stores it in the Item's `.pendia/subtitles` folder, where the play plan picks it up as a track. `pendia-registry.json` at the repo root is the official registry, listing the webhooks plugin.

## Acceptance criteria

- [x] An item-added event posts a rendered body to a local receiver; a 5xx answer is retried.
- [x] OpenSubtitles fetches a subtitle for a fixture through a mocked API and the track shows in the play plan.
- [x] The registry manifest validates and installs the webhooks plugin through the host.

## TODOs

- [x] 1. Host: a manifest may declare `network: ["*"]` for any host.
  - `manifest.ts` accepts `*` in `pendia.network`; `host.fetch` lets `*` reach any host and refuses every scheme but http and https; the install review in the web admin says "Reach any host".
  - Validation: manifest, host and web `plugins.test.ts` unit tests; before and after screenshots of the install review.
- [x] 2. Webhooks plugin.
  - Config schema: `url`, `method` (POST, PUT, PATCH), `headers` as `Name: value` lines, `body` template, `events`, `retries`. Handlers for every event; each checks the configured list, renders the body and sends it through `host.fetch`. `{{path}}` inserts a value from `{ event, timestamp, data, item }`: strings escaped for a JSON string, everything else as JSON. 5xx and network errors retry with backoff; a final failure is logged, never thrown, so one bad receiver does not disable the plugin.
  - The package is publishable as `@pendia/plugin-webhooks@1.0.0`: bundled `dist`, no runtime dependencies.
  - Validation: template unit tests in the plugin; a Postgres test installs the bundled plugin, inserts an Item, and a local receiver gets the rendered body after one 503.
- [x] 3. Official registry.
  - `pendia-registry.json` at the repo root lists `@pendia/plugin-webhooks` with source `@pendia/plugin-webhooks@1.0.0`.
  - Validation: a Postgres test reads the file with `readRegistry`, installs its source through the runtime from a local npm stand-in serving the bundled package, and loads it.
- [x] 4. Subtitle tracks on disk and in the play plan.
  - `subtitles/store.ts` names files `<itemId>.<language>.<format>` under `<canonical folder>/.pendia/subtitles/`, writes atomically and lists an Item's tracks.
  - `playback.plan` returns `subtitles: [{ language, format, url }]`; `GET /api/subtitles/<itemId>/<language>.<format>` serves the file to a caller who may view the Item.
  - Validation: store unit tests; an api test plans a fixture with a stored track and fetches it.
- [x] 5. OpenSubtitles provider and the subtitle-fetch job.
  - `subtitles/opensubtitles.ts` implements `SubtitleProvider` against the REST API: OpenSubtitles hash of the first Version's file, title and year or Show title with season and episode, provider ids, sorted lowercase query parameters, `Api-Key` and `User-Agent` headers, machine translations left out; `download` resolves the link and reads the text.
  - A `subtitle-fetch` job type (enum migration) runs after a movie or episode matches when `subtitleLanguages` in the metadata settings is non-empty. It asks OpenSubtitles (with the `opensubtitles` provider key) and plugin subtitle providers for missing languages and stores the best match per language.
  - Validation: hash unit test against the published reference values; a Postgres test runs the job for a fixture against a mocked API, and the plan lists the track.
- [x] 6. Docs and final gate.
  - `docs/spec/plugins.md` (`*` hosts, the registry file), `docs/spec/playback.md` (stored subtitle tracks), `apps/server/README.md` (subtitle languages, the OpenSubtitles key), plugin README.
  - Run `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test` and `bun test` without it.

## Notes

- Unattended run. Worktree `.worktrees/webhooks`, branch `feat/43-webhooks`, base `main` at 4dee205. Postgres container `pendia-test-pg-43` on 127.0.0.1:55543.
- A webhook URL is whatever the admin enters, so a fixed host list cannot work. `*` is the smallest host change that keeps the manifest honest about it.
- Event jobs run once per attempt, but a plugin handler that throws marks the plugin failed. So retries live inside the plugin, and a receiver that stays down is logged.
- One endpoint per install, as the issue says: "a configured URL".
- The registry source is the npm spec, as in the spec's example. Publishing `@pendia/plugin-webhooks@1.0.0` to npm is outward-facing and left to Mia; until then the official registry lists a source npm does not have yet.
- Subtitle files are their own record: the folder is listed when a plan is made, so deleting a file removes the track and a folder move carries them along. Episodes share a Season folder, hence the Item id in the name. The stored-version sweep already leaves a bare `.pendia` folder alone.
- One track per Item and language, forced-only matches skipped. Files keep the provider's format; the plan names it. Converting to WebVTT for the web player belongs with the player.
- #34 (PR #88) rewrites `playback/planning.ts`. This slice only adds a `subtitles` list to the plan, to keep the merge small.
- `main` already let `*` through: `new URL("http://*").hostname` is `*`, so the manifest took it as a literal host, the install review said "Reach *", and `host.fetch` refused every real host. Hostnames now must be `[a-z0-9.:[]-]`, so `*.example` no longer passes as a literal either.
- `host.fetch` used to pass any scheme through to Bun's fetch, which reads `file://` URLs. It now refuses everything but http and https.
- The webhooks bundle imports `definePlugin` from `@pendia/plugin-api`, whose `dist` exists only after a build. CI builds before it tests; locally, run the build first.
- The plan's `subtitles` list is on `playback.plan` only; `playback.refresh` keeps its old output.
- Plugin subtitle providers join through `runtime.subtitleProviders()`, guarded like metadata providers. A plugin that fails mid-job is skipped for that job.
- TODO 1 validation: manifest, host fetch and web `plugins.test.ts` pass. Screenshots of the install review at 1440x900 and 390x844, light and dark, against `origin/main` and this branch, with the bundled webhooks folder as the source.
- TODO 2 and 3 validation: `bun test` in `plugins/webhooks` 4 pass; `DATABASE_URL=... bun test src/plugins/webhooks.test.ts` 2 pass: the receiver gets the rendered body twice after one 503, and the registry entry installs from a local npm stand-in and loads.
- TODO 4 and 5 validation: `DATABASE_URL=... bun test src/subtitles src/metadata` passes. The mocked API sees sorted lowercase parameters with the hash, title, year and IMDb number; the hash match beats a more downloaded file; machine-translated and forced matches are skipped; the plan lists `nl.srt` and the route serves it, 401 without credentials and 404 for a missing language.
- Gate at df6b5ed plus the db test fix: `bun install --frozen-lockfile`, `bun run lint`, `bun run check` and `bun run build` passed. `PENDIA_TRANSCODER_PORT=3543 DATABASE_URL=... bun test`: 1199 pass, 3 skip, 2 fail; both failures were `db.test.ts` counting 10 migrations, fixed in 8681afc to 11, and that file then passed 10 of 10. `bun test` without DATABASE_URL: 693 pass, 521 skip, 0 fail.
- Review rounds: logs name only the webhook origin, retries clamp to 0..10, a 3xx is not delivered, OpenSubtitles searches each language on its own, skips split releases and reads up to five pages until a language has a full track.
- Merged main 67e9870 (#34 live transcode) in d05f87d. The conflict in `planning.ts` keeps #34's stored-first planning, transcode sessions and burn-in rule; the plan's `subtitles` list now joins the returned session. Gate at d05f87d: install, lint, check and build passed; `PENDIA_TRANSCODER_PORT=3543 DATABASE_URL=... bun test` 1286 pass, 3 skip, 0 fail; `bun test` without it 759 pass, 542 skip, 0 fail.
