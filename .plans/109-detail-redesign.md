# #109 Redesign: movie, show, season and episode pages

## Summary

The third slice of the redesign PRD (#105), stacked on #108. The four detail pages still use the old layout under `.legacy`: a short backdrop, a poster beside the title, plain rows. This slice puts them on #108's `Hero`, full-bleed, with the page tinted by a blurred copy of the Item's art. Mia's reference screenshots 03 to 06 (Apple TV on macOS) set the structure: title art, a meta line with the rating badge, the overview clamped with a More pill, year, runtime and format badges, the white Play pill with round buttons beside it, and Starring and Director at the right; under it, a season picker heading a row of episode cards, and a translucent bar with Back and the title once the hero scrolls away.

## Acceptance criteria

- [x] All four pages share the hero and ambient background
- [x] Play, Resume and Play from start, favourite, rate and refresh work
- [x] Seasons switch without leaving the show page, and episode rows show progress
- [x] Versions and stored-Version requests work as they do today
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] 1. Server: a detail's children carry their overview, runtime and the caller's progress.
  - Episode rows need runtime and progress, and episode cards the synopsis. Fetching every Episode's detail and progress would cost two requests per row.
  - `ItemDetail.children` becomes `DetailChild`: `BrowseCard` plus `overview`, `durationSeconds` (the first imported Version's) and `progress` (`{ positionSeconds, completed }` or null). Test in `browse.test.ts`.
- [x] 2. Hero for detail pages: `heading="h1"`, an eyebrow (the Show over a Season or Episode), an `aside` slot for credits, and the title's fallback hue when there is no art.
- [x] 3. Ambient background: a fixed, blurred copy of the backdrop (else the poster, else the fallback hue) behind the page, under a wash of the page background.
- [x] 4. Detail bar: Back and, once the hero is out of view, the title on `material`.
- [x] 5. Hero content: meta line with the content rating badge, overview with a More pill that opens the full text, facts with format badges from Version labels, actions, Starring and Director.
- [x] 6. Actions: the white pill (Play, Resume, or Play/Resume the next Episode on show and season pages), round Play from start, favourite, rate (a popover of five stars) and, for admins, a menu with Refresh metadata.
- [x] 7. Show page: season picker and a shelf of episode cards; Season page: the same cards in a grid; Episode page: the season's other episodes as a shelf.
- [x] 8. Versions as rows with resolution, codec, HDR, audio, runtime and size, each playable; Store a Version restyled on `Select` and `Button`.
- [x] 9. Credits as a shelf of people.
- [x] 10. Remove the detail pages from `.legacy`; `DESIGN.md` and the `/design` gallery gain every new component.
- [x] 11. Review and evidence: before and after screenshots at 1440x900 and 390x844, light and dark; hover and focus on episode cards, the open season menu and rating popover; keyboard, screen reader, reduced motion and high contrast passes.
- [x] 12. Gate from the repo root, results below.

## Notes

- Branch `feat/109-detail-redesign` in `.worktrees/media`. Mia merged #118 into `feat/107-design-system` (merge commit `1bed310`, the same tree as `feat/108-browse-redesign` at `fe16ca6`) before this slice began, so the branch starts from `origin/feat/107-design-system` and the PR targets `feat/107-design-system`. A PR into the already merged `feat/108-browse-redesign` would land nowhere.
- Before screenshots are the `feat/107-design-system` set taken at `65867af` against the same fixtures, from #108's run.
- Decisions made without anyone to ask:
  - The children fields are the smallest server change the episode rows need, per the brief's rule for missing data.
  - Favourite, rate and refresh have API procedures but no web controls yet. This slice adds the controls on the existing procedures, with no server change.
  - Refresh metadata shows for admins, as Settings does in the shell. It sits in a `…` menu, which hides for viewers because it would be empty.
  - Rating is five stars, saved as 2 to 10 on the API's 0 to 10 scale. A rating set elsewhere shows rounded to the nearest star.
  - Format badges come from the Version labels the scanner writes (`4K`, `HDR10`, `HDR10+`, `HLG`, `Dolby Vision`). The API carries no subtitle or Atmos data, so CC, SDH, AD and Atmos badges stay out.
  - The overview's More opens a dialog with the full text, as the reference does, so the bottom-anchored hero never grows into the bar.
  - Episode cards play on click, like Home's landscape cards. Their `…` menu leads to the episode page.
  - The show page lists its seasons' episodes by loading each Season's detail in parallel, so the hero can name the next episode across seasons. Shows rarely have more than a handful of seasons.
  - The ambient background tints the page in light mode instead of darkening it, so light pages stay light.
  - Trailers, Bonus Content and Related stay out: Pendia has no data for them.
  - The detail bar turns solid once half the hero has scrolled away, watched by a sentinel at the hero's middle. Waiting for the whole hero to leave never fired on short pages, where the hero's bottom can't reach the bar.
  - Refresh metadata reloads the page on the `library.changed` event the metadata job already publishes. An earlier commit made the queue publish `job.progress` too; it was reverted, since nothing else needed it and the server stays as it was.
  - The More pill sits beside the clamped paragraph, not inside it, and the last line fades under it with a mask, so no opaque box cuts the text.
  - A Show's facts read `2022 · 2 seasons`; a Season's meta line counts its episodes.
- Fixture artwork: shows now have artwork, because a TVDB key appeared in the dev database's settings during this slice. This slice did not set it. Arrival, Past Lives and Pendia Sample Reel still have no TMDB match and show the fallback.
- Found and fixed during review: the rating's `aria-checked` followed the hover preview, not the saved rating; arrow keys stepped from the preview, so ArrowRight did nothing on an unrated item; the phone action row clipped the `…` button; the More button's name read `MORE` from its CSS uppercase.
- Evidence in `/home/mia/.cache/pendia-tmp/media`: screenshots in `shots/before109` and `shots/after109`, uploaded per `shots/urls-109.tsv`; passes in `passes109/` (keyboard walks of Dune and Severance, accessibility tree with no unnamed controls, reduced motion, layout stability).
