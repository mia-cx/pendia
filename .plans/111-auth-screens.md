# #111 Redesign: sign in, setup, invite and error screens

## Summary

Sign in, setup, invite redemption, single sign-on and the error and offline screens move off the `legacy` scope onto the #107 design system. Each is one focused card on a calm backdrop, after Apple's own first-run and sign-in screens: a large title, few fields, one primary button. Setup becomes a three-step guided flow (Account, Library, Scan) that shows progress and lets the person step back. Behaviour and API calls stay as they are.

## Acceptance criteria

- [ ] Setup, sign in, invite and single sign-on work as they do today, in the new design
- [ ] Setup shows progress through Account, Library and Scan, and Back returns to the previous step while it can still change
- [ ] The invite page welcomes by the server's name
- [ ] Sign in shows single sign-on as a peer of the password form when it is configured
- [ ] The error and offline screens offer one clear way out; offline reads `Server unreachable` with `Try again`
- [ ] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [ ] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [ ] Every string follows `ui-copy`
- [ ] The repository gate is green

## TODOs

- [ ] `FocusScreen` layout, `Label` and `Progress` components, `Failure` inline mode, restyled `OidcSignIn`; documented in `DESIGN.md` and shown on `/design`
- [ ] Sign in on `FocusScreen`, with single sign-on above the password form and a shake on a wrong password
- [ ] Setup as a three-step flow with a stepper, Back, and a scan progress bar; `scanProgress` in `scan.ts` with `bun test` coverage
- [ ] Invite on `FocusScreen`: the welcome form and the expired, used and unknown states
- [ ] Error page on `FocusScreen`: unreachable, not found and generic failures, each with one action
- [ ] Remove the `legacy` class from these screens and update the `legacy` list in `DESIGN.md`
- [ ] Exercise every flow against a dev instance; before and after screenshots; keyboard, screen reader, reduced motion and high contrast passes
- [ ] Full gate

## Notes

- The server has no configurable name. The Jellyfin layer reports `ServerName: "Pendia"` (`apps/server/src/jellyfin/system.ts`), so the invite welcomes to Pendia. A per-server name would be a new setting with its own admin UI, which is beyond this slice; no server change.
- Setup used to create the admin on the first step, which made stepping back impossible. Now Account only collects the fields, and Add library creates the admin, signs in, creates the library and starts the scan. An admin failure returns to Account with the error. Once the admin exists, Back disappears, because the account can no longer change from here. The Scan step has no Back, because the library and its scan already exist.
- Single sign-on reads `Continue with <provider>` on both sign in and invite, since it both signs in and creates an invited account. It sits above the password form with an `or` divider, at the same size, so it reads as a peer.
- The error page splits a 404 out as `Page not found` with `Go to Home`, because `Try again` cannot fix a missing page.
- The single sign-on state is rendered from its configured shape (`settings.auth` with an OIDC block) unless a test provider is easy to stand up.
