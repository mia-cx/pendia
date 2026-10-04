# #107 Redesign: design system and app shell

## Summary

The first slice of the redesign PRD (#105). Replace the browser-default look with one design system: Tailwind v4, a customized shadcn-svelte set on bits-ui, role-named tokens for light, dark and high contrast, the Apple type scale on SF Pro with a self-hosted Inter fallback, translucent materials with solid fallbacks, motion tokens, and Lucide icons. Then build the shell every later slice sits in: a collapsible translucent sidebar from 1024 px, a bottom tab bar below that, the account at the sidebar's foot or behind a profile button on phone, and Settings for admins. Home, Movies, Shows and Search open inside the shell, with only the content changes they need to sit well in it. Admin, sign-in, setup, invite, error, detail and player screens keep working through a temporary `legacy` scope until their slices redesign them.

## Acceptance criteria

- [ ] Tailwind v4 and the shadcn-svelte components are in the web app, customized to the Pendia look. The old token set is gone, apart from aliases that keep not-yet-redesigned screens readable until their slices land
- [ ] Light, dark and high-contrast tokens follow the system setting, and reduced transparency or a missing backdrop filter falls back to solid surfaces
- [ ] SF Pro renders on Apple devices and Inter, served by Pendia, everywhere else
- [ ] The sidebar and the tab bar navigate every browse section, and admins also see Settings
- [ ] `DESIGN.md` describes the tokens, type scale, components and shell
- [ ] Mia has approved the look from the PR screenshots (Mia, after the PR is green)
- [ ] Labelled before and after screenshots of every touched screen at 1440x900 and 390x844, light and dark, are in the PR
- [ ] Keyboard-only, screen reader, reduced motion and high contrast passes per `ui-review` hold
- [ ] Every string follows `ui-copy`
- [ ] The repository gate is green

## TODOs

- [ ] 1. Foundation: Tailwind v4 and the tokens.
  - `@tailwindcss/vite` in `vite.config.ts`. `app.css` becomes the Tailwind entry: Pendia's role tokens defined once with `light-dark()`, a `prefers-contrast: more` block, the Apple type scale, radii, layout and motion tokens, and the `material` utilities with their solid fallbacks. Tailwind's default palette, type scale and radii are reset so only Pendia's tokens exist.
  - Inter 4.1 variable, vendored under `static/fonts` with its OFL licence. The stack is `-apple-system, BlinkMacSystemFont, InterVariable, sans-serif`, so Apple devices never download Inter.
  - The old element styles move to `legacy.css`, scoped under `.legacy`, with the old token names aliased to the new tokens. Every not-yet-redesigned screen gets the `legacy` class on its root.
  - Validation: `check` and `build` pass; admin, login, setup, detail and player screens render as before.
- [ ] 2. Components: the shadcn-svelte set, customized.
  - button, input, select, dialog, alert dialog, sheet, dropdown menu, popover, slider, switch, tabs, table, toast (svelte-sonner), tooltip, badge, skeleton and scroll area, under `$lib/components/ui`, restyled to the tokens. Lucide through `@lucide/svelte`.
  - A dev-only `/design` gallery renders every component in every state, as the living reference later slices check against. Production builds answer it with 404.
  - Validation: `check`, `lint` and `build` pass; the gallery renders in light, dark and high contrast.
- [ ] 3. Shell: sidebar, tab bar and account.
  - `$lib/shell.ts` builds the navigation from the caller and their libraries: sections, each medium's libraries when it has more than one, Settings for admins, and which entry is current. `shell.test.ts` covers it.
  - The browse layout loads the libraries alongside the session. The sidebar floats as a translucent panel, collapses to an icon rail with tooltips and remembers that choice. Below 1024 px a floating translucent tab bar carries the same sections and a profile button opens the account menu. A skip link, one focus ring and view-transition fades between pages.
  - The search field moves from the old header into the Search page, keeping its URL sync and debounce.
  - Validation: `bun test apps/web`, `check`, keyboard pass over the shell.
- [ ] 4. Browse screens inside the shell.
  - Poster card and shelf primitives: a reserved 2:3 frame with a hairline, a styled title fallback, a gentle lift on hover and focus, and progress in the tint. Shelves bleed under the sidebar and snap, with arrow buttons on pointer devices.
  - Home, Movies, Shows and Search use them. The grid takes a library filter from the sidebar, sorts through the Select component and shows skeleton posters while the first page loads.
  - Validation: `check`, `build`, rendered at both widths in both schemes.
- [ ] 5. Rewrite `apps/web/DESIGN.md` to describe the system: tokens, type scale, materials, motion, components, shell, the legacy aliases as temporary, and the rules later slices follow.
- [ ] 6. Review and evidence.
  - Render every touched screen at 1440x900 and 390x844, light and dark, plus high contrast; iterate until it holds up next to the Apple TV app. Keyboard-only, screen reader (accessibility tree), reduced motion, reduced transparency and 200% zoom passes.
  - Labelled before and after screenshots, uploaded.
- [ ] 7. Gate from the repo root: `bun install --frozen-lockfile`, `bun run lint`, `bun run check`, `bun run build`, `DATABASE_URL=... bun test`, `bun test`. Results recorded below.

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
