# #37 Admin UI: wizard, libraries, users, groups, settings

## Summary

Build the admin UI in `apps/web` on the typed oRPC client from `apps/web/src/lib/api.ts`. A first-run wizard creates the admin and the first library and scans it. Screens cover libraries (add, edit, scan now, status), users (create, invite, revoke sessions, bitrate cap, content-rating ceiling, library access), groups and their permissions, and settings (proxy trust, the artwork auth toggle, provider keys). Screens are functional and consistent; visual design is a later effort.

The auth and libraries services already hold most of the behaviour. Where a screen needs a procedure the router does not have, add a thin procedure over those services, plus the small service reads and writes that no caller needed yet: user listing, group listing, group permission edits, per-user settings, library access rows, an auth settings writer, provider keys and a library scan status.

Read `CONTEXT.md`, `docs/adr/0010-orpc-api-transport.md`, `docs/spec/auth.md`, `apps/server/README.md`, `apps/server/src/api`, `apps/server/src/auth`, `apps/server/src/libraries/service.ts` and `apps/web`.

## Acceptance criteria

- [x] From a fresh database, the wizard reaches a scanned library without touching the API by hand.
- [x] Every admin procedure has a screen, and permission-denied states render.
- [x] One smoke test drives the wizard.

## TODOs

- [x] 1. Add the admin service reads and writes the screens need.
  - `apps/server/src/auth/admin.ts`: `listUsers` and `listGroups` (both need `manage-users`), `setGroupPermissions` on custom groups only, `readUserSettings` and `writeUserSettings` for the bitrate cap and content-rating ceiling, `setLibraryAccess` for a user or a group row, and `listLibraryAccess` for one user. Reuse `requirePermission`, `requireAdmin`-equivalent checks and `AuthError` codes rather than inventing new ones.
  - `apps/server/src/auth/accounts.ts`: export `isSetupComplete` over the existing private `setupClosed`, so the wizard can ask whether setup is still open.
  - `apps/server/src/auth/settings.ts`: add `artworkRequiresAuth` to the read with a `false` default, and `writeAuthSettings` requiring `manage-server`, which merges a patch into the `auth` row and re-reads it so invalid settings are rejected before they land. Only `trustedProxyAddresses` and `artworkRequiresAuth` are writable in this slice.
  - `apps/server/src/providers/keys.ts`: the `providers` settings row holds `{ keys: { <name>: <secret> } }`. `listProviderKeys` returns names only, never values. `setProviderKey` and `removeProviderKey` require `manage-server`.
  - `apps/server/src/libraries/service.ts`: `libraryScanStatus` returns the library's scan job counts by state and the newest job's state and error, for a caller holding `manage-libraries`.
  - Validation: colocated `bun test` files on disposable Postgres cover each function's happy path and its permission denial, the bigint bitrate round trip, the deny-wins library access row, the rejection of built-in group edits, invalid proxy addresses leaving the stored settings unchanged, and provider key values never appearing in a read. Server `check` and `build` pass.

- [x] 2. Expose those services as thin procedures on the router.
  - `apps/server/src/api/admin.ts`: `setup.status` (unauthenticated, `{ complete }`), `users.list`, `users.get`, `users.create`, `users.sessions`, `users.revokeSession`, `users.setGroups`, `users.setOverride`, `users.setSettings`, `users.setLibraryAccess`, `groups.list`, `groups.create`, `groups.setPermissions`, `settings.get`, `settings.update`, `settings.setProviderKey`, `settings.deleteProviderKey`. Add `libraries.scanStatus` to `apps/server/src/api/libraries.ts`.
  - Schemas go in `apps/server/src/api/schema.ts` as identity schemas over plain JSON, matching the existing style. Instants stay database text. The bitrate cap crosses as a nullable integer and the service converts to bigint. `settings.get` returns the trusted proxy addresses, the artwork toggle, whether OIDC is configured and the provider key names, and never a secret.
  - Mutations use `authenticatedMutation`; reads use `authenticated`; `setup.status` uses `base`. Document every procedure and its REST route in `apps/server/README.md`, including the artwork toggle having no enforcement point yet.
  - Validation: `apps/server/src/api/admin.test.ts` on disposable Postgres drives the procedures over the typed client and REST, and asserts 401 without a credential, 403 for a user without the permission, 404 for an unknown id, 409 on the last-admin conflict, and that `settings.get` omits secrets. `openapi.test.ts` still passes. Server `check` and `build` pass.

