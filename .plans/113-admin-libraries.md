# #113 Redesign: admin libraries and policies

## Summary

Libraries, library detail and the Stored Versions policy move into the admin shell from #112, as `AdminPage`s of `FormGroup`s. The list shows each library's medium, folder count, scan state and last scan; a row pushes into the library. A library is a grouped form: name and medium, its folders, its scan, its stored-version policy, and Delete. Adding or changing a folder opens a folder browser that walks the server's folders from `/`, one level at a time, with a breadcrumb and a typed path, and shows what a scan of the current folder would find before you save. The server gains an admin-only folder listing that never follows symlinks, and exposes the scan preview from #117.

## Acceptance criteria

- [x] Creating, editing and removing libraries and roots works as it does after #102, in the new design
- [x] Adding or repointing a folder offers the folder browser, and it shows what a scan would find before you save
- [x] Only admins can list folders, and the listing never follows symlinks
- [x] Policies edit in the new form layout
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] Server: `GET /folders` lists a folder's direct child folders for `manage-libraries`, from `/` by default, never following symlinks and hiding dot-folders, with tests
- [x] Server: `GET /folders/preview` runs `previewScan` for `manage-libraries`, stopping when the request aborts, with tests and the OpenAPI paths
- [x] Web helpers: breadcrumbs, preview wording, overlap check and last-scan time in `$lib`, with unit tests
- [x] `FolderBrowser`: dialog on desktop, full-height sheet on phone; breadcrumb, typed path, folder list and live scan preview
- [x] `FolderFields` becomes the Folders panel: rows with Change and Remove, Add folder, removal alert, inline refusals
- [x] Libraries list, New library and library detail as `AdminPage`s; scan and delete move into the detail page; `ScanState` shared with Overview
- [x] `PolicyEditor` in form groups, behaviour unchanged
- [x] Drop libraries from the legacy wrapper; `DESIGN.md` documents the new components
- [x] Screenshots before and after, keyboard, screen reader, reduced motion and high contrast passes
- [x] Full gate

## Notes

- No browse root is configured anywhere in the server (`rg` for browse or media root env and settings found none), so the listing starts at `/`.
- The listing and preview live at `/folders` and `/folders/preview` rather than under `/libraries/...`, so they never compete with `/libraries/{id}`. They sit in `libraryProcedures`, so the client calls `client.libraries.folders` and `client.libraries.preview`.
- A relative path fails input validation (BAD_REQUEST) before the handler runs. `previewScan` keeps its own guard.
- Every path component is `lstat`ed on the way down, so a symlink anywhere in the requested path is refused, not only at its end. Dot-folders are hidden, as the issue asks.
- An unreadable folder answers BAD_REQUEST "Pendia can't read this folder. Check its permissions." The `FORBIDDEN` code stays reserved for the permission check, so the two never read alike.
- The preview stops walking when the request aborts. The browser previews the folder you are in after a short pause and aborts on every move, so walking through `/` or `/usr` on the way down never leaves a walk running.
- Last scan comes from the scan run's id: job ids are UUIDv7, so the run id carries its start time. No server change.
- On a saved library, each folder change saves at once, like System Settings: the browser's button adds or repoints, and Remove asks first. The name saves with its own Save button. A new library keeps a draft until Add library. Both send the whole root list with ids, exactly as before, so the server's revision checks are untouched.
- Scan now, rename and delete move from list rows into the library page. The list rows only navigate, like every other admin list.
- Add folder starts at the parent of the library's last folder when it has one, else at `/`; Change starts at the folder itself.
- Medium can't change after creation (the update API has no medium), so it is a read-only row on a saved library.
- When the listing fails (missing, not a folder, unreadable, symlink), the list names the problem and the preview region stays empty, so nothing is said twice. Typed paths lose repeated and trailing slashes before they are sent.
- The admin shell needed a `Tooltip.Provider`; the folder browser's path button is the first admin tooltip.
- With #114 landed, no screen is on `legacy`, so this slice deletes `legacy.css` and its alias table.
- Gate at `82438a7` (after merging `feat/107-design-system` at `fc86475`): frozen install, lint (the base's 9 `app.css` warnings), check 0/0, build, `bun test` with the database 1623 pass, 3 skip, 0 fail, and without it 1012 pass, 632 skip, 0 fail.
