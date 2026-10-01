# #38 Browse client: home shelves, grids, detail pages, search

## Summary

Build the viewer side of `apps/web` on the admin UI's API client, resource pattern and styles. Home is assembled on the server from shelves: continue watching and recently added from the core, next up from the shows medium. Movies and shows grids page by keyset and sort by recently added or title. Movie, show, season and episode pages show artwork, credits, Versions and, for containers, their Seasons or Episodes. Search matches titles with pg_trgm through one procedure. Every read is scoped to the libraries the caller may view.

The API already has `items.list`, `items.get` (with `metadataState`), `shelves.continueWatching`, `shelves.nextUp` (ids only) and `/api/artwork/{id}?width=`. This slice adds what the screens need and nothing else: a `sort` on `items.list`, the detail extras, `items.search`, `shelves.home` and one migration with the indexes they read.

## Acceptance criteria

- [ ] Home renders its shelves from a seeded library.
- [ ] Grid endpoints answer under 50 ms server time at 10,000 items on a generated dataset, measured in a test.
- [ ] Search returns fuzzy matches for a misspelled title.
- [ ] Detail pages list Versions and credits; a user without access to a library never sees its Items.

## TODOs

- [x] 1. Add title sorting to `items.list` and the indexes browse reads.
  - `api/items.ts`: `sort: "added" | "title"`, default `added`, so existing callers and cursors keep working. Title order is `title, id` ascending with a `t1.` cursor prefix, following the `cw1.` precedent in `playback/marks.ts`. A cursor from one sort is rejected by the other.
  - `db/schema/core.ts` and migration `0007`: a btree on `(kind, title, id)` for the title grid and a GIN `gin_trgm_ops` index on `title` for search.
  - Validation: `api/browse.test.ts` pages the title sort to the end without gaps or repeats, rejects a cross-sort cursor with 400, and times `listItemCards` for both sorts, first page and a cursor page, at 10,000 generated movies: the median of five warm runs stays under 50 ms. `db.test.ts` passes on the new migration.

- [x] 2. Extend `items.get` for the detail pages.
  - A browse card is an `ItemCard` plus `parentId`, `seasonNumber`, `episodeNumber`, `episodeEndNumber` and the owning Show (`{ id, title, posterArtworkId }`), so an Episode card can link to its route and say which Show it belongs to. One reader serves details, children and shelves.
  - `ItemDetail` is a browse card plus the existing detail fields, `backdropArtworkId`, `credits` (`{ contributorId, name, role, character }`, actors first in credit order), `versions` (`{ id, label, format, durationSeconds, bytes }`) and `children` (Seasons of a Show or Episodes of a Season in number order, as browse cards).
  - Validation: tests seed a show with two seasons and episodes, credits and two Versions, and assert the order of children, credits and Versions, the Show and numbers on an Episode, and that a user denied the library gets 403 on `items.get`.

- [ ] 3. Add `items.search` over titles.
  - Movies and Shows only, scoped to viewable libraries, matched with `title % query or query <% title` and ordered by word similarity, similarity, title and id, at most 24 results. The query trims, allows 1 to 200 characters and rejects NUL. A caller with no viewable library gets an empty list.
  - Validation: a misspelled title (`Interstelar`) finds `Interstellar`, a prefix finds its title, an unrelated query finds nothing, and Items in a denied library never appear.

- [ ] 4. Add `shelves.home`, assembled from the mediums.
  - `api/browse.ts` walks the mediums: the core shelves some medium joins, continue watching then recently added, then each medium's own shelves. Continue watching reuses `continueWatching` and carries position and duration. Recently added lists root Items of the joining mediums newest first. Next up hydrates the shows medium's ids. Each shelf holds at most 24 entries, and an empty shelf is left out.
  - `shelves.nextUp` keeps its id output.
  - Validation: a seeded library with a movie in progress, a completed episode and new items yields the three shelves with the expected entries, and a user denied that library gets no entries from it.

- [ ] 5. Add the browse shell, home and grids in `apps/web`.
  - Share the session guard between the admin and browse layouts. Rename `admin.css` to `app.css` since every screen uses it. A `(browse)` route group with a header holding Home, Movies, Shows, search, an Admin link for built-in admins and Sign out. Sign-in lands on `/`.
  - `/` renders `shelves.home`. `/movies` and `/shows` render `items.list` grids with a sort control kept in the URL and a Show more button that also loads when it scrolls into view. A poster card with a reserved 2:3 frame and a placeholder for missing artwork.
  - `apps/web/DESIGN.md` records the layout, type, colour and card choices.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [ ] 6. Add the detail pages and search screen.
  - `$lib/components/ItemPage.svelte` renders one Item: backdrop, poster, title, facts, overview, an actions area the web player will fill with Play, Versions, credits and children. The routes match the mediums' screens: `/movies/[id]`, `/shows/[id]`, `/shows/[showId]/seasons/[id]` and `/shows/[showId]/seasons/[seasonId]/episodes/[id]`.
  - `/search?q=` renders `items.search` and follows the header field as it is typed.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [ ] 7. Document, verify in a browser and run the gate.
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