- [x] 3. Add the web app shell: client, session, errors and the admin layout.
  - `apps/web/src/lib/api.ts` keeps its signature; add `$lib/session.svelte.ts` for the `me` load, `$lib/errors.ts` to map an oRPC failure to a code and a sentence, and `$lib/resource.svelte.ts` for the load, error, reload pattern every screen uses.
  - `apps/web/src/routes/admin/+layout.svelte` and `+layout.ts`: `prerender = false`, `ssr = false`, a nav with libraries, users, groups and settings, the signed-in user, and a sign-out action over `POST /api/auth/logout`. An unauthenticated load goes to `/login`; an incomplete setup goes to `/setup`.
  - `apps/web/src/routes/login/+page.svelte` posts to `/api/auth/login` with a stable device id kept in local storage.
  - A shared `PermissionDenied` and an error panel render whenever a procedure answers `FORBIDDEN` or `UNAUTHORIZED`, so every screen has the same denied state.
  - `apps/web/vite.config.ts` proxies `/rpc`, `/api` and `/healthz` to `http://127.0.0.1:3000` so `bun run dev` talks to a local api role on one origin.
  - Validation: `bun run --cwd apps/web check` and `build` pass, and the landing page still prerenders.

- [x] 4. Add the first-run wizard.
  - `apps/web/src/lib/wizard.ts` holds the flow as plain TypeScript: read `setup.status`, create the admin over `POST /api/auth/setup`, log in over `POST /api/auth/login`, create the first library over `libraries.create`, start `libraries.scan`, then poll `libraries.scanStatus` until the scan settles. It takes the origin, a `fetch` and a client factory so a test can drive it.
  - `apps/web/src/routes/setup/+page.svelte` is a thin shell over that module: admin account, then first library, then the scan with its live status, then a link into `/admin`. A completed setup redirects to `/login`.
  - Validation: `bun run --cwd apps/web check` and `build` pass. The smoke test lands in TODO 8.

- [x] 5. Add the libraries screens.
  - `apps/web/src/routes/admin/libraries/+page.svelte`: the list with name, medium and root path, an add form, inline rename, scan now, and the scan status from `libraries.scanStatus` with a refresh. Delete stays available because the procedure exists.
  - Empty, single and many states share one geometry, and a failure renders the shared error panel.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 6. Add the users screens.
  - `apps/web/src/routes/admin/users/+page.svelte`: the list, a create form and an invite form that posts to `/api/auth/invites` and shows the one-time token once.
  - `apps/web/src/routes/admin/users/[id]/+page.svelte`: sessions with revoke, the bitrate cap and content-rating ceiling, group membership, per-permission overrides with an inherit choice, and per-library access with allow, deny and inherit.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 7. Add the groups and settings screens.
  - `apps/web/src/routes/admin/groups/+page.svelte`: the list with each group's permissions, a create form, and permission editing for custom groups with built-ins shown read-only.
  - `apps/web/src/routes/admin/settings/+page.svelte`: trusted proxy addresses, the artwork auth toggle, and provider keys with add and remove. Values are write-only; the screen shows which keys are set.
  - Validation: `bun run --cwd apps/web check` and `build` pass.

- [x] 8. Add the wizard smoke test and run the final gate.
  - `apps/server/src/api/wizard.test.ts` starts the `all` runtime on a disposable database with a real movie fixture, drives `runFirstRunWizard` from `apps/web/src/lib/wizard.ts`, and asserts an admin exists, the library exists, the scan completes and one Item with its Versions landed. It follows the existing precedent of a server test importing the web client.
  - Check every acceptance criterion against its test and record the real results below.
  - Validation: from the repo root `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55437/pendia bun test` and `env -u DATABASE_URL bun test`. Remove the disposable Postgres container when the review ends.

## Notes

### What landed, per TODO

