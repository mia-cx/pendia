# Pendia web design

Pendia should feel like Apple built a self-hosted media player. Artwork leads, the chrome is translucent and quiet, titles are large and confident, and one accent marks what matters. This file is the system's source of truth. Each redesign slice extends it rather than repeating it.

## Principles

- Artwork carries the colour. Chrome is neutral, so a poster is the loudest thing on screen.
- One accent, the tint. It marks the current section, progress, focus, switches and sliders. The primary button is the label colour, near-black on light and white on dark, as in the Apple TV app.
- Materials sit over content, never beside it. A sidebar, tab bar or menu blurs what scrolls beneath it.
- Motion is short and physical: things lift, rise and settle. Reduced motion keeps every fade and drops every movement.
- Geometry is reserved before content loads, so nothing jumps.

## Tokens

All tokens live in `src/lib/app.css`. Each colour is defined once with `light-dark()`, in a block declared on both `:root` and `.dark`. Lightning CSS resolves `light-dark()` where a token is declared, so declaring the block on `.dark` too is what lets a `.dark` subtree (the player, heroes, landscape cards) recompute every token with dark values. Light and dark follow the system setting; there is no theme switch.

Tailwind's default palette, type scale and radii are reset. Only these tokens exist, so an ad hoc colour or size fails to compile into anything.

### Colour

| Token | Utility | Role |
| --- | --- | --- |
| `--background` | `bg-background` | The window. White on light, near-black on dark. |
| `--background-elevated` | `bg-elevated`, `bg-card` | Grouped surfaces and empty poster frames. |
| `--background-raised` | `bg-raised`, `bg-popover` | Dialogs and the selected segment. |
| `--label` | `text-label`, `bg-primary` | Primary text, and the primary button. |
| `--label-secondary` | `text-label-secondary` | Captions, metadata, placeholders. |
| `--label-tertiary` | `text-label-tertiary` | Decorative glyphs and shortcuts. Never body text. |
| `--fill`, `--fill-strong` | `bg-fill`, `bg-fill-strong` | Control fills, hover and pressed states. |
| `--separator` | `border-separator`, `bg-separator` | Hairlines between groups. |
| `--border-control` | `border-input` | Field borders where a fill alone is not enough. |
| `--tint`, `--tint-fill` | `text-tint`, `bg-tint`, `bg-tint-fill` | The accent, Pendia indigo, and its translucent wash. |
| `--destructive` | `text-destructive`, `bg-destructive` | Destructive actions and errors. |
| `--success` | `text-success` | Confirmations. |
| `--scrim` | `bg-scrim` | Behind dialogs and sheets. |

High contrast (`prefers-contrast: more`) swaps in pure black and white labels, stronger fills and separators, a deeper tint, nearly opaque materials and a 3 px focus ring.

### Materials

`material` and `material-thick` are utilities: a translucent fill, a 28 px backdrop blur at 180% saturation, and a 0.5 px inner edge. `material` is for bars and the sidebar; `material-thick` is for menus, popovers, tooltips, toasts and sheets. When the browser cannot blur, or the user asks for reduced transparency, both resolve to `--material-solid`.

### Type

The stack is `-apple-system, BlinkMacSystemFont, InterVariable, sans-serif`. Apple devices render SF Pro and never download Inter. Everywhere else renders Inter 4.1 variable, served by Pendia from `static/fonts` under the SIL Open Font License (`static/fonts/LICENSE.txt`), so it works offline. Inter's optical sizes switch to its display cut at large sizes on their own.

One scale, Apple's platform sizes. Weight and tracking travel with the size, so `text-title-2` alone sets all three.

| Utility | Size / line | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `text-display` | 36 to 56 / 1.07 | 700 | -0.03em | Hero titles without logo art |
| `text-large-title` | 34 / 41 | 700 | -0.025em | Page titles |
| `text-title-1` | 28 / 34 | 700 | -0.022em | Hero titles |
| `text-title-2` | 22 / 28 | 700 | -0.019em | Shelf and section headings |
| `text-title-3` | 20 / 25 | 600 | -0.017em | Dialog titles, the wordmark |
| `text-headline` | 17 / 22 | 600 | -0.011em | Emphasised rows, alert titles |
| `text-body` | 17 / 22 | 400 | -0.011em | Body text, phone fields |
| `text-callout` | 16 / 21 | 400 | -0.01em | Supporting paragraphs |
| `text-subheadline` | 15 / 20 | 400 | -0.009em | Sidebar rows, menus, buttons, card titles |
| `text-footnote` | 13 / 18 | 400 | -0.003em | Captions, table headers, tooltips |
| `text-caption-1` | 12 / 16 | 400 | 0 | Badges |
| `text-caption-2` | 11 / 13 | 400 | 0.006em | Tab bar labels |

