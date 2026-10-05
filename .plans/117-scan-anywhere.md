# #117 Find media at any depth, whatever the folder layout

## Summary

A Library's medium decides where its media shows up and how metadata is fetched. It no longer dictates the folder layout. The scanner walks every video file under every root and works out what each file is from its name and the folders above it. A root can be one show or one movie. Episodes can sit in episode folders, without a season folder, or loose in a folder of several shows. Movies can sit loose in a root or in a folder of several titles. A read-only preview reports what a scan of one folder would find, for the folder browser in #113.

Today none of Mia's Sonarr episodes are found: Sonarr gives every episode its own folder, `Show (2020) [tvdbid-1]/Season 01/Show (2020) - S01E01 - Title [WEBDL-1080p] [GROUP]/file.mkv`, and the scanner wants exactly `Show/Season N/file`. That shape alone is 5,492 of the 7,593 Sonarr video files.

## Acceptance criteria

- [ ] A Shows root pointed at one show's folder finds that show, with its seasons and episodes
- [ ] Episodes without a season folder, under extra folders, or loose in a folder of several shows are found, with the right show, season and episode
- [ ] Every episode token form in the issue parses, including multi-episode files
- [ ] A Movies root pointed at one movie's folder finds that movie
- [ ] Loose movie files in one folder become one movie each, titled without release tokens
- [ ] Two single-show roots in one Library stay separate, and the same show in two roots still merges into one Show
- [ ] Rescanning a Library with today's layouts changes nothing, proven by a test that scans the existing fixtures before and after
- [ ] The read-only preview function reports counts, examples and an empty-folder reason, with tests
- [ ] The repository gate is green

## Identity decision

An Item is found by `(library, Item folder, title key)`, stored as the existing `items.canonical_folder` plus a new `items.title_key text not null default ''`.

- **Item folder** (`canonical_folder`): the folder under a root that holds the Item, as today. It is `.` when the root itself is the Item. It stays the anchor for colocated `.pendia` artwork and subtitles.
- **Title key**: empty when the Item folder is below the root and names one title. That is every Item that exists today. Otherwise it is the normalised title and year, such as `breaking bad (2008)`: for an Item at the root itself, and for a loose file in a folder that holds several titles.

Why this shape:

- **Today's Items keep their identity with no data rewrite.** The migration adds a column whose default is the value every existing row needs. The lookup for a folder Item is the same `(library, folder)` pair as today, with an empty key.
- **Root-anchored Items cannot collide.** Two single-show roots both have folder `.`, but their keys come from the root folders' names, so `.`+`breaking bad (2008)` and `.`+`the wire (2002)` are two Shows. Loose files sharing `Movies/` get `dune (2021)` and `arrival (2016)`.
- **Merges still happen.** The same relative folder in two roots has the same folder and key, as today. Two roots that are both `Breaking Bad (2008)` have the same key. A show folder in one root and the same show as a root of its own have different folders, so a scan that finds no exact match looks for one existing Item with the same title and year, or with the same provider tag, and merges into it. A folder Item only falls back onto titled Items, never onto another folder Item, so `4K/Dune (2021)` and `HD/Dune (2021)` stay apart as today.
- **Merged Items stay stable.** After the exact lookup and the webhook provider ids, a scan looks for the Item that already owns the group's Files, by root and path. So the root-anchored half of a merged Show finds it again on every rescan.
- **Colocated assets stay writable.** An Item's folder is its folder in its home root. A scan that finds an Item under a different folder or key moves it there only when its group holds Files in that Item's home root. The same rule applies to Seasons and Episodes, so two halves of a merged Show do not flip its folders back and forth. Artwork names carry the artwork id, so two Items sharing a folder never collide. A `.` folder writes to `<root>/.pendia/artwork`.

Rejected: putting the key into `canonical_folder` breaks the artwork anchor, and a folder that is a file path cannot hold `.pendia`. Identifying every Item by title alone merges `4K/Dune (2021)` with `HD/Dune (2021)` and breaks today's Items.

## Recognition rules

Both mediums share the release-name parser and the title key in `mediums/video-common/titles.ts`.

