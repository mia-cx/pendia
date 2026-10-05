# Pendia web design

Pendia should feel like Apple built a self-hosted media player. Artwork leads, the chrome is translucent and quiet, titles are large and confident, and one accent marks what matters. This file is the system's source of truth. Each redesign slice extends it rather than repeating it.

## Principles

- Artwork carries the colour. Chrome is neutral, so a poster is the loudest thing on screen.
- One accent, the tint. It marks the current section, progress, focus, switches and sliders. The primary button is the label colour, near-black on light and white on dark, as in the Apple TV app.
- Materials sit over content, never beside it. A sidebar, tab bar or menu blurs what scrolls beneath it.
- Motion is short and physical: things lift, rise and settle. Reduced motion keeps every fade and drops every movement.
- Geometry is reserved before content loads, so nothing jumps.

## Tokens

All tokens live in `src/lib/app.css`. Each colour is defined once with `light-dark()`, so a subtree that sets `color-scheme: dark` gets the dark values. The player does this to stay dark in both schemes. Light and dark follow the system setting; there is no theme switch.

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

After the transitions.dev scale: `--duration-quick` 150 ms for closes and tooltips, `--duration-fast` 250 ms for opens, hovers and page fades, `--duration-medium` 350 ms for sheets, `--duration-slow` 400 ms for image fades and toasts. `ease-smooth-out` settles everything; `ease-spring` carries a small overshoot for lifts and the switch thumb. Opens are slower than closes. Under reduced motion, a global rule zeroes tw-animate's translate, scale and rotate, so every sheet, menu and dialog fades instead of moving, and lifts become a shadow change.

### Focus

One ring for every control: a 2 px tint outline, 2 px out, from `:focus-visible` in `app.css`. Components never draw their own.

## Components

The shadcn-svelte set lives in `src/lib/components/ui`, on bits-ui for keyboard and ARIA behaviour, restyled to these tokens. Screens use only these and the media components below; no screen styles a raw control. The dev-only `/design` page renders every component in every state and is the reference to check against; production builds answer it with 404.

- **Button**: `default` (label colour), `secondary` (fill), `ghost`, `outline`, `tinted`, `glass` (material, for buttons over artwork), `destructive` and `link`. Sizes `sm` 32, `default` 40 (44 on touch), `lg` 48, `pill` 44 (the round-ended Play button on heroes), and round `icon-sm`, `icon`, `icon-lg`. Buttons press down to 97%.
- **Input**: a filled field with no border, 17 px on phones so iOS does not zoom, 15 px from 1024 px.
- **Select**: an Apple pop-up button with up-down chevrons; the chosen item shows a leading check.
- **Dropdown menu, popover, tooltip**: `material-thick`, growing from their trigger. Tooltips wait 500 ms and close at once.
- **Dialog, alert dialog, sheet**: over the scrim. Alerts are compact and centred, with two full-width buttons that name the action. Side sheets float inset from the edge; bottom sheets carry a grabber.
- **Slider, switch, tabs**: the tint fills the range and the on switch. Tabs are a segmented control.
- **Table**: hairline rows, footnote headers, tabular numbers.
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
- **Skeletons** copy the loaded geometry exactly: the hero's height, the shelf header row and the card frames, using the shelf's own column sizes, so nothing moves when content arrives.

## Shell

- **From 1024 px**: a floating sidebar, inset 8 px from the window, in `material` with `rounded-2xl`. It holds the wordmark and the collapse button, then Search, Home, Movies and Shows; under a medium with more than one library, each library, linking to its filtered grid (`/movies?library=<id>`). Settings, for admins, and the account sit at its foot. The account opens a menu with Sign out. Collapsed, it becomes an icon rail with tooltips, and remembers that across visits without a width jump on load. The current section gets the tint wash.
- **Below 1024 px**: a floating tab bar capsule in `material` above the home indicator carries Home, Movies, Shows, Search and, for admins, Settings. The current tab gets the tint and a tint-wash pill. A glass profile button at the top of the page, showing the account's initials, opens the account menu.
- Content starts at `--shell-start`, past the sidebar and the gutter. Full-bleed content may extend under the sidebar with a negative margin of the same size.
- A skip link leads to the content. Page changes cross-fade through view transitions, with the sidebar and tab bar held still; typing in search, sorting and filtering do not fade.
- Viewers cannot list libraries yet (#115), so for them the sidebar shows the medium sections only.

## Screens

- **Page header**: `text-large-title`, with its controls at the end of the same row on desktop and below it on phone, where the title shares its row with the profile button.
- **Home**: the hero carousel from the window's top edge, then the shelves: Continue Watching and Next Up as landscape shelves, every other shelf as posters. The title is for screen readers while the hero shows, and visible on phones otherwise. A hero-sized skeleton and two skeleton shelves hold the page while it loads. Empty Home offers Add a library to admins.
- **Movies and Shows**: a large title, the library's name when filtered, a Sort menu (Recently added, Title) kept in the URL, and the poster grid. It loads 24 cards at a time and fetches the next page 800 px before the end comes into view, with a row of skeleton posters reserving the space and a status for screen readers. There is no Show more button. A failed page shows the error with Try again.
- **Search**: a large title and the search field, focused on arrival with a pointer. Results update 150 ms after typing stops, and the query stays in the URL. They come grouped as Movies and Shows, in the order of each group's best match. The previous results stay, dimmed, until the next answer arrives, so the page never flashes empty while you type. A status tells screen readers how many results matched.

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

Screens still on `legacy`: the detail pages (#109), the player (#110), sign in, setup, invite and the error page (#111), and admin (#112 to #114).

## Not yet redesigned

These notes describe behaviour the later slices keep while they restyle it.

- **Detail pages** (#109) lead with the backdrop when one exists, then the poster beside the title, facts, an actions row and the overview. Seasons, Episodes, Versions and credits follow as their own sections. Movie and Episode pages put Play in the actions row; with unfinished Progress it shows Resume from the saved position, as the primary button, and Play from start beside it. The row keeps a 44 px height while it loads.
- **Player**: `/play/{id}` fills the window and is dark in both schemes. One bar on top holds Back, the title (an Episode adds its Show and code) and a Version select when the Item has more than one Version. The video keeps the browser's controls for now. Notices sit over the stage without moving anything: Cannot play this Version, Server unreachable and Playback stopped; only the last two offer Try again, which restarts at the current position. Back returns through history when the detail page opened the player.
- **Offline**: a service worker caches the build, the fonts and `200.html`. With the server stopped, the app still opens, and the first failed request shows Server unreachable with Try again. API calls and media never pass through the worker.