- TODO 1 as `c43a6b0`: `auth/admin.ts` (`listUsers`, `listGroups`, `getUserAccess`, `setGroupPermissions`, `writeUserSettings`, `setLibraryAccess`), `isSetupComplete`, an exported `requireAdmin`, `artworkRequiresAuth` plus `writeAuthSettings` over an extracted `parseAuthSettings`, `providers/keys.ts` and `libraryScanStatus`. Tests: 45 pass, 0 fail, 289 expects on disposable Postgres, covering permission denial per function, the bigint cap round trip, deny-wins library access proven through `checkPermission`, built-in group rejection, an invalid proxy write leaving the row unchanged, and no provider key value in any read.
- TODO 2 as `1d4ea5a`: `api/admin.ts` with the setup, users, groups and settings procedures, `libraries.scanStatus`, the new schemas, and the README API tables. Tests: `bun test apps/server/src/api` 66 pass, 0 fail. `getUserAccess` replaced the planned `readUserSettings` and `listLibraryAccess`, so the per-user screen loads in one round trip. The four `users.set*` mutations answer the full `UserAccess` for the same reason. Service inputs widened to `readonly` arrays because Effect decodes arrays as readonly.
- TODO 3 as `5a44a25`: `$lib/errors.ts`, `$lib/auth.ts`, `$lib/resource.svelte.ts`, `$lib/admin.css`, `Failure.svelte`, the `/admin` layout guard and landing, `/login`, and a dev proxy for `/rpc`, `/api` and `/healthz`. `biome.json` gained one override switching `noUnusedImports` and `noUnusedVariables` off for `.svelte` files: Biome parses only the script block, so every name used in a template reads as unused. Formatting and import order still apply.
- TODO 4 as `aad1ddd`: `$lib/wizard.ts` and `/setup`. Proven end to end before the smoke test existed: a scratch run against `startPendia("all")` on a disposable database reached `counts: { queued: 0, running: 0, completed: 2, failed: 0 }` with one Item, Alien 1979, and two Versions.
- TODO 5 as `565d466`: `/admin/libraries`, and `waitForScan` moved to `$lib/scan.ts` taking a client, so the screen and the wizard share one poller.
- TODO 6 as `12d82a7`: `/admin/users` and `/admin/users/[id]`, plus `resource.set`. First pass imported the server's permission tuple into the web bundle by relative path, which breaks the documented boundary that the web app imports the router type only; replaced with `$lib/permissions.ts`, where the union comes from the client's own group output type and a `satisfies Record<Permission, number>` makes a divergence a build error. Two other defects fixed in the same round: the per-user resources now reload when the route id changes, and a bitrate cap that is not a whole positive number is rejected at the control instead of serialising to `null` and silently clearing the cap.
- TODO 7 as `699d2f3`: `/admin/groups` and `/admin/settings`. The provider key value field is a password input with autocomplete off.
- TODO 8 as `1f38606`: `api/wizard.test.ts`, 1 pass, 12 expects, and one formatting repair in `providers/keys.ts` that the per-file checks had missed.

### Final gate, from the repository root

| Command | Exit | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 0 | clean |
| `bun run lint` | 0 | 140 files, no fixes needed |
| `bun run check` | 0 | 6 of 6 tasks |
| `bun run build` | 0 | 4 of 4 tasks |
| `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55437/pendia bun test` | 0 | 519 pass, 0 fail, 1751 expects, 38 files |
| `env -u DATABASE_URL bun test` | 0 | 344 pass, 175 skip, 0 fail, one skip banner |
| `env -u DATABASE_URL CI=true bun test apps/server/src/api/wizard.test.ts` | 1, expected | `DATABASE_URL is required for database tests in CI.` |

### Review round at `857c67a`

Pullfrog and Codex raised five threads against `857c67a`, which fall into three
fixes. The worktree held no uncommitted work when this round started: the
previous round's fix was already committed and pushed as `857c67a`, and these
threads are the review of that head.

- `c37fe02`: both edit continuations now check `editingId === row.id` as well as
  the draft. Cancel is live during a save, so an abandoned editor's answer used
  to close or fail whichever editor was open next.
- `28dea0a`: `waitForScan` folds `timeoutMs` and the caller's signal into one
  `AbortSignal`, passes it to the status request, checks it before each round and
  wakes from the wait on abort. Previously a stalled request outlived both.
  `apps/web/src/lib/scan.test.ts` covers it: no request after an abort, and a
  stalled request ended by the deadline. Both fail against the old poller, the
  second by hanging.
- `3327af3`: `apps/web/src/routes/+error.svelte` renders the shared failure panel
  with a Try again action, so a failed guard load no longer lands on SvelteKit's
  fatal page.

The two screen fixes carry no test. `apps/web` has no component test harness, and
adding one is a larger change than these findings ask for.

### Macroscope round at `d74ef72`

Macroscope raised three threads. One is this branch's, two are not.

