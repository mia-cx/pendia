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
- `shadow-float` lifts menus, the sidebar and the tab bar off the page. `shadow-lift` is the shadow under a lifted poster.

### Motion

After the transitions.dev scale: `--duration-quick` 150 ms for closes and tooltips, `--duration-fast` 250 ms for opens, hovers and page fades, `--duration-medium` 350 ms for sheets, `--duration-slow` 400 ms for image fades and toasts. `ease-smooth-out` settles everything; `ease-spring` carries a small overshoot for lifts and the switch thumb. Opens are slower than closes. Under reduced motion, a global rule zeroes tw-animate's translate, scale and rotate, so every sheet, menu and dialog fades instead of moving, and lifts become a shadow change.

### Focus

One ring for every control: a 2 px tint outline, 2 px out, from `:focus-visible` in `app.css`. Components never draw their own.

## Components

The shadcn-svelte set lives in `src/lib/components/ui`, on bits-ui for keyboard and ARIA behaviour, restyled to these tokens. Screens use only these and the media components below; no screen styles a raw control. The dev-only `/design` page renders every component in every state and is the reference to check against; production builds answer it with 404.

- **Button**: `default` (label colour), `secondary` (fill), `ghost`, `outline`, `tinted`, `glass` (material, for buttons over artwork), `destructive` and `link`. Sizes `sm` 32, `default` 40 (44 on touch), `lg` 48, and round `icon-sm`, `icon`, `icon-lg`. Buttons press down to 97%.
- **Input**: a filled field with no border, 17 px on phones so iOS does not zoom, 15 px from 1024 px.
- **Select**: an Apple pop-up button with up-down chevrons; the chosen item shows a leading check.
- **Dropdown menu, popover, tooltip**: `material-thick`, growing from their trigger. Tooltips wait 500 ms and close at once.
- **Dialog, alert dialog, sheet**: over the scrim. Alerts are compact and centred, with two full-width buttons that name the action. Side sheets float inset from the edge; bottom sheets carry a grabber.
- **Slider, switch, tabs**: the tint fills the range and the on switch. Tabs are a segmented control.
- **Table**: hairline rows, footnote headers, tabular numbers.
- **Textarea**: the same filled field as Input, `min-h-24` and vertically resizable.
- **Toast**: svelte-sonner, bottom centre and above the tab bar on phones, following the system scheme.
- **Badge, skeleton, scroll area**: capsules, pulsing fills, and overlay scrollbars that show on hover.

## Media components

- **Poster** reserves a 2:3 frame before its image loads, draws a hairline so light artwork does not bleed into a light page, and fades the image in. Without artwork it shows a styled fallback: a soft gradient, the medium's icon and the title set large. A Season or Episode without a poster borrows its Show's, and its fallback names the Show.
- **Poster card** puts the title (two lines) and one caption under the frame. Movies and Shows caption their year; Episodes their Show and code, such as `Severance · S1 E2`. Hover and keyboard focus lift the frame with a spring and a shadow, and the focus ring sits on the frame. Continue Watching cards draw a tint progress bar, over a soft scrim when there is artwork, and announce the percentage to screen readers. A failed image falls back like a missing one.
- **Shelf** is one row that scrolls sideways and snaps to cards. It bleeds under the sidebar, so cards slide beneath its material. On pointer devices, when the row overflows, glass arrow buttons page it and disable at the ends. The header keeps one height with or without them.
- **Poster grid** fills the width with columns at least 152 px wide, or three across on a phone.
- **Skeletons** copy the loaded geometry exactly: the shelf header row, the 2:3 frame, a title line and a caption line, so nothing moves when content arrives.

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
- **Poster** takes `compact` for thumbnails in rows: without artwork it shows only the medium's icon.
- **ListRow** is a navigable row inside a panel: leading content, a title over a caption, trailing content and a chevron. With `href` the whole row is the link.
- **AdminNav** renders the sections for the sidebar and the phone list from the one model in `$lib/admin.ts`, along with the search field.

Saves confirm with a toast and failures stay inline in their own group. Destructive actions go through `ConfirmDialog`, whose title names the loss ("Revoke this session?"). Write-only secrets use `SecretInput`, a password field with an eye toggle. `TabBar` is shared by the browse and admin shells.

Later slices drop a screen in as an `AdminPage` of `FormGroup`s, then remove the path from the legacy list in `routes/admin/+layout.svelte`.

## Screens

- **Page header**: `text-large-title`, with its controls at the end of the same row on desktop and below it on phone, where the title shares its row with the profile button.
- **Home**: shelves stacked, with skeleton shelves while they load. The title shows on phones only, as in the iOS TV app. Empty Home offers Add a library to admins.
- **Movies and Shows**: a large title, the library's name when filtered, a Sort menu (Recently added, Title) kept in the URL, and the poster grid. It loads 24 cards at a time; Show more loads the next page and also fires as it scrolls into view. Skeleton posters hold the grid while the first page loads.
- **Search**: a large title and the search field, focused on arrival with a pointer. Results update 250 ms after typing stops, and the query stays in the URL.

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

Screens still on `legacy`: the detail pages (#109), the player (#110), sign in, setup, invite and the error page (#111), and admin libraries, plugins and activity (#113, #114).

## Not yet redesigned

These notes describe behaviour the later slices keep while they restyle it.

- **Detail pages** lead with the backdrop when one exists, then the poster beside the title, facts, an actions row and the overview. Seasons, Episodes, Versions and credits follow as their own sections. Movie and Episode pages put Play in the actions row; with unfinished Progress it shows Resume from the saved position, as the primary button, and Play from start beside it. The row keeps a 44 px height while it loads.
- **Player**: `/play/{id}` fills the window and is dark in both schemes. One bar on top holds Back, the title (an Episode adds its Show and code) and a Version select when the Item has more than one Version. The video keeps the browser's controls for now. Notices sit over the stage without moving anything: Cannot play this Version, Server unreachable and Playback stopped; only the last two offer Try again, which restarts at the current position. Back returns through history when the detail page opened the player.
- **Offline**: a service worker caches the build, the fonts and `200.html`. With the server stopped, the app still opens, and the first failed request shows Server unreachable with Try again. API calls and media never pass through the worker.
