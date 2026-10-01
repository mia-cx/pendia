# #38 Browse client: home shelves, grids, detail pages, search

## Summary

Build the viewer side of `apps/web` on the admin UI's API client, resource pattern and styles. Home is assembled on the server from shelves: continue watching and recently added from the core, next up from the shows medium. Movies and shows grids page by keyset and sort by recently added or title. Movie, show, season and episode pages show artwork, credits, Versions and, for containers, their Seasons or Episodes. Search matches titles with pg_trgm through one procedure. Every read is scoped to the libraries the caller may view.

The API already has `items.list`, `items.get` (with `metadataState`), `shelves.continueWatching`, `shelves.nextUp` (ids only) and `/api/artwork/{id}?width=`. This slice adds what the screens need and nothing else: a `sort` on `items.list`, the detail extras, `items.search`, `shelves.home` and one migration with the indexes they read.

## Acceptance criteria

- [x] Home renders its shelves from a seeded library.
- [x] Grid endpoints answer under 50 ms server time at 10,000 items on a generated dataset, measured in a test.
- [x] Search returns fuzzy matches for a misspelled title.
- [x] Detail pages list Versions and credits; a user without access to a library never sees its Items.

## TODOs

- [x] 1. Add title sorting to `items.list` and the indexes browse reads.
  - `api/items.ts`: `sort: "added" | "title"`, default `added`, so existing callers and cursors keep working. Title order is `title, id` ascending with a `t1.` cursor prefix, following the `cw1.` precedent in `playback/marks.ts`. A cursor from one sort is rejected by the other.
  - `db/schema/core.ts` and migration `0007`: a btree on `(kind, title, id)` for the title grid and a GIN `gin_trgm_ops` index on `title` for search.
  - Validation: `api/browse.test.ts` pages the title sort to the end without gaps or repeats, rejects a cross-sort cursor with 400, and times `listItemCards` for both sorts, first page and a cursor page, at 10,000 generated movies: the median of five warm runs stays under 50 ms. `db.test.ts` passes on the new migration.

- [x] 2. Extend `items.get` for the detail pages.
  - A browse card is an `ItemCard` plus `parentId`, `seasonNumber`, `episodeNumber`, `episodeEndNumber` and the owning Show (`{ id, title, posterArtworkId }`), so an Episode card can link to its route and say which Show it belongs to. One reader serves details, children and shelves.
  - `ItemDetail` is a browse card plus the existing detail fields, `backdropArtworkId`, `credits` (`{ contributorId, name, role, character }`, actors first in credit order), `versions` (`{ id, label, format, durationSeconds, bytes }`) and `children` (Seasons of a Show or Episodes of a Season in number order, as browse cards).
  - Validation: tests seed a show with two seasons and episodes, credits and two Versions, and assert the order of children, credits and Versions, the Show and numbers on an Episode, and that a user denied the library gets 403 on `items.get`.

- [x] 3. Add `items.search` over titles.
  - Movies and Shows only, scoped to viewable libraries, matched with `title % query or query <% title` and ordered by word similarity, similarity, title and id, at most 24 results. The query trims, allows 1 to 200 characters and rejects NUL. A caller with no viewable library gets an empty list.
  - Validation: a misspelled title (`Interstelar`) finds `Interstellar`, a prefix finds its title, an unrelated query finds nothing, and Items in a denied library never appear.

- [x] 4. Add `shelves.home`, assembled from the mediums.
  - `api/browse.ts` walks the mediums: continue watching, then each medium's own shelves, then recently added; a core shelf appears only when some medium joins it. Continue watching reuses `continueWatching` and carries position and duration. Recently added lists root Items of the joining mediums newest first. Next up hydrates the shows medium's ids. Each shelf holds at most 24 entries, and an empty shelf is left out.
  - `shelves.nextUp` keeps its id output.
  - Validation: a seeded library with a movie in progress, a completed episode and new items yields the three shelves with the expected entries, and a user denied that library gets no entries from it.