- `56e0acc`: `writeUserSettings` now rejects a bitrate cap above
  `Number.MAX_SAFE_INTEGER`. The playback planner reads the bigint column with
  `Number()` and throws `Invalid playback settings` for anything larger
  (`apps/server/src/playback/planning.ts:200`), so this branch's writer could
  store a value that broke every later playback plan for that user. The existing
  rejection loop in `apps/server/src/auth/admin.test.ts` gained the value.
- `apps/server/src/libraries/scan.ts` is untouched by this branch, so the two
  findings against it belong to the merged shows medium slice. Filed as #67
  (show versions stored without a keyframe index) and #68 (overlapping episode
  ranges in one scan can violate the range exclusion constraint).

The matching read-side note, `Number()` on a stored cap larger than the writer
now allows, is rejected: with the writer bounded, nothing in the application
produces that row.

### Codex round at `696b67a`

- `e418a04`: the libraries delete confirmation now checks `confirmingId === row.id`
  in both continuations, and opening a confirmation clears the previous failure.
  Other rows' Delete buttons stay live during a delete, so the answer used to
  land on whichever confirmation was open.
- `e8887d4`: `removeFailures[name]` on the settings screen read
  `Object.prototype.constructor` for a key named `constructor`, which the name
  pattern accepts. The template checks `Object.hasOwn` now.

Neither carries a test, for the same reason: `apps/web` has no component test
harness.

### Rebase on the change-detection slice

`#61` merged while this round was in review, so the branch rebased on
`origin/main` at `368d6ce`. Conflicts resolved in favour of the merged code,
keeping this branch's addition on top:

- `apps/server/src/db/schema/operations.ts`, `apps/server/src/libraries/jobs.ts`
  and three test files: a scan job payload now carries the merged `changes` and
  `reconcileMissing` alongside this branch's `runId`.
- `4ce4e5d`: `apps/server/src/libraries/changes.test.ts` asserts the fan-out
  payload exactly, so it gained the run id. It was the one failure on the
  rebased tree.

The rebase also dropped the duplicate commit line that the earlier ancestry
merge had carried, so the branch is 45 commits rather than 71. `60642a3` is the
ancestry merge that keeps the published history, so the push stayed a
fast-forward.

### Gate after the review round, from the repository root

Run on the rebased tree at `4ce4e5d`.

| Command | Exit | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 0 | 116 installs across 219 packages, no changes |
| `bun run lint` | 0 | 187 files, no fixes applied |
| `bun run check` | 0 | 6 of 6 tasks, svelte-check 0 errors 0 warnings |
| `bun run build` | 0 | 4 of 4 tasks |
| `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55437/pendia bun test` | 0 | 723 pass, 0 fail, 3029 expects, 54 files |
| `env -u DATABASE_URL bun test` | 0 | 428 pass, 295 skip, 0 fail |

### Codex round at `87d57fa`

Three findings, all this branch's own screens, all fixed.

- `4a7d04d`: the libraries screen gives each library its own status ticket. A
  refresh used to replace the whole `statuses` map, so a batch that started
  before Scan now could land after `waitForScan` reported the run settled and
  put the older reading back, where it stayed because polling had ended. A
  refresh now skips a row whose scan is in flight, and a refresh answer that
  arrives after `scanNow` claimed the ticket is dropped.
- `01bd426`: `resetRouteState` resets the per-visit mutation queue, so a save
  started on the next user no longer waits behind the abandoned visit's
  request. The abandoned request still runs and its continuations still no-op
  through `currentVisit`.
- `b354609`: the group checkboxes and Save are disabled for a disabled account,
  with one sentence saying why. `setUserGroups` selects its target with
  `isNull(users.disabledAt)` at `apps/server/src/auth/permissions.ts:177`, so
  Save could only ever answer `NOT_FOUND` and claim the displayed user does not
  exist. The server rule stays; the screen reflects it. Settings, overrides and
  library access do accept disabled users and are untouched.

None of the three carries a test. `apps/web` still has no component test
harness, and these are screen-state fixes.

### Macroscope round at `87d57fa`

Four findings, none of them this branch's. `apps/server/src/libraries/changes.ts`,
`webhooks.ts` and `scan.ts` are absent from `git diff origin/main...HEAD`, and
the only change to `jobs.ts` is `runId: job.id` on the enqueued payload. All
four read as real against the merged slices, so they are filed rather than
dropped:

