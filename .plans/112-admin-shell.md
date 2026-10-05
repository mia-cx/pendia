# #112 Redesign: admin shell, overview, users, groups and settings

## Summary

Admin becomes a settings app laid out like System Settings. On desktop a floating sidebar lists the sections under a search field, and the content pane shows the section with a large title and grouped form panels. On phone the section list is the first screen, each section pushes in from the right, and a back button returns to it. Overview, Users, user detail, Groups and General (the old Settings screen) move to the new design. Libraries, Plugins and Activity join the sidebar and keep their content for #113 and #114.

## Acceptance criteria

- [x] Admin opens in the two-pane layout and every admin section is reachable from its sidebar
- [x] Overview, users, user detail, groups and settings work as they do today, in the new design
- [x] Saves confirm with a toast, and destructive actions use an alert dialog
- [x] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] Section model in `$lib/admin.ts` (sections, search, current section, push or pop direction), `scanState` in `$lib/scan.ts` and `permissionLabels`, with unit tests
- [x] Shared pieces: `AdminPage`, `FormGroup`, `FormRow`, `ListRow`, `AdminNav`, `ConfirmDialog`, `SecretInput`, the `textarea` UI component, and `TabBar` pulled out of the browse shell
- [x] Admin shell: sidebar with search on desktop, section list as the first phone screen, tab bar on phone, iOS-style push and pop, legacy wrapper for Libraries, Plugins and Activity
- [x] Overview: server and database health from `/readyz`, scan state per library, what's playing
- [x] Users and user detail in grouped panels, invites with copy and expiry, revoke behind an alert
- [x] Groups with readable permission names and an edit dialog
- [x] General (settings) in grouped panels, masked secrets with reveal, key removal behind an alert
- [x] `DESIGN.md`: admin shell, panels and the components above
- [x] Screenshots before and after, keyboard, screen reader, reduced motion and high contrast passes
- [x] Full gate

## Notes

- The Settings screen is labelled General in the sidebar. The main shell already calls all of admin Settings, so Settings inside Settings would be ambiguous. Its URL stays `/admin/settings`.
- Overview lives at `/admin/overview` as well as `/admin`. On desktop `/admin` shows Overview. On phone `/admin` is the section list, as in iOS Settings, so the Overview row needs its own URL.
- Health reads `/readyz`, which reports the database as well as reachability. The Vite dev proxy gains `/readyz`; the server already serves it. No server change.
- The phone tab bar stays in admin, with Settings current, so Home is one tap away. It moves into `TabBar.svelte` so both shells share it.
- Group membership and permission overrides save as soon as they change, like System Settings. Removing yourself from the built-in admins group asks first, because it ends your access to these screens.
- The invite result drops the separate Token field. The link carries the token.
- Libraries keeps its own scan label until #113 redesigns it; `scanState` is there for it to adopt.
- Vite's string proxy shorthand sets `changeOrigin: true`, so the server's origin check refused every cookie-auth write from the dev server. The proxy entries now keep the Host header.
- The base replaced `Poster` with `Artwork` while this slice was in flight. Overview's thumbnails use `Artwork` with `fallbackTitle={false}`.
- Accounts have no email until OIDC fills it, because the API has no email write. The fixture users show none.
- Gate at `db8d830`, after merging `origin/feat/107-design-system` at `3e21c00`. Lint was re-run at `fa15e80`, which only sorts one import:
  - `bun install --frozen-lockfile`: no changes.
  - `bun run lint`: clean, apart from 9 warnings in `app.css` that the base already has.
  - `bun run check`: 0 errors, 0 warnings.
  - `bun run build`: 4 of 4 tasks.
  - `bun test` with `DATABASE_URL`: 1411 pass, 3 skip, 0 fail.
  - `bun test` without it: 830 pass, 602 skip, 0 fail.
- Accessibility, on the rendered app:
  - Keyboard: tab order runs skip link, Home, search, sections, account, then content. Selects open with the arrow keys. Escape closes dialogs and Selects and returns focus to the trigger.
  - Screen reader, from the CDP accessibility tree: the switches announce role, name and checked state. The search field is named "Search settings". The section links carry `aria-current`, and the reveal toggle carries `aria-pressed`.
  - High contrast and reduced motion: shots taken. The push and pop slide only under `prefers-reduced-motion: no-preference`, so reduced motion gets the cross-fade.
