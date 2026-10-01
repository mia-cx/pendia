# #76 Match translated Radarr folder titles against TMDB

## Summary

Radarr can name a movie folder with a translated title. TMDB search finds the movie, but its results carry only `title` in the request language and `original_title`. A folder like `Die Verurteilten (1994)` matches neither for *The Shawshank Redemption*, scores 0.7 and stays `unmatched`. When no search result matches by plain or original title, the TMDB provider reads each leading candidate's translations and compares the folder title against them with the existing normalization and scoring.

## Acceptance criteria

- [ ] An untagged translated folder such as `Die Verurteilten (1994)` matches its TMDB movie.
- [ ] A search whose plain or original title already matches makes no extra TMDB request.
- [ ] A translated title shared by two candidates stays ambiguous, and a translation that matches nothing changes no score.
- [ ] Provider calls are mocked in tests.

## TODOs

- [ ] 1. Read candidate translations in TMDB search when no plain title matches.
  - Decode every search result first. When none matches by `title` or `original_title`, request `/movie/{id}/translations` for the first five candidates in TMDB order and treat a normalized translated title as a title match.
  - A 404 for one candidate means no translations. Malformed translation bodies reject as `Invalid TMDB response.`
  - Validation: mocked HTTP tests in `tmdb.test.ts` cover the translated match, no lookup when a plain title matches, a nonmatching translation, a shared translated title, the lookup cap, 404 and malformed bodies. Run server typecheck.
- [ ] 2. Prove an untagged translated folder flows from scan to a match.
  - Add a provider-fetch job test with a scanned `Die Verurteilten (1994)` folder and mocked TMDB search, translations and details.
  - Validation: `DATABASE_URL=... bun test apps/server/src/metadata/jobs.test.ts` passes, and the Item ends `matched` with the TMDB id.
- [ ] 3. Document translated-title matching in `apps/server/README.md`.
  - Validation: the metadata settings section states when translations are read and the five-candidate cap.
- [ ] 4. Run the full repository gate.
  - From the repo root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55576/pendia bun test`, and `bun test` without `DATABASE_URL`.
  - Validation: all pass, and Notes record the real results.

## Notes

- Translations, not alternative titles: Radarr's `GetLanguageTitle` naming tokens read Radarr's movie translations, which come from TMDB translations. Alternative titles are a different list.
- Translations cost one request per candidate. The provider reads them only when no candidate matches by plain or original title, so ordinary searches keep one request.
- The lookup is capped at the first five candidates in TMDB's relevance order. A translated query ranks its own movie near the top, and the cap bounds the requests for an untagged folder that matches nothing. A shared translated title past the fifth result goes unseen; that trade is accepted to keep unmatched folders cheap.
- Lookups run in parallel. Any failed lookup fails the search, and the provider-fetch job retries as it does for other TMDB failures.
- `service.ts` needs no change: the provider's confidence feeds the existing threshold and tie rules.
- Worktree `/home/mia/mia-cx/pendia/.worktrees/translated-titles`, branch `feat/76-translated-titles`. Test Postgres `pendia-test-pg-76` on port 55576.
