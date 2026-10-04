# Pendia web design

The browse client is where someone picks what to watch. Posters carry the colour; the chrome stays quiet so the artwork reads first.

## Layout

- One header on every browse screen: the Pendia mark, Home, Movies and Shows, a search field, then Admin for built-in admins and Sign out. Below 720 px it folds into three rows: mark and account, sections, then a full-width search field.
- Content sits in one column with a fluid side gutter, `--gutter`, from 16 px to 40 px.
- Home stacks its shelves. Each shelf is one horizontal row that scrolls and snaps to cards, so a long shelf never pushes the next one off screen.
- Movies, Shows and search results share one poster grid, `.poster-grid`: columns at least 140 px wide, or a quarter of the viewport on a phone, which keeps three posters across.
- The Movies and Shows grids load 24 cards at a time. Show more loads the next page and also fires as it scrolls into view, so scrolling just continues.
- A detail page leads with the backdrop when one exists, then the poster beside the title, facts, an actions row and the overview. Seasons, Episodes, Versions and credits follow as their own sections. The actions row is where the web player adds Play.

## Cards

- A poster card reserves a 2:3 frame before its image loads, so nothing shifts.
- A missing poster shows the title inside the frame on `--surface`. A Season or Episode without its own poster borrows its Show's.
- Under the frame: the title, clamped to two lines, and one caption line. Movies and Shows caption their year. Episodes caption their Show and code, such as `Severance · S1 E2`.
- Continue watching cards draw a progress bar across the bottom of the frame and announce the percentage to screen readers.

## Type

The system UI stack, as in the admin screens. Titles at 600 weight, captions in `--muted` at 13 px. Headings follow `app.css`: 28 px pages, 20 px sections.

## Colour

The admin tokens in `app.css` with two additions: `--surface` fills empty poster frames and `--line` draws rules. Light and dark follow the system setting, and high-contrast mode keeps its stronger ink. `--signal` marks the current section, hover and focus, and progress.

## Player

- Movie and Episode pages put Play in the actions row. With unfinished Progress the row shows Resume from the saved position, as the primary button, and Play from start beside it. The row keeps a 44 px height while it loads.
- `/play/{id}` fills the window. One bar on top holds Back, the title (an Episode adds its Show and code underneath), and a Version select when the Item has more than one Version. Below 640 px the select takes its own row. The video fills the rest with `object-fit: contain`.
- The stage is dark in both colour schemes: the player sets the dark tokens on its own root, so its controls and select render dark too.
- The video element keeps the browser's own controls: play, seek, volume, fullscreen and the captions menu that lists the WebVTT tracks. They are keyboard operable and familiar on every platform.
- Notices sit over the stage, centred, without moving anything: Cannot play this Version, Server unreachable and Playback stopped. Only the last two offer Try again, which restarts at the current position.
- Back returns through history when the detail page opened the player, so the browser's own Back does not land on the player again.

## Offline

A service worker caches the build and `200.html`. With the server stopped, the app still opens, and the first failed request shows Server unreachable with Try again. API calls and media never pass through the worker.

## Shape

Posters round at `--radius-poster`, 8 px. Hovering a poster draws a 2 px `--signal` outline, the same as keyboard focus.
