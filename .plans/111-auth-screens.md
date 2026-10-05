# #111 Redesign: sign in, setup, invite and error screens

## Summary

Sign in, setup, invite redemption, single sign-on and the error and offline screens move off the `legacy` scope onto the #107 design system. Each is one focused card on a calm backdrop, after Apple's own first-run and sign-in screens: a large title, few fields, one primary button. Setup becomes a three-step guided flow (Account, Library, Scan) that shows progress and lets the person step back. Behaviour and API calls stay as they are.

## Acceptance criteria

- [x] Setup, sign in, invite and single sign-on work as they do today, in the new design
- [x] Setup shows progress through Account, Library and Scan, and Back returns to the previous step while it can still change
- [x] The invite page welcomes by the server's name
- [x] Sign in shows single sign-on as a peer of the password form when it is configured
- [x] The error and offline screens offer one clear way out; offline reads `Server unreachable` with `Try again`
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] `FocusScreen` layout, `Label` and `Progress` components, `Failure` inline mode, restyled `OidcSignIn`; documented in `DESIGN.md` and shown on `/design`
- [x] Sign in on `FocusScreen`, with single sign-on above the password form and a shake on a wrong password
- [x] Setup as a three-step flow with a stepper, Back, and a scan progress bar; `scanProgress` in `scan.ts` with `bun test` coverage
- [x] Invite on `FocusScreen`: the welcome form and the expired, used and unknown states
- [x] Error page on `FocusScreen`: unreachable, not found and generic failures, each with one action
- [x] Remove the `legacy` class from these screens and update the `legacy` list in `DESIGN.md`
- [x] Exercise every flow against a dev instance; before and after screenshots; keyboard, screen reader, reduced motion and high contrast passes
- [x] Full gate

## Notes

- The server has no configurable name. The Jellyfin layer reports `ServerName: "Pendia"` (`apps/server/src/jellyfin/system.ts`), so the invite welcomes to Pendia. A per-server name would be a new setting with its own admin UI, which is beyond this slice; no server change.
- Setup used to create the admin on the first step, which made stepping back impossible. Now Account only collects the fields, and Add library creates the admin, signs in, creates the library and starts the scan. An admin failure returns to Account with the error. Once the admin exists, Back disappears, because the account can no longer change from here. The Scan step has no Back, because the library and its scan already exist.
- Single sign-on reads `Continue with <provider>` on both sign in and invite, since it both signs in and creates an invited account. It sits above the password form with an `or` divider, at the same size, so it reads as a peer.
- The error page splits a 404 out as `Page not found` with `Go to Home`, because `Try again` cannot fix a missing page.
- The single sign-on state is rendered from its configured shape (`settings.auth` with an OIDC block) unless a test provider is easy to stand up.

## Review

- Pullfrog on 58dbd47 found two setup scan regressions, both real. The determinate bar passed a 0–1 fraction to a `Progress` whose `max` is 100 (fixed in e5d3bd9 with `max={1}`). A failed scan request was masked: start failures read as "the scan keeps running", and a failed Scan again hid behind the old job error. Fixed in 7fde3f7 with `scanPhase`, which has tests. A start failure now reads `The scan did not start` with the real error and Try again. A poll failure keeps the bar, shows the real error, and offers Check again.

## Gate

On 7fde3f7, after merging `feat/107-design-system` at 0f32fbc:

- `bun install --frozen-lockfile`: no changes.
- `bun run lint`: clean, 9 warnings, all the `!important` overrides #116 added for reduced motion.
- `bun run check`: 0 errors, 0 warnings.
- `bun run build`: 4 of 4 tasks.
- `DATABASE_URL=... bun test`: 1426 pass, 3 skip (S3 artwork), 0 fail.
- `bun test` without `DATABASE_URL`: 845 pass, 602 skip, 0 fail.

## Not verified

- Single sign-on against a live provider. The button and its failure message were rendered from a configured `settings.auth` block whose issuer does not answer.