**Structural folders** belong to the Item above them: season folders (`Season 1`, `Season 01`, `S01`, `Series 1`, `Specials`), disc folders (`Disc 1`, `CD1`, `DVD 1`), and for shows episode folders, whose name carries a full episode token. Movies treat disc and part folders as structural. A file's Item folder is its directory with trailing structural folders removed, or `.`.

**Shows.** Episode numbers come from the file name: `S01E02`, `s1e2`, `S01E02E03`, `S01E02-E03`, `S01E02-03`, `S01.E02`, `1x02`, and the episode-only forms `E02`, `Ep 02`, `Episode 2`. The season is the token's, else the nearest season folder's, else 1. The show is the Item folder. A file with no season folder between it and the Item folder is loose. A loose file whose title before the token differs from the folder's title is its own show, keyed by that title, unless the folder's name carries a year or a provider tag. A folder name like `Show (2020) [tvdbid-1]` always names one title.

**Movies.** The movie is the Item folder when its name carries a year or a provider tag, or when the file's title matches the folder's. Otherwise the file is its own movie, titled from its name with release tokens stripped. At the root, the folder name is the root's.

**Deliberate changes to paths accepted today.** Two shapes the scanner accepts today are wrong today, and the issue asks to fix them. A disc folder under a movie folder, `Movie (2000)/CD1/file`, is a movie called `CD1` today and becomes part of `Movie (2000)`. A folder without a year holding several titles, `Movies/Dune.2021.mkv` beside `Movies/Arrival.2016.mkv`, is one movie called `Movies` today and becomes two. Every other accepted path keeps its Item. The match report measures how many real paths change Item.

## Scan jobs

A directory scan's `path` is an Item folder, and the scan writes every Item at that folder: one for a show or movie folder, several for loose files, and the root's own Items for `.`. It walks the folder and its structural subfolders in every root, not the whole subtree. A scan job at `.` with neither changes nor `reconcileMissing` stays the Library scan that fans out. Every other job is a directory scan, `.` included. The watcher's claim says which kind it is.

Reconciliation removes a File the walk missed when the File's Item folder is the scan's. A File of the same Item outside the scan's folder goes only when it is gone from disk, so the two halves of a merged Show do not delete each other's Versions.

## TODOs

- [x] Plan, posted on #117.
- [x] Capture what the current scanner writes for today's layouts, as a fixture for the identity test.
- [x] Shows recognition at any depth, with table-driven tests of real names.
- [x] Movies recognition at any depth, with table-driven tests of real names.
- [x] `items.title_key` and its migration; directory scans by Item folder and title key; fan-out, repair, webhooks and the watcher by Item folder. Tests for the five identity invariants and the migration.
- [x] Read-only scan preview, with tests.
- [x] Docs: `CONTEXT.md`, the server README layouts, the medium spec, an ADR for the identity decision.
- [x] After match report, and rule fixes for real names still missed.
- [x] Full gate, recorded here.

## Notes

- Before match report (`/home/mia/.cache/pendia-tmp/scan2/before.md`): Sonarr 0 of 7,593 video files recognised. Radarr 494 of 494, as 461 movies.
- The preview is a server function. #113 adds the admin call that exposes it.
- After match report (`/home/mia/.cache/pendia-tmp/scan2/match-report.md`): Sonarr 7,593 of 7,593 video files recognised, as 290 shows with 7,455 episodes. Radarr 494 of 494, as the same 461 movies; all 494 keep their Item. Nothing is left unrecognised, so no rule fixes were needed for real names.
- Radarr per-file folders (`Movie (2018) [tmdbid-1]/Movie (2018) [tmdbid-1] - [Remux-2160p] - [GROUP]/file.mkv`) stay Items at the inner folder. Folding them into the outer folder would move existing Items, which invariant 1 forbids.
- For shows, only a top-level `extras` folder is an extras folder. `Show/Featurettes/clip.mkv` counts as unrecognised, not as an extra. This predates #117.
- Gate at `0cd60d7`, merged with `origin/main` (already up to date): `bun install --frozen-lockfile`, `bun run lint`, `bun run check` and `bun run build` pass. `bun test` with `DATABASE_URL`: 1,463 pass, 3 skip (S3), 0 fail. Without it: 869 pass, 615 skip, 0 fail.