- #69: a cross-show move deletes the destination show's whole subtree, and the
  webhook validator only compares library ids, so the move reaches that branch.
- #70: show reconciliation deletes stale `files` rows before it reads
  `versions.origin`, so a stored Version survives with no files. The movie
  reconciler reads the origin first.
- #71: reconciliation trusts a walk taken before the write lock, so a file
  recreated during the probe pass is deleted as missing.

### Macroscope round at `55ec9c5`

One finding, against `01bd426` from the round above, and it was right.

- `2790060`: the mutation queue is keyed by the target user instead of by the
  visit. Resetting the queue on a route change dropped ordering between two
  writes to the same user, so an admin who left user A and came back while the
  first save was still in flight could have the stale write commit second and
  leave the database holding the old value under a screen showing the new one.
  The shared queue it replaced had the opposite fault, which is what `01bd426`
  was for: a save on B waited behind an in-flight request for A. One chain per
  target user answers both. Macroscope asked for the shared chain back; that
  reinstates the cross-user coupling, so the fix went to the ownership boundary
  instead.

### Codex round at `f993cd4`

One finding, in the scan-status code `4a7d04d` had just touched.

- `c04e04a`: `scanNow` clears a stale status read error when the scan starts,
  not when it settles. The cell shows `scanFailures` first and `statusFailures`
  second, so after a failed refresh an admin who started a scan watched the old
  read error for the whole run while live progress was being written
  underneath it. The settle-time clear went with it: nothing can put a failure
  back on a row whose scan holds the ticket.

### Codex round at `30638e9`

Four findings. Three were real and are fixed; one is rejected.

- `3f33faf`: the libraries scan cell reads the run's counts instead of
  `latest.state`. `libraryScanStatus` picks `latest` by descending job id and
  job ids are UUIDv7, so `latest` is the newest child of a fanned-out run while
  the worker claims the oldest first. The cell said "Queued" for almost the
  whole scan.
- `f1ca568`: the wizard offers Check again when a status request fails
  mid-scan. The poller stops on that failure, but the screen kept saying
  "Scanning the library." and the only retry was in a branch that needs no
  status at all.
- `258fde5`: a failed invite no longer erases the token already on screen. The
  token is shown once and cannot be read again, so clearing it before the next
  request could take a live invite's only copy.
- Rejected: a session row keeps saying "Live" once its expiry passes with the
  page left open. The Expires column beside it carries the exact instant, so
  the fact is on screen rather than hidden, and revoking a session that has
  expired but not been revoked is an ordinary successful revoke
  (`apps/server/src/auth/sessions.ts:245-261`), not an error. A ticking clock
  for one derived label is surface this screen does not need.

### Codex round at `50d5ef5`

Two findings. One fixed, one already filed.

- `6d6fce7`: revisiting a user reads behind that user's queue. A → B → A while a
  write to A was in flight let the revisit read pre-mutation state, and the
  write's own continuation was then dropped by the visit check, so the screen
  stayed older than the database until a manual reload.
- Deferred to #65: expression indexes on `jobs` for the `payload->>'libraryId'`
  and `payload->>'runId'` scan-status reads. That issue was filed out of this
  slice for the reason it repeats here, that the index strategy for the queue
  table belongs with the queue rather than with a screen, and a migration on
  this branch would collide with the other slices in flight.

### Codex round at `4786ec2`

One finding, in the recovery path `f1ca568` had just added.

- `e6e2b0c`: the wizard's no-reading recovery follows the run that was started.
  A first status request that failed left `runId` set and `status` undefined,
  and the button there called `rescan`, which enqueued a second full scan
  behind the first on the shared library concurrency key. It resumes the known
  run now and only starts a new one when no run id came back.

### Codex round at `ced2e34`

One finding, the libraries-screen sibling of `e6e2b0c`.

- `5da9e71`: the libraries screen keeps a per-row run id, so a row whose polling
  failed offers Check again and resumes that run. It used to hold the job id in
  a local, lose it to the failure, and leave Scan now as the only action, which
  enqueued a second full scan behind the first on the shared library
  concurrency key. The run id is dropped once the run settles, so the next
  press starts a fresh scan. These were the only two places that start one.

### Macroscope round at `d078677`

One finding, on the libraries add form.