### Shape, space and depth

- Radii: `rounded-xs` 4, `rounded-sm` 6, `rounded-md` 10 (buttons, fields), `rounded-lg` 14 (menus, popovers), `rounded-xl` 20 (dialogs, sheets), `rounded-2xl` 28 (the sidebar), `rounded-poster` 10, `rounded-full` for icon buttons, badges and the tab bar.
- Spacing is Tailwind's 4 px scale. The page gutter is `--gutter`, from 16 px to 48 px.
- `bleed` pulls a block out to the window's edges: under the sidebar on the left and through the gutter on the right. Heroes, the carousel and shelf tracks use it.
- `artwork-fallback` is the surface behind missing artwork: a two-stop gradient in a muted hue picked from the title (`fallbackHue` in `browse.ts`), under a soft sheen from the top-left. The hue stays quiet, so chrome remains neutral and a sparse library still looks designed. High contrast drops the hue to grey.
- `shadow-float` lifts menus, the sidebar and the tab bar off the page. `shadow-lift` is the shadow under a lifted poster.

### Motion

After the transitions.dev scale: `--duration-micro` 80 ms for shake segments, `--duration-quick` 150 ms for closes and tooltips, `--duration-fast` 250 ms for opens, hovers and page fades, `--duration-medium` 350 ms for sheets, `--duration-slow` 400 ms for image fades, toasts and progress bars, `--duration-very-slow` 500 ms for emphasis moments. Distances `--distance-micro` 4, `--distance-small` 6, `--distance-base` 8, `--distance-medium` 12 and `--distance-large` 30 px, scales `--scale-tiny` to `--scale-large` and blurs `--blur-small` to `--blur-large` complete the scale. `ease-smooth-out` settles everything; `ease-spring` carries a small overshoot for lifts and the switch thumb. Opens are slower than closes. Under reduced motion, a global rule zeroes tw-animate's translate, scale and rotate, so every sheet, menu and dialog fades instead of moving, and lifts become a shadow change.

### Focus

One ring for every control: a 2 px tint outline, 2 px out, from `:focus-visible` in `app.css`. Components never draw their own.

## Components

The shadcn-svelte set lives in `src/lib/components/ui`, on bits-ui for keyboard and ARIA behaviour, restyled to these tokens. Screens use only these and the media components below; no screen styles a raw control. The dev-only `/design` page renders every component in every state and is the reference to check against; production builds answer it with 404.

- **Button**: `default` (label colour), `secondary` (fill), `ghost`, `outline`, `tinted`, `glass` (material, for buttons over artwork), `destructive` and `link`. Sizes `sm` 32, `default` 40 (44 on touch), `lg` 48, `pill` 44 (the round-ended Play button on heroes), and round `icon-sm`, `icon`, `icon-lg`. Buttons press down to 97%.
- **Input**: a filled field with no border, 17 px on phones so iOS does not zoom, 15 px from 1024 px.
- **Label**: a subheadline-medium caption 6 px above its field. An optional field reads `Display name Optional`, the marker in secondary label colour.
- **Progress**: a 6 px capsule; the tint indicator eases to its width. Indeterminate slides a tint segment on a loop, or pulses a static segment under reduced motion.
- **Select**: an Apple pop-up button with up-down chevrons; the chosen item shows a leading check.
- **Dropdown menu, popover, tooltip**: `material-thick`, growing from their trigger. Tooltips wait 500 ms and close at once. Radio items lead with a check on the chosen one, like Select.
- **Dialog, alert dialog, sheet**: over the scrim. Alerts are compact and centred, with two full-width buttons that name the action. Side sheets float inset from the edge; bottom sheets carry a grabber. Dialogs and alerts stop 1rem short of the dynamic viewport and scroll inside, so their buttons stay reachable in phone landscape.
- **Slider, switch, tabs**: the tint fills the range and the on switch. Tabs are a segmented control. The slider's `media` variant is the player's: a 4 px track in translucent white that thickens to 6 px under the pointer, a white range, a `track` layer for buffered ranges, and a thumb that shows only on hover, focus or drag. `valueText` gives the thumb words to announce.
- **Table**: hairline rows, footnote headers, tabular numbers.
- **Failure**: a destructive-tinted callout for screen-level errors. Its `inline` mode is a single destructive row with an alert icon, for failures inside a form.
- **Textarea**: the same filled field as Input, `min-h-24` and vertically resizable.
- **Toast**: svelte-sonner, bottom centre and above the tab bar on phones, following the system scheme.
- **Badge, skeleton, scroll area**: capsules, pulsing fills, and overlay scrollbars that show on hover.

