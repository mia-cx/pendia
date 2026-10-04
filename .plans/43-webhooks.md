# #43 Webhooks plugin, OpenSubtitles provider and official registry

## Summary

Three first-party pieces on the #42 plugin host. The webhooks plugin listens for the server events an admin picks and sends each one to a configured URL with a method, headers and a body template rendered from the event, retrying when the receiver answers 5xx or cannot be reached. OpenSubtitles implements the subtitle provider contract in-tree: a `subtitle-fetch` job searches by file hash and name for each configured language, downloads the best match, and stores it in the Item's `.pendia/subtitles` folder, where the play plan picks it up as a track. `pendia-registry.json` at the repo root is the official registry, listing the webhooks plugin.

## Acceptance criteria

- [ ] An item-added event posts a rendered body to a local receiver; a 5xx answer is retried.
- [ ] OpenSubtitles fetches a subtitle for a fixture through a mocked API and the track shows in the play plan.
- [ ] The registry manifest validates and installs the webhooks plugin through the host.

## TODOs

- [ ] 1. Host: a manifest may declare `network: ["*"]` for any host.
  - `manifest.ts` accepts `*` in `pendia.network`; `host.fetch` lets `*` reach any host and refuses every scheme but http and https; the install review in the web admin says "Reach any host".
  - Validation: manifest, host and web `plugins.test.ts` unit tests; before and after screenshots of the install review.
- [ ] 2. Webhooks plugin.
  - Config schema: `url`, `method` (POST, PUT, PATCH), `headers` as `Name: value` lines, `body` template, `events`, `retries`. Handlers for every event; each checks the configured list, renders the body and sends it through `host.fetch`. `{{path}}` inserts a value from `{ event, timestamp, data, item }`: strings escaped for a JSON string, everything else as JSON. 5xx and network errors retry with backoff; a final failure is logged, never thrown, so one bad receiver does not disable the plugin.
  - The package is publishable as `@pendia/plugin-webhooks@1.0.0`: bundled `dist`, no runtime dependencies.
  - Validation: template unit tests in the plugin; a Postgres test installs the bundled plugin, inserts an Item, and a local receiver gets the rendered body after one 503.
- [ ] 3. Official registry.
  - `pendia-registry.json` at the repo root lists `@pendia/plugin-webhooks` with source `@pendia/plugin-webhooks@1.0.0`.
  - Validation: a Postgres test reads the file with `readRegistry`, installs its source through the runtime from a local npm stand-in serving the bundled package, and loads it.
- [ ] 4. Subtitle tracks on disk and in the play plan.
  - `subtitles/store.ts` names files `<itemId>.<language>.<format>` under `<canonical folder>/.pendia/subtitles/`, writes atomically and lists an Item's tracks.
  - `playback.plan` returns `subtitles: [{ language, format, url }]`; `GET /api/subtitles/<itemId>/<language>.<format>` serves the file to a caller who may view the Item.
  - Validation: store unit tests; an api test plans a fixture with a stored track and fetches it.
- [ ] 5. OpenSubtitles provider and the subtitle-fetch job.
  - `subtitles/opensubtitles.ts` implements `SubtitleProvider` against the REST API: OpenSubtitles hash of the first Version's file, title and year or Show title with season and episode, provider ids, sorted lowercase query parameters, `Api-Key` and `User-Agent` headers, machine translations left out; `download` resolves the link and reads the text.
  - A `subtitle-fetch` job type (enum migration) runs after a movie or episode matches when `subtitleLanguages` in the metadata settings is non-empty. It asks OpenSubtitles (with the `opensubtitles` provider key) and plugin subtitle providers for missing languages and stores the best match per language.
  - Validation: hash unit test against the published reference values; a Postgres test runs the job for a fixture against a mocked API, and the plan lists the track.
- [ ] 6. Docs and final gate.
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
