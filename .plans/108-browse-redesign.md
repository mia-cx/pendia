# #108 Redesign: Home, grids and search

## Summary

The second slice of the redesign PRD (#105), on the system #107 (PR #116) built. #116 gave Pendia its shell; the media itself still looks like the old app. This slice makes Home, the Movies and Shows grids and Search feel like the Apple TV app: artwork first, a full-bleed hero carousel, landscape Continue Watching cards with progress and time left, tall poster shelves, and posters without artwork that look deliberate. Grids load as they scroll and sort from a menu. Search updates as you type and groups results by kind.

Mia's reference screenshots 01, 02 and 07 (Apple TV on macOS) set the structure: the hero with title art, two-line overview, white pill and round button at the bottom left, dots and edge chevrons; landscape cards with the time left at the bottom left and a `…` menu at the bottom right; poster shelves with nothing under the cards.

## Acceptance criteria

- [x] Home leads with the featured carousel, then Continue Watching with progress, Next Up, and the remaining shelves
- [x] Shelves snap and show arrow buttons on pointer devices
- [x] Movies and Shows load more as they scroll, with no Show more button, and sort from a menu
- [x] Search updates as you type and groups results by kind
- [x] Posters reserve their frame, lift on hover and focus, and fall back to a styled title
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] 1. Server: store backdrops and logos with posters, and carry hero artwork on browse cards.
  - The metadata fetch stores only the primary image today, so no Item has a backdrop or logo, and browse cards carry only a poster. The hero and landscape cards need both.
  - Movies and Shows store poster, backdrop and logo; Seasons a poster; Episodes a thumb (the still). Browse cards gain `backdropArtworkId`, `logoArtworkId`, `thumbArtworkId`, and their Show's backdrop and logo. Tests in `jobs.test.ts` and `browse.test.ts`.
- [x] 2. Media frame: `Poster` grows a landscape shape and a deliberate fallback.
  - One frame component, 2:3 or 16:9, reserved before load. Without artwork: a quiet gradient surface with the title in display type and the medium's icon, so the title prints once.
- [x] 3. Cards: poster card and landscape card, with the card menu.
  - Poster card: artwork only, title as its accessible name, lift on hover and focus, optional progress.
  - Landscape card: backdrop or episode still, title art or title, `38m left` or `S1, E2 · 22m left`, progress bar, `New` badge for fresh Next Up episodes, and a `…` menu with Go to movie, Go to episode, Go to show and Play from start. The #106 actions (mark watched, watchlist, share) get a marked slot in the menu, not fake items.
- [x] 4. Shelf: edge paddles on pointer devices, landscape and poster sizes, snapping.
- [x] 5. Hero and Home: the shared `Hero` and the Home carousel, then the shelves.
  - Slides from Continue Watching, then recently added, preferring Items with a backdrop. Logo art or a display title, meta line, two-line overview, white pill (Play, Resume, or Go to show) and a round details button. Dots and edge chevrons; swipe on touch.
- [x] 6. Grids: infinite scroll with no Show more button, a loading row and status, the sort menu.
- [x] 7. Search: results as you type, grouped by kind, previous results held while the next query loads.
- [x] 8. `DESIGN.md`: every new component and screen pattern.
- [x] 9. Review and evidence: before and after screenshots at 1440x900 and 390x844, light and dark, hover and focus states, an open sort menu and card menu; keyboard, screen reader, reduced motion and high contrast passes.
- [x] 10. Gate from the repo root, results below.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/media`, branch `feat/108-browse-redesign` from `origin/feat/107-design-system` at `65867af`. PR base `feat/107-design-system`. Test Postgres `pendia-test-pg-media` on 55571. `TMPDIR=/home/mia/.cache/pendia-tmp/media`.
- Decisions made without anyone to ask:
  - The brief allows the smallest server change a page needs, with a test, which overrides the PRD's "file the gap" rule for this slice. Storing backdrops and logos is that change: the hero, landscape cards and the #109 detail heroes have nothing to show without it.
  - Hero slides fetch their overview and genres with `items.get`, so browse cards stay small.
  - No autoplay on the carousel. An auto-advancing carousel needs a pause control to meet WCAG 2.2.2, and Pendia's hero is about what you were watching, not a billboard.
  - Shelf titles carry `›` only when the shelf has a page to open. None of Home's shelves has one yet, so none shows it; a chevron that goes nowhere would promise an action.
  - Poster cards drop the title and year under the frame, as in the reference: the poster art carries the title, and the fallback sets it once in display type.
  - Episode codes read `S1, E2` and durations `1h 38m`, as in the reference.
- Shows have no artwork in the fixtures because the TMDB provider handles movies only (`searchMovies` throws for other kinds) and TVDB is the only show provider. No TVDB key exists, so every show, season and episode shows the fallback. Arrival, Past Lives and Pendia Sample Reel have no TMDB match and show it too.
- Review passes on Home at 1440 (headless Chromium over CDP):
  - Keyboard: a 45-stop tab walk reaches the sidebar, carousel dots and chevrons, every card and card menu; the menu opens on Go to episode, arrows move, Escape returns focus to the trigger.
  - Screen reader tree: headings Home, Continue watching, Next up, Recently added; every link and button has a name.
  - Reduced motion: no transform on a hovered poster, and the carousel jumps instead of scrolling smoothly.
  - Stability: no layout shift between the loading and loaded states.
  - High contrast: the hero and card scrims deepen through `contrast-more:` variants. Checked in code; no high-contrast screenshot was taken.
- Gate at `5e62258`, from the repo root:
  - `bun install --frozen-lockfile`: no changes.
  - `bun run lint`: clean, 9 warnings, all the `!important` overrides #116 added for reduced motion.
  - `bun run check`: 0 errors, 0 warnings.
  - `bun run build`: 4 of 4 tasks.
  - `DATABASE_URL=... bun test`: 1391 pass, 3 skip, 2 fail. Both failures were `EADDRINUSE` on port 3001 in `startTranscoder` (first-run wizard, libraries api), a port race between parallel test files. Rerun alone: 7 pass, 0 fail.
  - `bun test` without `DATABASE_URL`: 812 pass, 602 skip, 0 fail.