## Media components

Artwork leads every one of these. Titles come from the art itself where it has them: TMDB posters carry the title, and logos stand in for it on heroes and landscape cards. Text only appears where the art has none.

- **Artwork** is the one frame for every image: 2:3 (`poster`) or 16:9 (`landscape`), reserved before the image loads, with a hairline so light art does not bleed into a light page, and a fade-in. A missing or failed image shows `artwork-fallback`. A poster fallback carries the medium's icon at the top-left and the title in `text-title-3` with the year under it at the bottom-left, so the title prints once. A landscape fallback is the bare surface, because its card draws the title. A Season or Episode without its own poster borrows its Show's, and its fallback names the Show.
- **Poster card** is the frame alone, like the posters in the Apple TV app's shelves: nothing under it. The link's accessible name is the title and year, or the Show and code for an Episode. Hover and keyboard focus lift the frame 4 px and scale it to 103% on a spring, with `shadow-lift`, and the focus ring sits on the frame. A card with progress draws a tint bar, over a soft scrim when there is artwork, and adds the percentage watched to its name.
- **Landscape card** is for Continue Watching and Next Up. It is always dark inside, like a hero. The art is an Episode's still, else its Show's backdrop, else a Movie's backdrop. Over a bottom scrim sit the logo (the Show's for an Episode) or the title in `text-headline`, then one line: `38m left` for a Movie, `S1, E2 · 22m left` for an Episode, or `S1, E3 · Episode title` in Next Up. Progress is a tint bar under it. A Next Up Episode added in the last week wears a `New` badge. Clicking plays: Resume with progress, Play without. The lift matches the poster card's at 102%, and carries the menu button with it.
- **Card menu** is the `…` glass button at a landscape card's bottom-right. It holds only actions Pendia has: Go to movie, Go to episode, Go to season or Go to show, and Play from start when there is progress. Mark as watched, the watchlist and Share join it with #106.
- **Shelf** is one row that scrolls sideways and snaps to cards, in two sizes: posters (176 px wide from 1024 px) and landscape cards (240 to 304 px). The track bleeds under the sidebar, so cards slide beneath its material. On pointer devices, when the row overflows, glass paddles sit at both edges, centred on the cards; they show while the pointer is over the row or when focused, and hide at the ends. The title carries a `›` only when the shelf has a page to open, so a chevron always leads somewhere.
- **Hero** is a full-bleed image the height of most of the window (78% on phones, up to 82% from 1024 px), always dark inside. The backdrop fills it under a bottom scrim, a left scrim from 1024 px and a thin top scrim for the phone's profile button. Without a backdrop, the poster fills it as a blurred, darkened wash; without either, a dark gradient. At the bottom-left, in the content column: the logo, bottom-aligned in a reserved box, or the title in `text-display`; then the content the page gives it. Home's carousel uses it, and the detail pages (#109) share it.
- **Hero carousel** opens Home with up to five heroes: Continue Watching first, then Recently added, with art-led Items before any without a backdrop. Each slide shows `Movie · Romance · Drama · 2013` (an Episode shows its code and title), a two-line overview whose space is reserved before it loads, the white pill (`Resume`, `Play`, or `Go to show` for a Show) and a round glass details button. Slides scroll and snap, so touch swipes them natively. Thin chevrons at both edges (pointer devices) wrap around, and dots centred under the content jump to a slide. It never advances on its own: a carousel that moves by itself needs a pause control, and Home is about what you were watching. It is a region named Featured; each slide is a group named `2 of 5`, and slides out of view are inert.
- **Poster grid** fills the width with columns at least 152 px wide, or three across on a phone.
- **Scrubber** is the player's timeline, on the media slider. Buffered ranges show in a lighter white. While a mouse hovers it or a drag runs, a capsule above the pointer shows the time there; that capsule is the slot scrubber thumbnails join later. A drag shows its time and seeks once, on release. Screen readers hear `12:34 of 1:45:00`.
- **Player settings** is the gear menu at the player's bottom right. It holds Version, Audio and Subtitles, in that order, as grouped sections with a leading check on the current choice. Each section appears only when it offers a choice, and the gear hides when none does. Version rows add the File's size. A section with more than five options folds into one row that shows the current choice and opens a submenu, so the menu stays short. Choices disable while a switch runs. The menu renders inside the player, so it stays dark and shows in fullscreen.
- **Skeletons** copy the loaded geometry exactly: the hero's height, the shelf header row and the card frames, using the shelf's own column sizes, so nothing moves when content arrives.

## Shell

- **From 1024 px**: a floating sidebar, inset 8 px from the window, in `material` with `rounded-2xl`. It holds the wordmark and the collapse button, then Search, Home, Movies and Shows; under a medium with more than one library, each library, linking to its filtered grid (`/movies?library=<id>`). Settings, for admins, and the account sit at its foot. The account opens a menu with Sign out. Collapsed, it becomes an icon rail with tooltips, and remembers that across visits without a width jump on load. The current section gets the tint wash.
- **Below 1024 px**: a floating tab bar capsule in `material` above the home indicator carries Home, Movies, Shows, Search and, for admins, Settings. The current tab gets the tint and a tint-wash pill. A glass profile button at the top of the page, showing the account's initials, opens the account menu.
- Content starts at `--shell-start`, past the sidebar and the gutter. Full-bleed content may extend under the sidebar with a negative margin of the same size.
- A skip link leads to the content. Page changes cross-fade through view transitions, with the sidebar and tab bar held still; typing in search, sorting and filtering do not fade.
- Viewers cannot list libraries yet (#115), so for them the sidebar shows the medium sections only.

## Admin

Admin is a settings app laid out like System Settings. From 1024 px the same floating sidebar the browse shell uses carries a Home link, a search field and the sections in three groups: Overview and Activity, then Libraries, Users and Groups, then Plugins and General. Typing filters the groups into one flat list. Below 1024 px the section list is the first screen and each section pushes in from the right; the phone tab bar stays, with Settings current, so Home is one tap away. Push and pop animate the content pane like iOS, with a cross-fade on desktop, at equal depth and under reduced motion. The settings screen is labelled General in the nav, because Settings inside Settings would read as itself; its URL stays `/admin/settings`.

- **AdminPage** is the one section layout: a tinted back row (the parent on detail pages, or "Settings" back to `/admin` on phones), a `text-large-title` with its actions at the end of the row on desktop and below it on phone, then a `max-w-3xl` column of groups.
- **FormGroup** is one grouped panel: an optional `text-headline` title, a `rounded-lg bg-elevated` panel, a footnote description and action buttons on the row below it. When its root is a `form` the actions hold the Save button. While it loads, skeleton rows hold the same height. A failure renders between the panel and the footnote.
- **FormRow** is a label/control pair inside a panel, with an inset hairline between rows. From the panel's `@lg` container width up it is a `[12rem_minmax(0,1fr)]` grid; below it stacks. Below that width, `inline` rows keep the label left and the control at the end on one line instead, for switches, selects and read-only values.
- **ListRow** is a navigable row inside a panel: leading content, a title over a caption, trailing content and a chevron. With `href` the whole row is the link.
- **AdminNav** renders the sections for the sidebar and the phone list from the one model in `$lib/admin.ts`, along with the search field.

Saves confirm with a toast and failures stay inline in their own group. Destructive actions go through `ConfirmDialog`, whose title names the loss ("Revoke this session?"). Write-only secrets use `SecretInput`, a password field with an eye toggle. `TabBar` is shared by the browse and admin shells.

Later slices drop a screen in as an `AdminPage` of `FormGroup`s, then remove the path from the legacy list in `routes/admin/+layout.svelte`.

## Screens

- **Page header**: `text-large-title`, with its controls at the end of the same row on desktop and below it on phone, where the title shares its row with the profile button.
- **Home**: the hero carousel from the window's top edge, then the shelves: Continue Watching and Next Up as landscape shelves, every other shelf as posters. The title is for screen readers while the hero shows, and visible on phones otherwise. A hero-sized skeleton and two skeleton shelves hold the page while it loads. Empty Home offers Add a library to admins.
- **Movies and Shows**: a large title, the library's name when filtered, a Sort menu (Recently added, Title) kept in the URL, and the poster grid. It loads 24 cards at a time and fetches the next page 800 px before the end comes into view, with a row of skeleton posters reserving the space and a status for screen readers. There is no Show more button. A failed page shows the error with Try again.
- **Search**: a large title and the search field, focused on arrival with a pointer. Results update 150 ms after typing stops, and the query stays in the URL. They come grouped as Movies and Shows, in the order of each group's best match. The previous results stay, dimmed, until the next answer arrives, so the page never flashes empty while you type. A status tells screen readers how many results matched.
- **Player**: `/play/{id}` fills the window with the video and is always dark. Nothing is pinned above the picture. Two bands fade in and out together over it. On top, over a soft gradient: a glass Back button and the title, with an Episode's Show and code under it. At the bottom, over a gradient from the bottom edge: the scrubber with elapsed time on the left and remaining time (`−2:19`) on the right, then a row with mute and volume on the left, Back 10 seconds, Play and Forward 10 seconds in the centre, and Picture in Picture, the settings gear and Full Screen on the right. On phones the transport moves to the middle of the screen, larger, over a soft radial scrim, and the volume slider gives way to the device's buttons.
  - The controls and the cursor fade after 3 s without pointer movement, taps or keys. They stay while paused or ended, while a notice shows, while the settings menu is open, while a mouse rests on the bottom band and while keyboard focus is in a band; a clicked button does not hold them. A click on the picture plays or pauses, and a double click toggles fullscreen. On touch, a tap shows or hides the controls, and a double tap on the left or right third skips 10 s with a fading wash.
  - Keys: Space or K plays and pauses, Left and Right skip 10 s, Up and Down step the volume, F toggles fullscreen, M mutes and C turns subtitles off and back on. They leave focused buttons, sliders and open menus to their own keys.
  - Fullscreen takes the whole player, so the controls come along. An iPhone, which has no element fullscreen, uses the video's own.
  - Captions use `::cue`: white on a 72% black box, sized from the window's short side, and lifted above the bottom band while it shows. The lift uses `::-webkit-media-text-track-container`, so Firefox keeps captions at the bottom.
  - A Version, audio or subtitle change restarts the session at the current position and keeps a paused video paused. A Version switch rewrites `?version=` in place, so the player never reloads, and resets the audio and subtitle choice, since Streams belong to a File.
  - Notices sit centred in a `material-thick` panel: Cannot play this Version, Server unreachable and Playback stopped. The scrubber, volume, transport and Picture in Picture hide with a notice, while the settings gear and Full Screen stay, so another Version or subtitle choice can recover. The last two offer Try again. A spinner appears after 400 ms of buffering. Back returns through history when the detail page opened the player.
  - The scrubber and volume are white, as in the Apple TV app's player, rather than the tint: over a film, the accent would be one more colour competing with the picture. The focus ring stays tint.
  - The state lives in `src/lib/player-state.ts`, a store with no DOM that `bun test` covers. The components render it and forward events to it.
- **Sign in, setup, invite and errors**: `FocusScreen`, a centred card on `bg-elevated` under a faint tint wash (plain `bg-background` full-bleed below 640 px, content starting a sixth of the way down). Optional Lucide icon over a large title. Single sign-on sits above the password form as a full-width secondary button with an `or` divider, a peer not a footnote. Sign in shakes the card once on a wrong password (a keyframed four-leg shake, gone under reduced motion). Setup walks Account, Library and Scan under a numbered stepper; Account collects fields only, and Add library creates the admin, the library and the scan, so Back exists only until the account is made. The Scan step shows an indeterminate or determinate `Progress`, the success check when done, `Scan again` on failure and an `Open Settings` link. The error page covers unreachable, not-found and generic failures, each with one action. A service worker caches the build, the fonts and `200.html`; with the server stopped the app still opens and the first failed request shows `Server unreachable` with `Try again`.

## Temporary aliases

`src/lib/legacy.css` keeps screens that are not yet redesigned readable. It scopes the old element styles under a `.legacy` class and aliases the old token names. Each redesign slice removes its screen's `legacy` class; the last one deletes the file.

| Old name | Now |
| --- | --- |
| `--canvas` | `--background` |
| `--ink` | `--label` |
| `--muted` | `--label-secondary` |
| `--signal` | `--tint` |
| `--danger` | `--destructive` |
| `--surface` | `--background-elevated` |
| `--line` | `--separator` |

Screens still on `legacy`: the detail pages (#109), and admin libraries, plugins and activity (#113, #114).

## Not yet redesigned

These notes describe behaviour the later slices keep while they restyle it.

- **Detail pages** (#109) lead with the backdrop when one exists, then the poster beside the title, facts, an actions row and the overview. Seasons, Episodes, Versions and credits follow as their own sections. Movie and Episode pages put Play in the actions row; with unfinished Progress it shows Resume from the saved position, as the primary button, and Play from start beside it. The row keeps a 44 px height while it loads.