- `c1c7364`: adding a library says so. `resource.reload` catches its own
  failure and resolves, so a failed reload after a successful create left the
  admin looking at a generic server error where the list was, with nothing
  saying the library existed. Re-entering it would have made a duplicate,
  since `createLibrary` inserts unconditionally and `rootPath` carries no
  unique constraint. The form now reports what it created. Rename and delete
  swallow a reload failure the same way and keep it: re-running a rename is
  harmless and re-running a delete answers NOT_FOUND.

### Codex round at `9c8a3cc`

Three findings, all real.

- `5918ff0`: a queued read is guarded on its visit. `6d6fce7` queued the
  revisit reads by target, but the resources read the reactive route id when
  they run, so a callback queued for one user could fetch another outside that
  user's queue and land a pre-write snapshot.
- `51028ef`: `deviceInfo` tolerates a browser that denies storage. The old
  guard covered a missing `localStorage`, not a denied one, and the throw took
  the whole sign-in with it because it runs before the login request. The
  session itself is a cookie, so this rescues a storage-denied context rather
  than a cookie-denied one.
- `d8c4e54`: `writeUserSettings` rejects a NUL in the ceiling instead of
  letting Postgres turn it into a 500. The repository already guards its other
  text inputs this way, in `normalizeName`, `normalizeRoot` and
  `setProviderKey`. This one carries a test: the existing rejection loop in
  `admin.test.ts` gained the value, and it fails against the unfixed writer.

### Gate after the Codex round, from the repository root

Run at `b354609`, against the baseline recorded at `87d57fa`. The gate at
`2790060` is identical on every line.

| Command | Exit | Result |
| --- | --- | --- |
| `bun run lint` | 0 | 187 files, no fixes applied |
| `bun run check` | 0 | 6 of 6 tasks, svelte-check 0 errors 0 warnings |
| `bun run build` | 0 | 4 of 4 tasks |
| `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55437/pendia bun test` | 0 | 723 pass, 0 fail, 3029 expects, 54 files |
| `env -u DATABASE_URL bun test` | 0 | 428 pass, 295 skip, 0 fail |

### Decisions and deviations

- Decisions I made because nobody was available to ask:
  - Invites keep their existing route. `POST /api/auth/invites` already creates invites, and the README documents why setup, login, logout and invites live on the auth handler. The users screen calls that route rather than duplicating it as a procedure.
  - The smoke test drives `apps/web/src/lib/wizard.ts` against a live runtime rather than a browser. The repository has no browser test infrastructure, and adding Playwright and a browser download to CI is a bigger change than this issue asks for. The Svelte wizard screen is a thin shell over that module, so the covered path is the real one. This is a deliberate deviation from a full end-to-end browser test.
  - The smoke test runs the `all` role, not `api` alone. A scanned library needs the worker to run the queued scan jobs, and `api` alone leaves them queued. The wizard's own screens need only the api role.
  - `artworkRequiresAuth` is stored and editable, but nothing enforces it yet because no artwork route exists in tree. `apps/server/README.md` says so.
  - Provider keys are write-only over the API. Reads return names, never values, so a compromised admin session cannot exfiltrate a provider secret it did not set.
  - OIDC settings stay read-only in this slice. The issue names proxy trust, the artwork toggle and provider keys; editing an OIDC client secret is not in that list.
  - `setGroupPermissions` rejects the built-in `admins` and `users` groups. Admins bypass every check, so editing their group is meaningless, and the built-in `users` group is the documented default. Custom groups carry the admin's own policy.
  - The bitrate cap crosses the API as a nullable integer, not a string, because bits per second stays far inside the safe integer range. The service converts to the column's bigint.
- The wizard needs to know whether setup is still open, and no procedure answered that. `setup.status` is unauthenticated on purpose: it leaks one boolean that `POST /api/auth/setup` already leaks through its 409.
- Work stays in `/home/mia/mia-cx/pendia/.worktrees/admin` on `feat/37-admin-ui`. One buildable commit per TODO, each with `Refs #37`. Never commit `.devin`.
- Five sibling branches merge under this one. Rebase on `origin/main` before filing the pull request and before every review push, resolving conflicts in favour of the merged code. No force pushes.
- Local Postgres for this task: `docker run -d --name pendia-test-pg-37 ... -p 127.0.0.1:55437:5432 postgres:18`, with `DATABASE_URL=postgresql://pendia:pendia@127.0.0.1:55437/pendia`. Tests create and drop their own databases.
- Initial state: clean worktree at `0e8ac31`, which is `origin/main`.
