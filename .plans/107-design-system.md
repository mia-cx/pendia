# #107 Redesign: design system and app shell

## Summary

The first slice of the redesign PRD (#105). Replace the browser-default look with one design system: Tailwind v4, a customized shadcn-svelte set on bits-ui, role-named tokens for light, dark and high contrast, the Apple type scale on SF Pro with a self-hosted Inter fallback, translucent materials with solid fallbacks, motion tokens, and Lucide icons. Then build the shell every later slice sits in: a collapsible translucent sidebar from 1024 px, a bottom tab bar below that, the account at the sidebar's foot or behind a profile button on phone, and Settings for admins. Home, Movies, Shows and Search open inside the shell, with only the content changes they need to sit well in it. Admin, sign-in, setup, invite, error, detail and player screens keep working through a temporary `legacy` scope until their slices redesign them.

## Acceptance criteria

- [x] Tailwind v4 and the shadcn-svelte components are in the web app, customized to the Pendia look. The old token set is gone, apart from aliases that keep not-yet-redesigned screens readable until their slices land
- [x] Light, dark and high-contrast tokens follow the system setting, and reduced transparency or a missing backdrop filter falls back to solid surfaces
- [x] SF Pro renders on Apple devices and Inter, served by Pendia, everywhere else (Inter verified on Linux Chromium; SF Pro follows from the stack, not rendered on an Apple device here)
- [x] The sidebar and the tab bar navigate every browse section, and admins also see Settings
- [x] `DESIGN.md` describes the tokens, type scale, components and shell
- [ ] Mia has approved the look from the PR screenshots (Mia, after the PR is green)
- [ ] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [x] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [x] Every string follows `ui-copy`
- [x] The repository gate is green

## TODOs

- [x] 1. Foundation: Tailwind v4 and the tokens.
  - `@tailwindcss/vite` in `vite.config.ts`. `app.css` becomes the Tailwind entry: Pendia's role tokens defined once with `light-dark()`, a `prefers-contrast: more` block, the Apple type scale, radii, layout and motion tokens, and the `material` utilities with their solid fallbacks. Tailwind's default palette, type scale and radii are reset so only Pendia's tokens exist.
  - Inter 4.1 variable, vendored under `static/fonts` with its OFL licence. The stack is `-apple-system, BlinkMacSystemFont, InterVariable, sans-serif`, so Apple devices never download Inter.
  - The old element styles move to `legacy.css`, scoped under `.legacy`, with the old token names aliased to the new tokens. Every not-yet-redesigned screen gets the `legacy` class on its root.
  - Validation: `check` and `build` pass; admin, login, setup, detail and player screens render as before.
- [x] 2. Components: the shadcn-svelte set, customized.
  - button, input, select, dialog, alert dialog, sheet, dropdown menu, popover, slider, switch, tabs, table, toast (svelte-sonner), tooltip, badge, skeleton and scroll area, under `$lib/components/ui`, restyled to the tokens. Lucide through `@lucide/svelte`.
  - A dev-only `/design` gallery renders every component in every state, as the living reference later slices check against. Production builds answer it with 404.
  - Validation: `check`, `lint` and `build` pass; the gallery renders in light, dark and high contrast.
- [x] 3. Shell: sidebar, tab bar and account.
  - `$lib/shell.ts` builds the navigation from the caller and their libraries: sections, each medium's libraries when it has more than one, Settings for admins, and which entry is current. `shell.test.ts` covers it.
  - The browse layout loads the libraries alongside the session. The sidebar floats as a translucent panel, collapses to an icon rail with tooltips and remembers that choice. Below 1024 px a floating translucent tab bar carries the same sections and a profile button opens the account menu. A skip link, one focus ring and view-transition fades between pages.
  - The search field moves from the old header into the Search page, keeping its URL sync and debounce.
  - Validation: `bun test apps/web`, `check`, keyboard pass over the shell.
- [x] 4. Browse screens inside the shell.
  - Poster card and shelf primitives: a reserved 2:3 frame with a hairline, a styled title fallback, a gentle lift on hover and focus, and progress in the tint. Shelves bleed under the sidebar and snap, with arrow buttons on pointer devices.
  - Home, Movies, Shows and Search use them. The grid takes a library filter from the sidebar, sorts through the Select component and shows skeleton posters while the first page loads.
  - Validation: `check`, `build`, rendered at both widths in both schemes.
- [x] 5. Rewrite `apps/web/DESIGN.md` to describe the system: tokens, type scale, materials, motion, components, shell, the legacy aliases as temporary, and the rules later slices follow.
- [x] 6. Review and evidence.
  - Render every touched screen at 1440x900 and 390x844, light and dark, plus high contrast; iterate until it holds up next to the Apple TV app. Keyboard-only, screen reader (accessibility tree), reduced motion, reduced transparency and 200% zoom passes.
  - Labelled before and after screenshots, uploaded.
- [x] 7. Gate from the repo root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test`, `bun test`. Results recorded below.

## Notes

- Worktree `/home/mia/mia-cx/pendia/.worktrees/design`, branch `feat/107-design-system` from `origin/main` at `740cb78`. Test Postgres `pendia-test-pg-design` on 55569. `TMPDIR=/home/mia/.cache/pendia-tmp/design`.
- Decisions made without anyone to ask:
  - The sidebar lists libraries by medium, but viewers cannot list libraries: `libraries.list` needs `manage-libraries`, and only the Jellyfin layer's `/UserViews` knows a viewer's libraries. Per the PRD's server rule, the gap is filed as #115. Until it lands, callers who may list libraries see them in the sidebar, and everyone else sees the medium sections.
  - A medium's libraries appear under its section only when it has more than one, so a server with one movie library does not list Movies twice. Each links to its grid filtered to that library, `/movies?library=<id>`.
  - The primary button is the label colour, white on dark and near-black on light, as in the Apple TV app. The tint, one indigo, marks the current section, progress, focus, switches and sliders.
  - The sidebar floats as an inset translucent panel, so shelves scroll under its material, as in iPadOS. Collapsed, it keeps an icon rail rather than hiding, so sections stay one click away.
  - The phone tab bar floats as a translucent capsule above the home indicator, with the account behind a profile button at the top of the page.
  - Tokens use `light-dark()`, so a subtree that sets `color-scheme: dark` (the player) gets the dark tokens without a second copy of them.
  - Not-yet-redesigned screens opt into the old element styles with a `legacy` class instead of keeping those styles global, so Tailwind's components never inherit them. Each later slice deletes its screen's `legacy` class and, last, `legacy.css`.
  - The search field lives on the Search page, since the old header that held it is gone.
  - Home shows its large title on phones only, as the iOS TV app does; on desktop the shelves lead.
  - Shelf arrows appear only when the row overflows, and the header keeps one height either way.
  - A Season or Episode fallback poster names its Show, since an Episode without metadata is titled "Episode 1".
  - Tailwind's default palette, font sizes and radii are reset, so only role tokens and the Apple scale compile.
  - The dev-only `/design` gallery is the living reference; production answers it with the error page.
- Dependencies, exact pins, each published at least 7 days before 2026-10-04: tailwindcss and @tailwindcss/vite 4.3.3, tw-animate-css 1.4.0, bits-ui 2.19.3, @lucide/svelte 1.48.0, tailwind-variants 3.3.1, tailwind-merge 3.7.0, clsx 2.1.1, svelte-sonner 1.2.1, @internationalized/date 3.12.4. Components from the shadcn-svelte 1.7.0 CLI with a hand-written `components.json`. Inter 4.1 from the rsms release, OFL 1.1.
- Fixes found by rendering: bits-ui 2 emits `data-state`, so the generated `data-open:` variants were rewritten; tailwind-variants needed the custom font-size scale in its tailwind-merge config, or `text-subheadline` evicted the button's text colour; Tooltip needs one Provider above the whole shell; the account trigger must spread the tooltip props before the menu props, or clicks never open the menu.
- Evidence data: a dev instance on port 5560 against `pendia_dev`, with 17 Films, 4 Family movies and 4 shows under the scratch dir. TMDB matched every movie but Arrival and Past Lives; Pendia Sample Reel is unmatched on purpose. Shows have no artwork because TVDB is the only show provider and no TVDB key is configured, so every show card shows the fallback. No movie has a backdrop.
- Checks, on the rendered app through CDP: Tab order runs skip link, wordmark, collapse toggle, Search, Home, Movies, Family, Films, Shows, Settings, account, then the first poster; the skip link focuses `main`; the account menu opens with Enter and Escape returns focus to its trigger; the collapse toggle keeps focus. The accessibility tree names every nav link, marks the current one, exposes the toggle's expanded state, and exposes one Main navigation per width. Skeleton and loaded boxes match within 0.02 px. At 200% zoom the tab bar shell takes over. Reduced motion leaves poster transforms at none while the page fade still runs. High contrast and reduced transparency swap the tokens as specified.
- Gate, from the repo root at the final head before filing: `bun install --frozen-lockfile` exit 0; `bun run lint` exit 0 (9 warnings, the intentional `!important`s in the reduced-motion rule); `bun run check` exit 0, svelte-check 0 errors and 0 warnings; `bun run build` exit 0; `DATABASE_URL=… bun test` 1363 pass, 3 skip, 0 fail; `bun test` 797 pass, 587 skip, 0 fail.