- [x] 5. Add the browse shell, home, grids and search in `apps/web`.
  - Share the session guard between the admin and browse layouts. Rename `admin.css` to `app.css` since every screen uses it. A `(browse)` route group with a header holding Home, Movies, Shows, search, an Admin link for built-in admins and Sign out. Sign-in lands on `/`.
  - `/` renders `shelves.home`. `/movies` and `/shows` render `items.list` grids with a sort control kept in the URL and a Show more button that also loads when it scrolls into view. A poster card with a reserved 2:3 frame and a placeholder for missing artwork.
  - `/search?q=` renders `items.search` and follows the header field as it is typed. It moved here from TODO 6 because the header's typed routes need the page to exist.
  - `apps/web/DESIGN.md` records the layout, type, colour and card choices.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 6. Add the detail pages.
  - `$lib/components/ItemPage.svelte` renders one Item: backdrop, poster, title, facts, overview, an actions area the web player will fill with Play, Versions, credits and children. The routes match the mediums' screens: `/movies/[id]`, `/shows/[id]`, `/shows/[showId]/seasons/[id]` and `/shows/[showId]/seasons/[seasonId]/episodes/[id]`.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 7. Document, verify in a browser and run the gate.
  - `apps/server/README.md` documents `sort`, the detail additions, `items.search` and `shelves.home`.
  - Render every route at desktop and phone widths in Chromium against a seeded runtime, in both colour schemes, and perform the journey: home, grid, sort, show more, detail, season, episode, search.
  - Validation: the full gate from the repository root, recorded below.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/stack-38-browse`, branch `stack/38-browse`, stacked on `feat/76-translated-titles` (#78). Test Postgres `pendia-test-pg-38` on port 55538. `TMPDIR=/home/mia/.cache/pendia-tmp/38`.
- Initial state: clean worktree at `ff4341a`, the head of #78. The base holds migrations `0000` to `0006`, so this slice's migration is `0007`.
- An earlier, stopped attempt in `.worktrees/browse` left a sort, cursor and index draft. This plan reuses its approach; the code is rewritten here.
- Decisions made without anyone to ask:
  - Home is one procedure that walks the mediums' browse contributions, because the medium contract says Home is assembled from the shelves each medium joins. Recently played has no loader yet: no medium joins it until music lands.
  - Recently added lists root Items, Movies and Shows, by their own `addedAt`. A Show does not move up when a new Episode lands. Grouping new Episodes by Show is a larger change than this slice needs.
  - Search covers Movies and Shows. Episode titles are `Episode N` until a provider names them, so including them would flood results.
  - Grids sort by recently added and title. Release year sorting needs a nullable keyset and waits for a request.
  - The perf test times the service function in process, which is the server time the criterion names, rather than a round trip through HTTP.
- TODO 1 done. `items.list` takes `sort`; title cursors carry a `t1.` prefix and either sort rejects the other's cursor with 400. Migration `0007_hesitant_sandman` adds `items_kind_title_idx` and `items_title_trgm_idx`. `DATABASE_URL=... bun test apps/server/src/api/` 108 pass; the one failure, `hls-browser.test.ts`, needs `apps/web/build` and passes once the web app is built, as under `turbo run test`.
- TODO 2 done. `parentId` plus the browse card's `show` replace the planned `ancestors` list: a Season's parent is its Show, and an Episode's parent is its Season, so the card already holds every id a route needs. Details list imported Versions only; stored Versions are renditions of an imported one and belong to the player's adaptive group, not to a choice on the page. The poster subquery names its owner table in full, because a single-table select renders `"id"` unqualified and it bound to `artwork.id`; `router.test.ts` caught that. `DATABASE_URL=... bun test` on `browse`, `router`, `openapi` and `marks`: 33 pass.
- TODO 3 done. `items.search` answers at GET `/api/search?query=`, a static path, so it never competes with `/api/items/{id}`. The query trims through `Schema.Trim`. Tests: `Interstelar` finds only `Interstellar`, the denied library's `Interstellar Wars` never appears, a prefix and one word of a longer title match, gibberish finds nothing, and a blank, NUL or 201-character query answers 400. `browse` and `openapi` tests: 13 pass.
- TODO 4 done. Home order is continue watching, next up, recently added: what you were watching, what comes next, then what is new. The test seeds a movie in progress, a completed first Episode and newer Items, checks all three shelves, then denies the shows library and sees next up and the Show leave Home. `browse`, `marks` and `openapi` tests: 20 pass.
- TODO 5 done. `$lib/session.ts` is the one session guard for admin and browse; `SignOut.svelte` is the one sign-out button. `app.css` loads once from the root layout. The admin mark now links to Home, since the browse header carries the Admin link. The prerendered landing page is gone: `/` is Home, served from `200.html`. A grid caller with no viewable library gets 403 from `items.list`, which the grid shows as its empty state. `$lib/browse.test.ts` covers routes, Episode codes, durations and sizes: 6 pass with `scan.test.ts`. `bun run --cwd apps/web check` 0 errors; `build` writes `200.html`.
- Found while rendering in Chromium: the same-origin client handed oRPC a bare `/rpc`, and oRPC builds `new URL(url)`, so every screen on the default client, the merged admin included, failed with "Invalid URL". Fixed in its own commit; `api.test.ts` pins the request URL.
- TODO 6 done. `ItemPage.svelte` draws all four detail routes; `Poster.svelte` is the one poster frame for cards and pages. An Episode or Season borrows its Show's poster. The actions row renders only when a route passes an `actions` snippet, which is where #39 adds Play. Cast shows twelve names until Show all. Rendering fixed three things before this commit: the backdrop now spans the full width, the phone header no longer overflows (the section links span both columns), and the phone grid keeps three posters across.
- TODO 7 done. `apps/server/README.md` documents `sort`, browse cards, the detail additions, `items.search` and `shelves.home`.
- Browser check: headless Chromium 1440x900 and 390x844 over CDP on a seeded runtime (30 movies with gradient posters, some without, one backdrop with 18 cast and 3 crew, Severance with two Seasons of nine Episodes, progress for continue watching and next up), in light and dark. Journey performed: Home, Movies, sort by title (URL gains `?sort=title`, A to Z order), scroll loads the next page, Show page, Season, Episode, back up the breadcrumb, header search typed from Home (lands on `/search?q=incep` with focus kept, later keystrokes replace the history entry). Keyboard tab order reaches the section links with a visible ring. A viewer denied both libraries sees the empty Home, an empty Movies grid, no search hits and "Permission denied" on a direct detail URL. No horizontal overflow at 390 px.
- Gate at `3bb1766` plus docs: `bun install --frozen-lockfile` no changes; `bun run lint` clean, 240 files; `bun run check` 6 of 6; `bun run build` 4 of 4; `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55538/pendia bun test` 989 pass, 0 fail across 72 files; `env -u DATABASE_URL bun test` 549 pass, 448 skip, 0 fail with the single skip message.
