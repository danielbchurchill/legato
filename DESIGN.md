# Legato — Design System

**This file is ground truth for how Legato looks and why.** [AGENTS.md](AGENTS.md) owns how to work in this repo. This file owns the visual language, and `src/styles/tokens.css` is its machine-readable half — when the two disagree, this file explains the intent and the token file wins on values.

Source of truth for the design itself: Figma file `NSaK1N64NwcKzlKpqaYs49`. The original **Desktop - 1** frame (1440 × 1024) is still ground truth for anything not called out below. **Design v2** (canvas "version 2", frames **Search**, **Music Map**, **Panel Collapse**) is a new direction, still WIP as of 2026-08-27 — sections below marked *v2* reflect decisions confirmed against it so far. A full survey of the "version 2" canvas on 2026-08-30 confirmed those three frames are the entirety of it — there is no fourth v2 frame waiting to be found, and every rail icon and shell measurement in it has now been checked. What's still open: the transport dock's v2 redesign, and the Search panel's populated-query state — both flagged where they're discussed below, not resolved.

The library view is the exception. Its frame was designed in Claude Design rather than Figma (issue #263), and it arrived as part of the "Legato v2" handoff described just below, which is now ground truth for it. "The library", in that section, is where it's written down.

Every value below was measured from the relevant frame and then cross-checked against the exported render by sampling pixels, where a render exists to sample. v2 values are measured from Figma's own dev-mode output instead — no exported render to verify against yet, so treat those as provisional until one exists. Where a value disagreed with its render, the note says so.

**Legato v2 supersedes much of what follows.** The Claude Design handoff "Legato v2" (October 2026; the brief lives in legato-plans/design/) redesigned every surface, and the app now follows it. Where the sections below disagree with "Legato v2" directly under this paragraph, v2 wins; the older sections stay for the reasoning that still holds (glass over a live graph, hairlines with alpha, reduced motion, the progress exceptions) and as a record of how the app got here.

---

## Legato v2

The idea is unchanged: the graph runs edge to edge and everything floats over it in glass. What changed is hierarchy. v1 put everything at one visual weight, in too much low-contrast grey; v2 gives the app a type ramp, three ink steps, one accent, and cover colour as a real material.

### Tokens

`src/styles/tokens.css` holds them, per theme. The roles:

- **Surfaces:** `canvas`, `surface` (glass, always behind `blur(22px) saturate(140%)` — the `glass` utility in `index.css`), `solid` (the search palette, and glass's no-blur fallback), `raised` (an active segment), `sunken` (a segmented track, an input well).
- **Lines and washes:** `line` (hairlines, panel borders), `line-strong` (chip borders), `wash` (hover, cards), `wash-2` (selected, secondary buttons).
- **Text:** `ink`, `ink-2`, `ink-3`, each clearing WCAG AA on canvas in both themes. Text is never alpha-muted: a quieter line is `ink-2` or `ink-3`.
- **Accent:** `accent` is solid (accent text, rings, focus, the map's selection ring). `--accent-fill` is the legato.fm gradient (primary buttons, play, a switch that's on, progress). Text on the gradient is always the dark `on-accent`; white fails contrast on its blue end. Paper darkens the solid accent to `#7d38b0`, because `#bf68eb` can't carry text on paper.
- **Status:** `ok`, `warn`, `bad`. The only place hue carries meaning outside the map, and always next to words that say the same thing.
- **Map:** `edge` (every unfocused edge), `node-artist/release/recording/credit`, `halo` (the stroke behind a map label), `--map-glow`.

The pre-v2 names (`muted`, `hairline`, `control`, `inset`, …) are aliases onto these roles, kept until nothing reads them.

### Type

Rubik for every word, music titles included — the v1 rule that titles were mono is retired. Sometype Mono for numbers, durations, counts, formats, paths and IDs, always tabular (the `mono` utility). The large stat figures in Health and node details are Rubik with tabular figures. The ramp is `text-display` 30/36, `text-title` 20/26, `text-heading` 15/20, `text-body` 14/20, `text-secondary` 13/18, `text-small` 12/16, `text-label` 12/16 500 +0.02em, `text-mono` 12/16; each utility sets size, line height, weight and tracking together. Sentence case for headings, lowercase for labels and control text.

### Geometry

Radii: panel 20, rail and popovers 18, card 14, control 10, cover art 6 (4 on a 36px thumbnail, 10 on a hero). Covers now have a radius and a 1px inset edge (`--shadow-art-edge`); the art itself is still never tinted or filtered.

The shell floats 12px in from every edge: a 56px rail, a 320px left panel beside it, a 360px right panel, a 72px player. The capsule, player and search palette centre on the free space between the left and right occupancy, not on the window. `src/shell/layout.ts` does that arithmetic once, for the shell and for the map's camera.

### Shell

- **Rail:** Collections (favourites, playlists, import), Library health (database inspector, tag manager, maintenance worklists), then Settings and the avatar. Seven destinations became three; map settings moved onto the map.
- **Capsule:** the map/library switch and the way into search (⌘K/Ctrl-K from anywhere, or `/`).
- **Right panel:** now playing (up next, lyrics, details) or node details. It replaces the full-screen inspector modal, so the map stays visible. One right panel at a time; Escape closes it, then clears the selection, then closes the left panel.
- **Player:** replaces the 514×121 dock. It takes a wash of the playing cover's colour from its left edge. The waveform is the server's existing loudness envelope (`/files/:id/peaks`), and a seeded shape stands in until it arrives. With nothing loaded, it's an idle pill with "Shuffle library", which queues up to 500 random tracks from the library. The pill sits where the bar would, inside its width.

#### The player as it narrows

The player is as wide as the free space less 48px, up to 720. As that shrinks, its parts give way in a fixed order, each at the bar width where it stops fitting (#293):

| Bar under | What goes | Window under, both panels open |
|---|---|---|
| 614px | The title column drops to 112px and the waveform to 24 bars (compact) | 1438px |
| 470px | The title column. The cover still says what's playing, and the title stays for screen readers | 1294px |
| 344px | Queue and volume | 1168px |
| 264px | The cover | 1088px |
| 202px | Shuffle, repeat and the scrubber | 1026px |

Previous, play/pause and next never go. With the bar's border and padding they need 134px, and the bar stops narrowing there. The desktop app's narrowest window (1100) with both panels open gives a 276px bar: the cover, the whole transport and the waveform, with nothing clipped.

The order keeps what controls playback longest and drops what's said or reachable elsewhere first. The title is in the now-playing panel, which is usually what's open beside a narrow bar. Closing a panel brings everything back. The waveform is the first thing to narrow, from 56 bars to 24, but after that it costs no width of its own, because it sits under the transport. So it goes last, with shuffle and repeat. A playback problem's message and its one action replace the scrubber at every width, and still fit under previous, play and next.

Only a browser goes narrower than 958px with both panels open. There, the bar holds at 134px and its margins close up. Under 910px it floats over the panels' inner edges, staying inside the window, rather than letting play/pause shrink away. The alternatives were closing a panel for the user, or stopping the right panel above the player again, which #288 removed.

The handoff puts the compact switch at 600px. Its 56 bars at their 1px minimum with 2px gaps only fit from 614, and between the two the waveform ran 6px into the duration, so compact starts at 614. `src/shell/layout.ts` works every threshold out from the parts' sizes (`playerContentWidth`).

#### The idle pill as it narrows

With nothing loaded, the idle pill takes the bar's place. It centres where the bar would (`playerCx`) and is never wider than the bar would be, so it follows the same free space and the same 134px floor (#308). It hugs its content, on one line, and its parts give way in this order:

| Bar under | What goes | Window under, both panels open |
|---|---|---|
| 328px | The space keycap. The button's tooltip says space instead | 1152px |
| 272px | "Nothing playing". The button alone says it | 1096px |
| 156px | The button's label. Its icon stays in a round pill, named in the tooltip and for screen readers | 980px |

The button stays one element at every width, so a keyboard user's focus stays on it as the pill narrows. Its tooltip, "Shuffle library" with space, shows once the keycap has gone. Beside the keycap it would only repeat the pill.

At the desktop app's narrowest window with both panels open, the bar would be 276px, and the pill shows "Nothing playing" and the button inside it, clear of both panels. Before #308 the pill was a fixed 324px on the free space's centre: at 1100 it touched the left panel, and in a narrower browser window it overlapped both.

#### The capsule as it narrows

The capsule is as wide as the free space less 48px, up to 520. Its parts give way the same way, at the capsule width where each stops fitting (#308):

| Capsule under | What goes | Window under, both panels open |
|---|---|---|
| 511px | The placeholder shortens to "Search" | 1335px |
| 364px | The keycap. ⌘K/Ctrl-K and `/` still open search | 1188px |
| 303px | "Search". The magnifier stays | 1127px |
| 247px | The switch's "map" and "library". Their icons stay, and each label moves into its tab's tooltip and stays for screen readers | 1071px |

The switch and the search button never go. With the switch's icons and the magnifier the capsule needs 135px, and it stops narrowing there. Under 959px with both panels open its margins close up, and under 911px it floats over the panels' inner edges, inside the window, as the bar does. At 1100 with both panels open it's 276px, the labelled switch and the magnifier. The search palette opens over the capsule wherever it sits, and moves off it only as far as the window makes it.

The words go before the switch's labels because a magnifier needs no caption, and the map and library icons are Legato's own. The keycap is counted at its "Ctrl K" width, the wider of the two, so the thresholds are the same on every platform and a Mac's "⌘K" has some slack.

Unlike the bar's, most of the capsule's and the pill's widths are text, so they're measured rather than added up: in Chromium, with the self-hosted fonts, rounded up to the next pixel (`src/shell/capsuleGeometry.ts`, `src/shell/playerGeometry.ts`). Changing a label or a font means measuring again. Another engine, or a fallback font before Rubik loads, can draw a label a little wider, so every set of parts with text in it keeps 3px to spare. Both pills also clip to their own width, as the bar does, so anything wider still is cut off at the edge rather than spilling out. The padding, gaps and icons around the text are the shared controls' own (Tabs, Button and Kbd). `src/shell/controlGeometry.ts` copies them for the arithmetic, and the shell's specs check each copy against the class it's drawn with.

### The map

Nodes are dots, sized and toned by type. Covers at node size made the map a mosaic rather than a graph; cover colour comes back as each artist cluster's glow, the average of its records' thumbnails, computed client-side (`src/ui/coverColor.ts`). A cluster is an artist, its tracks (by first credit) and its records (by a majority of their tracks) — `src/canvas/clusters.ts`.

Selecting a node focuses its cluster and flies the camera to frame it, landing the node where its 340px card has room. Out-of-focus nodes drop to 30% (mixed toward the canvas, since sigma's node program can't composite alpha), their labels to 45%, other edges to 60%, other glows to 35%. The focused cluster's edges take their type colours. With nothing selected, a held hover focuses the hovered node's neighbours; a selection always wins over a hover.

Labels: artists 13/500 ink, credits 11/400 ink-3, and the focused cluster's records 11/400 ink-2, all over a 4px halo. Three decisions the mock didn't have to make, because its nine artists never collide:

- **Labels are placed greedily per frame,** focused first, then artists before credits before records, bigger dots first. A label that would overlap one already placed is skipped. "Artists are always labelled" holds wherever there's room, and zooming in reveals the rest. A real library's featured-only artists cluster tightly around the people they featured with.
- **A glow's radius is capped by its cluster's extent.** The v2 formula, `min(w,h) × (0.08 + size × 0.012)`, alone turns two hundred artists into one wash.
- **Edges thin as you zoom out, and hold their width as you zoom in.** v2's flat 0.6px at 11% alpha can't be seen on paper, least of all at the overview, where every edge is on screen at once. Width follows the camera ratio instead (`src/canvas/edgeWidth.ts`): 1.3px framing the whole map and at every zoom closer in, thinning by the fourth root of the zoom past the overview to a 0.8px floor. The dots grow and shrink by the square root, so up close the edges stay visible beside bigger dots without a focused cluster's turning into ribbons, and far out the map reads as the overview in miniature rather than a knot. Every step stays under v1's 1.7px. A focused cluster's edges draw a third wider. The old "links › thickness" setting isn't read any more, because nothing in v2 can change it.

The layout is kept (#274). The map promises this much:

- **The same library opens the same way.** Each time the physics settles, the client saves where every node came to rest. A visit that finds every node at a saved spot shows them there and runs no physics, so the map, and the labels that fit on it, match the last visit exactly.
- **A small scan moves only what it touched.** New tracks start beside the record and artist they join, and only nodes within two links of a change move while it settles. The rest of the map holds still. A new artist with nothing on the map yet starts at its seed.
- **A drag beats anything automatic.** A drag is saved where it's dropped. Physics may carry the node on from there (#46), and it reopens where it came to rest. Lock layout freezes the physics, so nothing moves or saves until it's unlocked.
- **Rebuild map is the fresh start.** It clears every saved spot and drag, and the map settles again from new seeds.

It doesn't promise that a drag or a force slider leaves the rest of the map alone: both move everything, as live physics does, and the result is what's kept. Two clients on one server both save, and the last to settle wins.

### The library

The map's other view of the same music (#126's switch, now in the capsule), laid out from `LibraryStageV2`, the handoff's library frame, whose README "Library" section is the spec. #263 measured the frame in a browser and matched the build to it at 1440 × 1024. Where they disagreed, the frame won: the shelf's captions, the header controls' height, the chevrons, the table header's hairline.

**The stage sits between the panels, not under them.** The library takes the free space between the shell's left and right occupancy (`src/shell/layout.ts`, the same numbers the capsule and player centre on), never the whole window. A panel opening narrows the stage and the grid reflows to fewer columns, so nothing starts under glass. The map can leave content under a panel because a node can be panned out from under it. A grid that fills from the left edge can't: before v2, with the left panel open, the first column was always behind it (#263). Rows still scroll up under the capsule and fade out under the player, which is the layering the app is built on; what's protected is where things come to rest. The reflow isn't animated, because the panel's arrival is already the interaction's one movement. #263 checked it at 1280, 1440 and 2560 wide, with the left panel, the right panel and both open, in ink and paper, and nothing sat under a panel on first paint. At 1280 with both open the stage is 504px wide, the header's controls wrap under the title, and the grid holds two columns, as the frame's 1280 window draws it.

**Geometry.** What the grid and table share, and what their virtualisers compute with, is a `--library-*` token in `tokens.css`, measured from the frame:

| Token | Value | What it is |
|---|---|---|
| `--library-cell-min` | 168px | The narrowest a grid cover gets. The grid is `repeat(auto-fill, minmax(168px, 1fr))`: as many columns as fit, sharing what's left |
| `--library-column-gap` | 24px | Between grid columns |
| `--library-row-gap` | 28px | Between grid rows |
| `--library-shelf-cover` | 148px | A "Recently added" cover, which doesn't flex |
| `--library-shelf-gap` | 20px | Between shelf covers |
| `--library-track-row` | 48px | A track row |

The virtualisers read these back from the computed style (`src/library/tokens.ts`) rather than keeping a second copy. Everything else is layout inside one component, so it stays there as a commented constant that cites the frame: the stage's 88px top inset (the capsule's 60px plus 28px) and 32px sides, the 120px fade, 28px from the header to the shelf or grid and 24px to the table, 12px from a heading to its covers, 32px from the shelf to "All albums" and 14px from there to the grid, a cell's 10px gap, 20px title line and 16px artist line, and the table's 32px header over a hairline and 36px covers. The table's columns are layout arithmetic too, in `src/library/trackColumns.ts`, because which of them show depends on its width (below).

The table keeps the frame's 48px rows rather than v1's 33px `--spacing-row`: a 36px cover needs the room, and 33px was a panel list's pitch, never a table's.

**Header.** "Library" in display over the counts (secondary), with the albums/artists/tracks segmented control and the sort pill on the right. The segments are 30px in the control's 2px well, 34px overall, level with the 34px pill beside them (`Tabs` size `md`). The pill names the order ("artist A–Z") beside a 16px chevron. The header stays in every state, as the frame keeps it; its counts line reads "Loading…" or "Nothing here yet" while there's nothing to count. The counts are `GET /stats`'s, the numbers Library health shows, counted on the server over the whole library. They used to be counted from the map's graph, which stops at 5,000 nodes, so a 30,000-album library read "455 albums · 0 artists" (#302). The artist count is the Artists tab's own rule, below, so the header and the tab always agree.

**Albums.** A "Recently added" shelf, then "All albums" with its mono count, then the grid. The shelf is one row of 148px covers, clipped rather than scrolled. It asks for as many of the newest albums as its width holds, counting the one the edge cuts, so it's full at any width. A shelf cover is captioned with the title and the artist, 8px under it; a grid cover with the title and "Artist · Year", 10px under. "see all" switches the grid to newest-first rather than opening another view. On hover a cover lifts 3px into `--shadow-panel`, and a 40px play button shows 10px in from its corner.

**Artists.** The frame doesn't draw this layout. It reuses the albums grid's tokens and rhythm with round photos, because on the map a circle is an artist and a square a record. It lists every artist with records of its own: the primary artist of at least one album, by the rule the map's clusters use (each track with a file goes to its first credit that is an artist, each record to whoever most of its tracks went to). An artist only ever featured, or credited second, is left out, because their name would lead nowhere (#276). The rule lives on the server (`LIBRARY_ARTISTS` in `server/src/routes/library.ts`), where `GET /library/artists` pages through it and `GET /stats` counts it. The grid is virtualised and paged exactly as the albums grid is (`CoverGrid`, `useLibraryPage`), since a large library's artists run to thousands.

**Tracks.** The header row is label style over a hairline. The sorted column is ink with a 14px chevron, and clicking it again flips the order. Rows have `--radius-control` corners and a 36px cover at `--radius-art-sm`. The `#` column is the row's play control: the mono number in ink-3 at rest, a play glyph on hover or focus, and on the playing row the accent equaliser, with the row in `--color-wash-2` and its title in the accent. The format is a mono 10px badge on a `--color-line-strong` hairline.

The frame's columns are `36px 40px 3fr 2fr 2fr 64px 56px 92px` (#, cover, title, artist, album, time, format, added), 14px apart and 12px in from each end. The `fr` columns are `minmax(0, …)`, so a long title truncates instead of widening its column. The frame draws them on a 992px stage. Narrower, the fixed columns take nearly everything: at 1280 with both panels open, title, artist and album would share about 30px. So the table gives way in a set order, as the player does: added, then format, then album. A column drops only when the title column would otherwise go under 150px, about eighteen characters of a title, with artist and album at 100px beside it. That one minimum and the frame's widths give every drop point. With all eight columns, the title reaches 150px at a table 760px wide: 24px of padding, 288px fixed, 98px of gaps and 350px across the 7 `fr`. Without added it's 654px (24 + 196 + 84 + 350), and without format as well 584px (24 + 140 + 70 + 350). Below that the table shows #, cover, title, artist and time, and nothing else drops. The column the table is sorted by never drops; the next one in the order goes instead, so the rows' order stays on screen, in that column's header as well as the sort pill. The header, the rows and their placeholders all take the same column list, so a label never sits over the wrong column.

**Sort.** Albums: artist, title, year, date added, recently played (derived from `plays` through the album's recordings). Tracks: title, artist, album, duration, format, date added. Artists: name, without regard to case or accents, so "Ólafur Arnalds" files among the O's. Albums open by artist and tracks by title, both A–Z, and a date starts newest first. Nulls (no year, never played) sort last in either direction (`orderClause` in `server/src/routes/library.ts`).

**States.** DESIGN.md's empty pattern as the v2 frames draw it: what's true as a heading, what to do in one sentence, centred 120px under the header, where the frame centres its own empty state.

- **Loading:** nothing for the first 400ms, then skeletons in the layout's exact shape. That's twelve cells (a cover, a 72% title line and a 48% artist line) fading from full to a quarter, or rows on the table's own columns. The same placeholders stand in for any cell or row whose page hasn't arrived yet while scrolling.
- **First run, with no folder yet:** the header over the frame's "Add your music" (three placeholder covers, one sentence, `Choose a folder`). On the map the same block sits on the bare stage, since the map has no header to keep.
- **A folder, but nothing matched yet:** "Reading your library: Albums appear here as tracks are matched." while a scan runs. If the scan failed, "The scan stopped", its error and `Try again`, the map's own words for it. Otherwise, "No music found: Legato couldn't read anything in your folders. Check them in Settings."
- **A layout with nothing in it**, such as albums in a library whose files carry no album tags: "No albums yet: Tracks without an album tag are listed under tracks." Artists and tracks have their own.
- **No match:** since v2 the library has no filter, so nothing can filter it down to nothing. Search is the palette (⌘K), whose "No matches for …" state is drawn in `V2Search` and built in `SearchPalette.tsx`. Opening a result from the palette while the library is showing opens its details.

**Smooth at 30k albums.** Two mechanisms, from #126. DOM virtualisation (`@tanstack/react-virtual`) keeps the node count down whatever the scroll position. `useLibraryPage` keeps the network down: it sizes the scroll area from the first page's `total` and fetches 150 rows at a time as the visible range reaches them, so 30k rows are never shipped or parsed at once. Covers resolve per page, never for the whole table. A third mechanism came from #263: the virtualiser re-renders the grid or table on every scroll event, so covers and rows are memoised and take stable callbacks, and only the rows entering or leaving re-render. #263 measured all three on a synthetic library of 30,000 albums, 300,000 tracks and 3,000 artists, in headless Chrome at 1440 × 1024, scrolling 40,000px at 3,000px a second. Albums held 60fps with 4 of 835 frames over 20ms, and tracks with 1 of 841, against 64 of 778 and 59 of 783 before the memoising. After a jump anywhere in the list, the rows there fill in within about 0.6 seconds for albums and 1.4 for tracks. That run also found `GET /library/tracks` taking about 5.5 seconds a page at that size, because its count and its sort joined every track's first file, performer and album before counting or applying the limit. They now join only what they read: about 0.1 seconds for the count, and 0.1 to 2 seconds for the page depending on the sort. #302 measured the Artists tab the same way, on that library with 3,000 artists listed and 40 featured-only ones left out: 0 of about 860 frames over 20ms in each of three runs, and a jump anywhere fills in within about 0.06 seconds. The same run found `GET /stats` taking about 4.7 seconds, because its top artist and top album walked every edge looking for plays. They now start from the plays, and `/stats` answers in about 0.15 seconds.

**Opening and playing.** A click on a cover, row or artist opens its details in the right panel, since there's no node card off the map. A cover's play button plays the album, and the `#` column plays the track.

Still open: switching back to the map doesn't fly the camera to what was opened in the library. The selection carries over, but `flyToNode` does nothing while the map is unmounted. The frame doesn't cover it, so it stays a follow-up.

### What v2 asked for that isn't built

- **Hover previews.** The handoff assumes an existing preview path; the player has none. The map & motion card keeps the hover setting that exists — focus on hover — under its real name, rather than a switch that does nothing.
- **Per-track play counts** in the details panel's tracks tab ("played 31 times"), and plays for a record or artist. The data is per recording and would take a request per track. Records and artists show their size instead.
- **A track name on a tag write.** `/tag-writes` returns a file id only, so the Tag writes worklist names each write by its id.
- **Skip on an enrichment candidate** isn't remembered; the server has no dismissal for it, and the item returns next time.

---

## The idea

A music library is a graph, and the graph is the application. Everything else floats above it.

There is no page, no sidebar, no header bar in the layout sense. There is a single full-bleed canvas of album covers, and three panes of frosted glass resting on top of it — collection on the left, now playing on the right, transport at the bottom. The graph runs continuously underneath all of them, visible through the blur. That is the whole concept, and every rule below exists to protect it.

Two consequences worth stating outright:

- **Panels never become opaque.** The blurred graph behind them is the design. A solid panel is a bug, not a fallback.
- **The graph is never a widget.** It does not live in a box with the rest of the UI arranged around it. It is the ground.

---

## Color

Legato is a two-theme app now (issue #136): ink, the dark theme, and paper, the light one. Ink is the original, unchanged intent — a canvas of album art needs a dark, neutral, non-competing ground — and is the default in every context that has no stored preference (issue #282). Paper is not a dimmed or inverted copy of it; it has its own rationale (below) and its own signed-off palette (issue #104's approval comment), not a formula derived from ink's values. A component never branches on which is active — both live as the same `--color-*` custom property names, ink in `tokens.css`'s `@theme` block, paper overriding them under `:root[data-theme="light"]`, and every component just reads `var(--color-*)` either way. The one structural exception is the sigma canvas, which renders to WebGL and never sees CSS at all — see "Following the theme" under "The graph" below for how it stays in sync instead.

Only the canvas and inset rows are current. The rest are v1's values, from before the v2 roles above; tokens.css has today's.

| Token | Ink value | Role |
|---|---|---|
| `--color-canvas` | `#0f1214` | The backdrop everything sits on |
| `--color-inset` | `rgb(0 0 0 / 0.28)` | Fill of inset controls. Since v2 it's an alias of `--color-sunken`, a dark wash over the surface, so it no longer equals the canvas as "Raised and inset" below asks |
| `--color-surface` | `rgb(30 36 38 / 0.8)` | Floating glass panels |
| `--color-surface-flat` | `#1C2124` | Opaque equivalent, for no-blur fallback |
| `--color-hairline` | `rgb(255 255 255 / 0.3)` | Panel and control edges |
| `--color-divider` | `rgb(100 100 100 / 0.35)` | Rules inside a panel |
| `--color-ink` | `#fefefe` | Values |
| `--color-signal` | `#D9D9D9` | Waveform bars, page dots |
| `--color-muted` | `#646464` | Labels, dividers, inactive states |
| `--color-control` | `#646464` *(v2)* | Switch/slider/checkbox/radio chrome, resting state |

### Paper (light mode, issue #136)

**Sheet music in colour and contrast.** Warm paper that is not yellow — a subtly tinted off-white, the colour of good engraving paper under daylight, not parchment. Ink is pen-ink black, a little softer than pure `#000`. Staff-line grays for dividers, edge colours darkened to clear WCAG 3:1 against the paper canvas (4.5:1 anywhere an edge colour also carries text), each hue kept recognizable next to its ink counterpart. Glass becomes frosted paper — surface at high opacity, with a softer, shorter, lower-alpha shadow than ink's punchier one; a paper shadow that read as heavy would fight the "resting on a lit desk" feeling the theme is going for.

Exact values live only in `tokens.css`'s `:root[data-theme="light"]` block, copied verbatim from issue #104's sign-off comment — this file doesn't duplicate a second token table that would just drift out of sync with it. A handful of values in that block are *not* from the approved table (the node-dot fallback colors, the edge/placeholder washes, the light-mode shadow) — each is called out inline there as a derived extension pending design review, not an approved value.

Preference is ink / paper / system, stored per device as `dark` / `light` / `system` (`localStorage`, not the server-backed settings store — a work laptop and a phone can genuinely differ) — see `src/hooks/useTheme.ts`. A first launch with nothing stored starts in ink; following the system is a choice, not the default. Follow-system tracks `prefers-color-scheme` live on the web and the Tauri window theme API's `onThemeChanged` event in the desktop shell. `index.html` carries a synchronous inline script that sets `data-theme` before the stylesheet or React ever run, so the first paint is already the right theme.

### v2: one muted tone, not two

The v2 mockup carried two near-identical greys forward from two different origins — a label color and a separate control-chrome color — that turned out to share the exact same hex, `#646464`. Collapsed to one on 2026-08-27: `--color-muted` is the app's only muted text tone now, and `--color-control` is a separate token at the same value for control chrome specifically (toggle tracks, slider tracks, radio dots, swatch borders), kept distinct for the same reason `--color-inset` stays its own token even while identical to `--color-canvas` — see below. `--color-ink` moved off pure white to `#fefefe` in the same pass; visually identical, keeps the app off a true-black-on-true-white pair that was never a deliberate choice. `--color-divider`'s base value tracks `--color-muted`'s shift (113 → 100 per channel), same derivation as before. `--color-muted-hi` (`#a0a0a0`, the hover step) is untouched — it wasn't part of this decision, and it still sits cleanly between the new muted and ink values.

### Raised and inset

The single most useful rule in the palette, and it is easy to miss: **the search field's fill is exactly the canvas color.**

A field is not a lighter surface stacked on the glass. It is a hole punched back down through the glass to the backdrop. Raised things are lighter than their parent; inset things return to `--color-canvas`. Keep `--color-inset` and `--color-canvas` identical — if a future control needs a different well color, that is a new token and a deliberate decision, not a tweak to these two.

The two are also distinguished by shadow, not just fill: raised surfaces carry `--shadow-surface`, inset ones carry none.

### Verification

*A v1 measurement, against v1's canvas:* `rgb(30 36 38 / 0.8)` over `#14181A` composites to `rgb(28, 33.6, 35.6)`. The render measures `#1C2124` = `rgb(28, 33, 36)`. The glass value is correct and `--color-surface-flat` is its honest opaque twin.

Against today's tokens, glass over bare canvas composites like this:

| Theme | `--color-surface` | over `--color-canvas` | composites to | `--color-solid` |
|---|---|---|---|---|
| ink | `rgb(22 26 29 / 0.74)` | `#0f1214` | `rgb(20.2, 23.9, 26.7)` | `#171b1e` |
| paper | `rgb(251 249 245 / 0.82)` | `#ebe6dc` | `rgb(248.1, 245.6, 240.5)` | `#fbf9f5` |

The render agrees. In headless Chrome on 2026-10-08, the rail over an empty map measured `rgb(20, 24, 26)` on ink and `rgb(249, 245, 240)` on paper, within a level per channel of the table; glass's `saturate(140%)` shifts the canvas under it slightly.

v2's opaque twin, `--color-solid` (which `--color-surface-flat` now aliases), isn't that composite. It's the glass colour at full opacity: exactly so on paper, one level lighter per channel on ink. So the no-blur fallback sits 3 to 4.5 levels per channel lighter than glass over bare canvas. `src/styles/canvasCopies.spec.ts` redoes this arithmetic from tokens.css, so the table can't drift from it.

---

## Glass

Every raised surface in the app is one recipe:

```css
background: var(--color-surface);
backdrop-filter: blur(var(--blur-glass));   /* 6.5px */
border: 1px solid var(--color-hairline);
border-radius: var(--radius-surface);        /* 25px */
box-shadow: var(--shadow-surface);           /* 0 4px 4px rgb(0 0 0 / 0.25) */
```

Surfaces differ only in which edges they keep:

| Surface | Deviation |
|---|---|
| Panels (left, right) | The full recipe |
| Toggle pill | The full recipe |
| Titlebar | Bottom border only, no radius — it spans the window |
| Transport dock | Top/left/right borders, top corners only — it is docked to the window's bottom edge |
| Search field | `--color-inset` fill, **no shadow** — inset, not raised |

### The hairline, and why it is not 0.25px

Figma specifies `0.25px solid white` on every surface. Do not implement that literally. A quarter of a pixel is not a width any display can commit to — depending on device pixel ratio it either disappears or snaps up to a full pixel, so the same build looks different on two machines.

Measured in the render, that 0.25px white line peaks at `rgb(90–101)` against the panel interior. `1px solid rgb(255 255 255 / 0.3)` composites to `rgb(96)`. Same appearance, stable at every scale factor. Dividers get the same treatment: the original mockup's 0.25px `#717171` measured `rgb(57, 61, 62)` against a `1px` line at 35% alpha computing to `rgb(58)`. v2's divider base shifted to `#646464` alongside the muted-tone collapse above — not yet re-verified against an exported render, since v2 doesn't have one yet, but it's the same 35%-alpha derivation that held for the original value.

**Rule: hairlines are always 1px with alpha doing the work. Never sub-pixel widths.**

### Blur is load-bearing and expensive

`backdrop-filter` over a live WebGL canvas is the highest-risk thing in this design, and it is applied to two 360 × 844 panels plus the titlebar and dock. On integrated graphics under Wayland this can collapse frame rate.

`--color-surface-flat` exists for that case. If blur has to be dropped, drop it to the flat fill — never to a different color, and never to full opacity, since the layering read depends on the panel being visibly lighter than the canvas rather than on seeing detail through it.

---

## Type

Two families, and the division of labor is strict. The wordmark itself isn't
type at all — it's a real vendored mark (`src/assets/brand/white-wordmark.svg`,
sized off `--text-wordmark`/`--text-wordmark-header` the same way the old
Luxurious Script rendering was), not a font-rendered string. This is the one
place a component genuinely has to know which theme is active rather than
just reading a token — an SVG source path isn't something a CSS custom
property can reach — so `LibrarySetup.tsx` and `LeftPanelHeader.tsx` each take
a `theme` prop and pick `white-wordmark.svg`/`white-logo.png` for ink,
`black-wordmark.svg`/`black-logo.png` for paper. Every other component still
must not branch on theme; this is a structural exception for swapping a whole
asset, not a precedent for styling logic.

| Token | Family | Use |
|---|---|---|
| `--font-ui` | Rubik Variable | Labels, section headers, controls, prose |
| `--font-mono` | Sometype Mono Variable | Values, data, anything the library supplied |

### The one rule (v2)

**Rubik is UI. Sometype Mono is metadata that came off a disk file.**

The split moved off label-vs-value (the original rule) onto provenance, decided 2026-08-27. In practice this changes less than it sounds: everything that used to read as mono data — track titles, artist names, durations, file paths, IDs, and read-only *stats about* the library (play counts, a computed "top album") — is still mono, because it's still data the app is showing you about your library, whether it came straight off a tag or got derived from one. What actually moves is the app's own interactive chrome: a slider's live readout (`1.00`), a toggle's state (`on`/`off`), anything that is UI state rather than a fact about a file, is Rubik now, in `--color-control`, not mono in ink. That's the one case the original rule got wrong — it made a slider value look like library data when it isn't one.

```
artists          5              ← Rubik #646464   |  Sometype Mono #fefefe   (library data)
collection size  7GB
top artist       The Beatles
size          [====○────] 1.00  ← Rubik #646464 label AND value              (control state)
```

A grey mono value or an ink-colored label still breaks the pattern and is a defect, same as before. Section headers (`collection`, `now playing`, `overview`, `metadata`, `maintenance`, `up next`, `nodes`, `links`, `forces`) are Rubik muted, same as always.

`--color-ink` is reserved for values and for genuinely active state (the current tab, the current filter) — never for hover. A hovered label steps to `--color-muted-hi` instead: distinct enough from `--color-muted` to read as a response, but not the color of a value, so hovering a label never makes it look like data.

### Size (v2)

Two sizes now, not one. `--text-base` (16px) is still every label and value in the panels — that part of the original rule holds. `--text-sm` (12px) is new, and scoped tightly: control chrome only — settings labels, sub-labels, and the live readouts next to a slider or toggle. The 40px wordmark is unchanged and remains its own case.

Don't reach for `--text-sm` outside control chrome. The hierarchy in every panel still comes from the family/color split and from spacing, not from size — 12px exists because the Music Map settings panel is a genuinely denser register than a data list, not because panels earned a type ramp.

Weight axis is available on both variable fonts and currently unused. Same principle: if hierarchy needs more than color and family provide, reach for weight before size.

---

## Geometry and rhythm

| Token | Value | Meaning |
|---|---|---|
| `--radius-surface` | `25px` | Every glass surface |
| `--radius-control` | `15px` *(v2)* | Bordered control wells — the search field, any future bordered input |
| `--spacing-panel` | `24px` | Panel side padding → 312px of content in a 360px panel |
| `--spacing-row` | `33px` | Vertical pitch of a label/value row |
| `--spacing-header-rule` | `31px` | Section header baseline to its divider |
| `--spacing-rule-body` | `16px` | Divider to the first row under it |

The 33px row pitch is consistent across both the overview list and the metadata list — it is a real rhythm, not a coincidence, and new lists should adopt it.

`--spacing-panel` is a reconciliation: the mockup drifts between 20px and 26px of side padding across panels. 24px is the value that makes 360 − 48 = 312 match the 314px dividers as drawn. Use 24 everywhere and treat the drift as mockup noise.

### Control density (v2)

A second, tighter scale for control chrome — the Music Map settings panel, and anything built to the same density — alongside the panel rhythm above, not replacing it:

| Token | Value |
|---|---|
| `--spacing-xs` | `5px` |
| `--spacing-sm` | `10px` |
| `--spacing-lg` | `20px` |

The pattern that shows up everywhere in the settings panel: a control's own dot or swatch, `--spacing-xs` below it, then its label — the same 5px gap under a toggle knob, a radio dot, and a color swatch alike. `--spacing-sm` is the pitch between one setting row and the next, and also between one settings group and the next.

One settings group (`nodes`, `links`, `forces`, and Legato Settings' own groups alike) is closed off by a `--color-divider` rule under its last row, `pb-[15px]` below that row — confirmed against the Music Map settings Figma frame (node 58:2), which draws every group this way, last one included, rather than leaving the boundary to the gap alone. `GroupHeader` plus this divider is `SettingsGroup` (`src/panels/SettingsPrimitives.tsx`).

Daniel's stated goal is tighter spacing across the app as a whole, not just in new control chrome — but retrofitting the panel rhythm above (33px rows, 24px padding) to run tighter is a separate, deliberate pass with a much wider blast radius, since every shipped panel depends on those exact numbers today. Not done here; this section is scoped to control-density UI only until that pass happens on purpose.

### Radius, and what does not get it

- **Glass surfaces:** 25px.
- **Album artwork: square.** Both the 75×75 thumbnails and the 255×255 now-playing cover have no radius in the file. Cover art is reproduced, not restyled.
- **Graph nodes: shaped by type.** Releases are square, everything else with art is circular — see "Nodes" below. Nothing on the canvas is rounded-cornered; a cover is either cut to a circle or left square.

Panels are the one place where *every* piece of artwork is square, whatever it depicts — a list item is a list item. On the canvas the shape is doing a different job: it says what kind of thing the node is.

### Measured layout

At the 1440 × 1024 reference size:

| Element | Position | Size |
|---|---|---|
| Titlebar | `0,0` | 1440 × 61 |
| Left panel | `51,120` | 360 × 844 |
| Right panel | `1029,120` | 360 × 844 |
| Toggle pill | `617,130` | 206 × 41 |
| Search field | centered in panel | 257 × 61 |
| Similarity thumbnails | 90px pitch | 75 × 75 |
| Now-playing cover | `1081,180` | 255 × 255 |
| Transport dock | `463,903` | 514 × 121 |
| Selected-node card | anchored to its node | 665 × 312, cover slot at `26,30` |
| Hover plate | centred under its node | width follows the title |

Panels are inset 51px from the window edge and 120px from the top — they float, and they do not reach the bottom of the window. That gap is where the graph shows through, so it is structural.

### Panel collapsed (v2)

A real global state, not a narrower version of the panels — collapsed removes the glass entirely rather than shrinking it. Confirmed against the v2 "Panel Collapse" frame:

- **Left side** shrinks to the 50px icon rail alone. No panel glass, no search field, no expanded content of any kind — just the six rail icons floating directly on the canvas. The rail's own glass (`Surface edges="right"`) is itself conditional on this, not a fixture: with the Inspector Panel open next to it, that border reads as the panel's left edge; with the panel closed, the rail drops its fill and border too and the six icons float bare, same as everything else in this collapsed state.
- **Right side** keeps a content column but drops its glass, its width (300px → 214px), and everything below the track header — no `track metadata`, `lyrics`, `connections`, or `notes`, collapsed or otherwise. What's left: cover art at 194 × 194 (down from 279.5) and the three-line track/album/artist block at a 24px line pitch (down from 29px).
- **Both sides show a dedicated expand icon once collapsed.** A later revision of the Figma file added this (nodes `66:85` on the left, `66:82` on the right — a different ID range than the rest of the frame, i.e. added after the original pass) to close a gap an earlier version of this doc flagged as unresolved. Same glyph as that side's collapse icon, rotated the opposite way. Layout isn't just a content swap in the same slot, though — each side arranges its two states differently:
  - **Left header:** expanded keeps the collapse icon docked to the panel's far (right) edge, inside the drag region — unchanged from before this revision. Collapsed packs the expand icon right next to the wordmark instead, `gap-[10px]`, matching the Figma frame's own flex row (node 55:204) rather than sitting off at the panel's far edge with nothing next to it.
  - **Right header:** expanded docks the collapse icon to the panel's far (left) edge, inside the drag region, well clear of the avatar — also unchanged. Collapsed groups the expand icon with the `DC` avatar at the far right instead, `gap-[10px]` between them, matching the Figma frame's "Frame 7" grouping (node 66:84) — there's no rail-icon equivalent on this side to dock the collapsed icon to, so it rides along with the one thing that's always there. The avatar itself now renders in both states rather than only while expanded.
  - The pre-existing implicit affordances — a rail icon click re-expands the left side (and picks what it shows), clicking the collapsed cover/track block re-expands the right — stay in place alongside the explicit buttons; nothing about adding a real button makes those wrong to keep.
- **The header bars lose their glass too, not just position parity.** Same position and size whether expanded or collapsed, but the fill and border go away once collapsed — a close crop of the "Panel Collapse" frame's header (node 55:203) shows the wordmark, both icons, and the avatar sitting directly on the canvas with no surface behind them, the same bare treatment the rail gets. The toggle pill and transport dock are unaffected by any of this — they don't participate in either side's collapse state at all.

This is a new interaction the current app doesn't have at all: today's side panels are always present. See "The shell (v2)" below for how this actually got built, including where it holds this state.

### The shell (v2)

The left rail (`src/shell/InspectorRail.tsx`), the Inspector Panel it opens (`src/shell/InspectorPanel.tsx`), and the two headers (`src/shell/LeftPanelHeader.tsx`, `src/shell/RightPanelHeader.tsx`) replace the app's one continuous titlebar (`src/shell/Titlebar.tsx`, now gone) — the whole point being that the canvas between the two side columns now runs edge to edge, with nothing reserved above it. `src/shell/rail.ts` names the six destinations. All six carry real content as of 2026-08-29: `search` (the existing collection panel, adapted in place — see below), `graph` (Music Map settings), `settings` (Legato Settings), and — the three newest, see "v2: panels without a frame" below — `database` (Database Inspector), `favourites` (Favourites), `tags` (Tag Manager).

Geometry, all in tokens.css: `--rail-width` (50px, fixed — an icon strip has no reason to scale), `--header-height` (50px, fixed, shared by both headers so their bottom edges line up — corrected from an inherited 52px on 2026-08-30; the "Header" frame's own dev-mode CSS is unambiguous on all three v2 frames: a 50px-tall parent, `h-full` content, `p-[10px]` each side), `--panel-width` (300px, scales with the window past 1440px the same way it always has, P-8), `--panel-width-collapsed` (the right panel's 214px, scaled the same way). Both side columns dock flush to their window edge now — v1's floating 51px inset is gone, along with the `--panel-inset` token that held it.

### v2: panels without a frame

Database Inspector, Favourites, and Tag Manager (`src/panels/DatabaseInspector.tsx`, `Favourites.tsx`, `TagManager.tsx`) shipped ahead of Figma: the rail carries a real icon for each — confirmed pixel-identical against the vendored SVGs, `database`/`heart`/`tag` for nodes `34:332`/`34:326`/`34:328` (Search frame; the same three icons repeat at `58:74`/`58:76`/`58:78` in Music Map and `55:220`/`55:222`/`55:224` in Panel Collapse) — but no frame anywhere in the file shows what selecting one looks like. The Inspector Panel content Figma actually draws only covers two of the six destinations: `search`'s own field-plus-results layout, and `graph`'s nodes/links/forces settings (`58:85`–`58:220`, folded into "The gpui-kit control set" below).

So there's nothing to check these three panels' layouts against pixel-for-pixel — only whether they reused the system correctly. They do: both Database Inspector (an operational/schema view) and Favourites (a recency-ordered list) are library data, not control chrome, so they correctly reach for `DataRow`/`SectionHeader` and the panel rhythm (33px rows, mono ink values) rather than the settings-primitives scale that would apply if they were settings. One inconsistency found in this pass and fixed: Tag Manager's row title rendered as the shared `Button`'s underlined `link` variant — the shape this file reserves for actions with real consequence — when every sibling "click a title to fly to this node" affordance elsewhere (Favourites' own row, the collection panel's maintenance preview and similarity thumbnails, search results) uses a plain hover-color-shift button with no underline. Brought in line with its siblings; the underline was the odd one out, not them.

### v2: the transport dock, not reconciled

"Panel collapsed (v2)" above says the toggle pill and transport dock are unaffected by either side's collapse state — true, and still true after this pass, but incomplete standing on its own: it reads as "the dock is the v1 dock," and that's no longer a safe assumption to leave in place. All three v2 frames (Search `37:653`, Music Map `58:8`, Panel Collapse `55:154`) draw the same replacement for the bottom control, consistently, not as a one-off sketch: 355 × 50, `--radius-control` (15px) rather than `--radius-surface`, holding a waveform, a divider, then plain pause/heart/volume glyphs — no numeric elapsed/duration readout, no volume slider. `TransportDock.tsx` still ships the v1 shape (514 × 121, full glass, both of those) and hasn't been touched by this pass.

The dock's shape is still not implemented. **Its volume mechanic was decided on 2026-09-29, with the gpui-kit port:** the volume glyph opens a Popover holding a vertical Slider, with the value as a percentage in the thumb's tooltip. The glyph swaps to `volume-mute` at zero, so the state reads without opening anything. That answers the question that was blocking the bare-glyph design, with no loss of a specific volume setting, and it's already in the v1 dock (`TransportDock.tsx`) in place of the 64px native range input. The rest of the redesign (355 × 50, no elapsed/duration readout) is still open.

The v2 player that replaced the dock narrows with the free space between the panels, and gives way part by part in a fixed order, down to previous, play/pause and next. "The player as it narrows", under Shell in Legato v2, records the order and the widths (#293).

The Search frame's Inspector Panel has one more unreconciled piece, smaller: its populated-query state draws a `top hits` header (node `58:295`) and a `suggested tracks` header (`58:344`) under the search field, in place of today's single inline results list (`CollectionPanel.tsx`'s `SearchField` — issue #83 moved this back from a floating popover it briefly was, since the popover read as its own mini modal over the Inspector Panel rather than content living in it). Neither header has any rows drawn under it in the mockup — label only, nothing to build against — so this is left as-is rather than guessing at a two-section split Figma hasn't actually specified content for.

A few things the brief flagged as open, resolved here:

- **Hairline color.** The raw Figma export draws the rail/header borders as 0.5px solid `--color-control` (grey), not the app's `--color-hairline` (white at 30% alpha) every other glass edge uses. Normalized to `--color-hairline`: v2 has no exported render to sample against yet for this specific value (same caveat this file already states for every v2 token), so there's no evidence the grey is deliberate rather than Figma's default stroke color on a frame nobody restyled — the same class of noise "why it is not 0.25px" already documents for the sub-pixel width. A second, solid-grey hairline language for one region of the app would fragment "hairlines are 1px with alpha" (Working rules #2) for a distinction with no stated reason.
- **Header wordmark size.** 32px, not the existing 40px `--text-wordmark`. Treated as real, not mockup noise: the new headers are built to a tight 10px padding, not the old titlebar's fixed 61px, and 32px is what that tighter frame is actually proportioned for. Kept as its own token, `--text-wordmark-header` — `--text-wordmark` stays 40px for LibrarySetup.tsx's splash screen, an unrelated context this decision doesn't touch.
- **Window controls — superseded.** The Figma mockup has no native window chrome to measure at all — it's a web design file. This originally meant keeping the frameless window and moving its custom minimize/maximize/close cluster into RightPanelHeader (`src/shell/WindowControls.tsx`, factored out of the old Titlebar). Reversed since: the window now runs with native OS decorations (`decorations: true`) instead, so RightPanelHeader owns only the collapse toggle and the avatar chip — see "Window controls" under Iconography.
- **One collapse state or two?** Two, independent: the rail's own selection (`RailDestination | null`) doubles as the left side's expand/collapse state, and the right panel has its own boolean. The Figma frames never show a mixed state, but they also describe genuinely separate triggers per side (a rail icon click for the left, each side's own header icon to collapse) — nothing suggested they were meant to move together, and forcing them into one shared flag would have made up a coupling the mockup never asked for.
- **The right panel's missing way back — resolved.** As originally specified, the right side's collapse had no expand affordance at all once collapsed, so this codebase shipped its own fix ahead of the mockup: clicking the collapsed content itself (the cover/track block) re-expands the panel. A later Figma revision added a real header icon for this on both sides (see "Panel collapsed (v2)" above), so the design and the implementation agree now — the click-to-expand-on-content behavior remains too, as a second way in rather than the only one.
- **Left expand button's destination.** The left header's new expand icon has no rail item of its own to open, unlike a click on one of the six rail icons. It reopens whichever destination was active immediately before the panel collapsed (`lastRailDestinationRef` in `MainApp`), falling back to `search` if the panel was never opened that session — not a Figma-specified behavior (the mockup can't show this), but the one consistent with how expand/restore works everywhere else in the app.
- **Persistence.** Component state (`MainApp` in `App.tsx`), not written to the settings store — resets to both-expanded on every relaunch. This is closer to "which tab is open" than a durable preference, and nothing in the brief asked for it to survive a restart; revisit if that turns out wrong.

Two structural notes for whoever picks up the pieces this pass deliberately left alone:

- **Canvas camera reservation is static, not collapse-aware.** `Canvas.tsx`'s `shellFreeArea` always reserves each side's *expanded* footprint, even while that side is actually collapsed — the same conservative direction G-8's original fix already argued for (a node ending up hidden under glass is the failure mode to avoid; a little unreachable canvas while collapsed is not). Tracking live collapse state to reclaim that space is a reasonable follow-up.
- **The two settings entry points are now one.** `src/panels/CollectionPanel.tsx`'s settings gear (top-right of the search content, opening the old `SettingsView` modal) and the rail's `sliders` "Legato Settings" destination used to duplicate each other, one real and one placeholder-only. Resolved by moving `SettingsView`'s content — library roots, enrichment, replaygain, audio device, hover-dim, reduced motion, shortcuts — into `src/panels/LegatoSettings.tsx`, restyled onto the Music Map settings panel's GroupHeader/SettingsRow geometry (now shared via `src/panels/SettingsPrimitives.tsx`) and mounted behind the rail destination. The gear button and `SettingsView.tsx` are gone. The `settings` gear glyph went with them and came back for the rail's Settings (#285), so Settings and the map toolbar's map options (`sliders`) no longer share an icon.

---

## The graph

### Nodes

- **44px** album cover or artist photo — the default. Every node that resolves to art shows that art, at every zoom level.
- **Shape carries the node's type.** A release is a **square** — an album cover is a square object, and in the albums graph the square *is* the release. Everything else that carries art is a **circle**: a track showing the cover of the album it belongs to, an artist showing a photograph of themselves. In the mixed tracks graph, where both appear at once, that is the difference between "this is the record" and "this is one track on it".
Selection and hover are surfaces of their own — see "In place on a node" below. Neither changes the node. Do not brighten, scale, or recolor a cover to indicate state; the artwork must stay readable as artwork, and anything a state needs to say gets said on glass next to it.

A 74px concentric ring used to mark the selected node, at `--color-node-ring` with 15px of clearance, following the node's own shape. The card replaced it: at every zoom the app can reach, the card's 255px cover sits over the node and swallows a ring around a 130px one, so the ring had become UI nothing could see. The token went with it.

A node with no art at all falls back to a filled circle in its type color, small enough that the artwork around it carries the eye. (Worth knowing: the solid red node in the mockup is not a fallback state, it is the actual cover of *Struggler* by Genesis Owusu.)

**Resolution.** Node art is a 256px texture for a 44px node, not because 44px needs it but because the graph zooms: a cover grows with the camera, and a HiDPI display already doubles it before that. 256 is what `server/src/cover/store.ts` derives and what the atlas cell in `Canvas.tsx` forces, deliberately the same number so a cover is resampled once rather than twice. Art reaches the canvas by content hash, never by node id — one texture per distinct cover, however many nodes display it, which is what makes covers on every track affordable at all.

### In place on a node

Both states appear at the node, on the canvas, rather than in a panel — Figma frames `31:247` (Hovered) and `31:246` (Selected). The right-hand panel used to become a node inspector the moment anything was selected, which meant looking at a record cost you sight of the one playing. It doesn't any more; it means now playing and nothing else.

**Hover — a plate.** A glass plate carrying the node's title and, below it, its artist. Centred on the node, its top edge tucked behind the node's bottom by 9% of the node's diameter (capped at 23px, the frame's figure against a 255px cover), text starting 15px below the node's edge. Width is whatever the title measures. Both lines are Sometype Mono in `--color-ink`: a title and an artist are both data, and there is no label here to be muted. An artist node has no second line — that is the whole state, not a missing value. It arrives on the same 90ms dwell as the hover dim, so one gesture produces one response.

**Selection — a card.** 665 × 312 of the standard glass, its 255px cover slot centred exactly on the node so the card reads as the node opening rather than as a panel arriving. Beside the cover, a 314px column on the panels' own rhythm — 31px header-to-rule, 16px rule-to-first-row, 33px row pitch, values at 57% — because it is the same rhythm, not a second layout language. `selected artist` / `selected release` / `selected track` in Rubik muted names what you picked; the title and artist under it are mono ink; then `metadata`, its rule, and three rows:

| Artist | Release | Track |
|---|---|---|
| releases | tracks | track no. |
| tracks | length | length |
| top album | release date | release date |

Three rows for every type, so the column never outgrows the cover that sets the card's height. `top album` is play-derived and reads as an em dash until there is play history — the app's one answer for "no value here", and the reason a muted-looking value is acceptable in a card that otherwise obeys the type rule.

The cover in the card is square whatever the node's own shape, following the panel rule rather than the canvas one: this is a glass surface, and every piece of artwork on glass is square. It is also deliberately about twice the size of the nodes around it. Making it match would mean flying the camera to ratio 0.03, where a selected node has no visible neighbourhood left.

**Selecting flies the camera.** Clicking a node zooms until nodes render `SELECT_NODE_PX` (130) across — stated as a size rather than a camera ratio, because the size is what the design cares about. Everything else that navigates to a node — search results, fact links, the hygiene worklist — lands at the same zoom, so arriving from the canvas and arriving from a search leave the graph in the same place. The camera aims the *card* at the middle of the canvas the panels leave free, not the node at the middle of the window: the card reaches ~511px to its node's right, and centring the node put that entire column under the right-hand panel every single time.

Because the working zoom is now much deeper than the 0.7 to 1 it used to be, the initial camera fit deliberately doesn't carry a ratio across from anywhere — carrying one dropped the camera onto 11% of a bbox it had never seen, which is empty canvas more often than not.

Three ways out of a selection, and none of them move the camera: click empty canvas, press Escape, or click the selected node again. The camera stays where it was asked to go.

### Edge palette

Edge color encodes **relationship type**.

Session 4 split the graph into three granularities (artists/albums/tracks), each its own view with its own edge types, none of which ever rendered together — the constraint the original three-color palette had to satisfy was only "mutually distinguishable within one graph." 2026-08-29 replaced those three tab-switched views with one combined graph, live-physics-laid-out, which is what the table below now describes: every one of these 7 types can render together, at once, and the ≥44° clearance they were already spaced at (below) is exactly what makes that safe.

**7 types, all mutually distinguishable, all in the one graph:**

| Token | Value | HSL | Relationship |
|---|---|---|---|
| `--color-edge-performed-by` | `#BF68EB` | 283° 76% 66% | Recording → artist |
| `--color-edge-appears-on` | `#68B6EB` | 203° 76% 66% | Recording → release |
| `--color-edge-released-in` | `#68EB79` | 115° 76% 66% | Recording → year |
| `--color-edge-featured-artist` | `#66EABC` | 159° 76% 66% | Recording → artist (featured) |
| `--color-edge-released-on` | `#EA66A6` | 331° 76% 66% | Recording → label |
| `--color-edge-produced-by` | `#EA9066` | 19° 76% 66% | Recording → credit (producer) |
| `--color-edge-engineered-by` | `#DBEA66` | 67° 76% 66% | Recording → credit (engineer) |

Two real edge types exist in the data but aren't in this palette yet — `performed_credit` and `mixed_by`, added after this table's last pass — and render at a flat fallback grey until a color pass adds them properly (nine hues won't fit the ≥44° clearance rule below without reworking the other seven's spacing too; a real design pass, not a drive-by addition).

`entities/collaboration.ts`'s three derived relations — `same_artist`, `same_label`, `collaborated_with` — are deliberately **not** drawn on the canvas at all any more, combined graph or not: they existed only to make the old albums/artists tab-views (which no longer exist) look connected, and an artist's whole catalogue pairwise-connected by `same_artist` was a dense, unreadable mesh even back when it had only the 2-type albums palette to contend with. The edges themselves still exist in the database — `similarity/similarity.ts`, `facts.ts`, and `articles/recompute.ts` all still depend on them — they just never reach `routes/nodes.ts`'s `/edges` response, so they were never a color-palette concern to begin with.

Edges are 1px (Figma: 0.5px — same sub-pixel reasoning as hairlines).

**One family, every hue.** Identical saturation and lightness (76%/66%) at every hue, no exceptions. The mockup drew its green at 50%/33%, which read as much heavier and darker than its two siblings rather than as a peer; it was normalized to 76%/66% to complete the original set (decided 2026-08-14). It does not get a fourth kind of color — no darker tone for "weaker", no grey for "structural" (the two undrawn-palette types above use grey as a plain fallback, not a deliberate fourth category — the moment they get real hues, that grey goes away). If edges ever need to express strength as well as type, that is opacity or width, not a second color dimension.

The original three types' hues were spaced ~80° apart (283°/203°/115°) — that spacing doesn't scale to ten types without either colliding or leaving no headroom for an eleventh. Session 4's seven new hues are chosen with ≥44° clearance from every *co-rendering* neighbor — spaced ~44-80° apart around the full circle, which is exactly what makes all 7 safe to render together in the combined graph. The original three anchors' exact hex values are untouched — they were measured against the Figma render and are correct; only the *methodology* for adding more is revised here, exactly as invited by this section's own note that the assignment was "provisional... revisit when edge types widen."

The type-to-color assignment is still provisional in the same sense the original three were — no meaningful-order convention (e.g., "hard metadata warmest, personal edges coolest") has been decided, just clearance-based spacing. Revisit if that becomes worth doing deliberately.

### v2: user-colorable types

Decided 2026-08-27: every hex in the table above becomes a **user-editable default**, not a fixed value. The taxonomy itself doesn't change — still nothing beyond hue distinguishes one type from another. What changes is that a user can override any type's hue for themselves, strongest reason being accessibility: the fixed palette optimizes hue-spacing for typical vision, and someone with a color vision deficiency has no way today to pick hues that actually work for them.

The v2 mockup's "links > colours" legend shows 4 swatches (collab/year/style/note) — those are placeholder labels from a WIP mockup, not the real list. The real picker shows all 7 curated types at once (see "Edge palette" above) — one combined graph since 2026-08-29, not a fixed 4 or a per-granularity subset.

**The picker must stay constrained, not a free color wheel.** An unconstrained picker lets a user pick near-identical hues for two types that then render indistinguishably in the same graph, which defeats the entire point of the spacing work above. Offer a curated set of pre-spaced hues at the same 76%/66% saturation/lightness the fixed palette already uses — real choice, including room to pick a CVD-safe subset, without the ability to break the distinguishability guarantee. Exact picker mechanics (how many hue options, whether the app warns on a too-close pick) are an implementation decision for whoever builds this, not fixed here.

Storage: a type → hex override map, most naturally in the existing `settings` key-value store (`server/src/routes/settings.ts` — already a generic string store, no new migration needed for this). Unset types fall back to the curated defaults above.

### Following the theme

The map can't take its colours from CSS. Sigma draws nodes and edges in WebGL, and labels and cluster glows go on 2D canvases, so none of them can use `var(--color-*)`. Only the ground is CSS: sigma's canvases are transparent, over the shell's `--color-canvas`. Everything drawn on top comes from the same tokens, copied into a palette in `src/canvas/Canvas.tsx`:

- **Read from the tokens.** `resolveThemeColors` reads the node fills (`--color-node-*`), the edge colours (`--color-edge`, `--color-edge-fallback` and one `--color-edge-*` per type), the canvas, the three inks, the halo and `--map-glow` through `getComputedStyle` on `<html>`. Each colour goes through `toSigmaColor`, because the translucent tokens come back in CSS4's space-separated `rgb(r g b / a)`, and sigma's colour parser only reads hex and comma `rgb()`/`rgba()`. A token that reads empty or won't parse falls back to `DEFAULT_THEME_COLORS`, which are ink's values.
- **Once per theme change, not per frame.** The palette is held in a ref. An effect keyed on Canvas's `theme` prop (App's `resolvedTheme`) resolves it again, repaints every node's base fill and refreshes sigma. The repaint is needed because a node's fill is baked into the graph when it syncs, so a new palette alone wouldn't reach it. Everything else reads the ref as it draws: the node reducer mixes unfocused nodes toward `canvas`, the edge reducer picks `edge` or a type colour (a user's override first), labels stroke `halo` and fill with `ink`, `ink-2` or `ink-3`, and glows take each artist's cover colour at `--map-glow`'s alpha. Nothing on the map reads the DOM per frame.
- **`data-theme` moves first.** The re-read is only right if `<html data-theme>` already names the new theme when the effect runs. React runs a child's effects before its parent's. While `useTheme` moved `data-theme` in an effect of its own, up in `MainApp`, Canvas read the old theme's tokens and the map stayed one theme behind (#282). `useTheme` now keeps the theme in one module-level store (`src/hooks/useTheme.ts`). Its `update()` moves `data-theme` and the theme-color meta first and only then notifies React, so any render, layout effect or effect that runs for the new theme already sees the new tokens. The test "moves data-theme before any effect below it re-reads the tokens" in `useTheme.spec.tsx` fails if that order is undone.

Two rules keep this working. A new colour on the map is a token, read in `resolveThemeColors`; it's never a hex in `Canvas.tsx`, and never a `getComputedStyle` call per frame. And only `useTheme.ts` moves `data-theme` once React is running (`index.html`'s boot script sets it before that); a component's own effect never does.

---

## Iconography

**proicons**, vendored as real SVG from Iconify into `src/assets/icons/` and rendered through `src/ui/Icon.tsx`.

Every glyph is 24 × 24, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps and joins. They inherit color and size from their container, so an icon in a muted label row is muted automatically.

Never hand-draw an icon or inline a `<path>`. If a needed glyph is missing, pull it from proicons; if proicons does not have it, that is a design decision, not an implementation one.

Icons in use: `search`, `cancel`, `chevron-down`, `pencil`, `info` (also the player's queue toggle), `pause`, `play`, `volume`, `map`, `database`, `heart`, `tag`, `sliders`, `panel-left-collapse` (the last five vendored for v2's rail and panel-collapse icon — see "The shell (v2)"), `settings` (proicons' gear, the rail's Settings; `sliders` is map options), `list` (proicons' "Bullet List": Collections and wherever a playlist shows), `library` (proicons' "Library": the map/library switch's library tab), `eye` (proicons' actual "Eye" glyph, vendored for the selected-node card's "open full details" button — see "Controls"), and `checkmark`, `subtract`, `spinner`, `volume-mute` for the gpui-kit controls (checkbox marks, Select's selected option, NumberInput's decrement, the Spinner's arc, the muted dock).

**On/off state has no filled-glyph convention to reach for.** proicons ships no filled or solid variant for any of its 544 icons, `heart` included — checked directly, not assumed. So the favourites heart's "on" state (`NodeTitleBlock.tsx`, `Favourites.tsx`'s row) isn't a second vendored glyph; `Icon.tsx`'s `filled` prop swaps the same path's `fill="none"` for `fill="currentColor"` at render time. This is the one exception to "every glyph is stroke-only" above, and it's a render-time transform of the existing vendored path, not a hand-drawn one — the thing this section actually rules out.

### Window controls

There are none of the app's own anymore. The window runs with native OS decorations (`tauri.conf.json`'s `decorations: true`) — minimize, maximize/restore, and close are whatever the host platform draws for any other window, in its own conventional position (right on Windows/Linux, left on macOS). This reverses an earlier v2 decision: a frameless window with a custom three-glyph cluster (`spacebar`/`arrow-minimize`/`cancel`) factored into `RightPanelHeader` as `WindowControls.tsx` — removed along with that file once the app went back to native chrome, since a custom cluster answering to nothing the Figma mockup specified was more surface than the plain OS default earned.

---

## Controls

Underline used to be the only button affordance in the app (C-3) — "retry", "rescan", "approve — write to file" and "cancel" all read as the same plain underlined text, so the one irreversible action in the product looked exactly like the one that isn't. Two shapes, `src/ui/Button.tsx`, split by consequence rather than prominence:

| Variant | Looks like | Use |
|---|---|---|
| `link` | Ink text, hover steps to `--color-muted-hi` — no underline | Anything reversible — navigation, retry, resubmit, undo itself. Most actions in the app genuinely are this. |
| `destructive` | A bordered pill: hairline border, rounded-full, padded | The rare action with no undo — currently only "approve — write to file" and its twin in the maintenance view. |

`destructive` is distinguished by shape, not color. The palette has no danger token, deliberately (`--color-*` in tokens.css is glass/ink/muted/edge-hue, full stop — inventing a red for one rare state would be the first exception), so weight carries what color can't: a bordered pill reads as a control to commit to, plain text reads as a link to follow.

**`link`'s underline was removed app-wide 2026-09-02 (issue #30)** — it read badly wherever it appeared, and it was never load-bearing: the hover color-shift to `--color-muted-hi` was already the affordance doing the real work, the underline just rode along. Every "click a title to fly to this node" spot outside the shared component (Favourites' row, the collection panel's maintenance preview and similarity thumbnails, search results) had already converged on plain-text-plus-color-shift with no underline — TagManager's row title was brought in line with that convention first (see "v2: panels without a frame" above); `Button.tsx`'s `link` variant, `ArticleBody.tsx`'s inline article links, and `ConnectionsContent.tsx`'s recordings/personal-edges rows were the three remaining holdouts, fixed in the same pass. `destructive` is untouched — it was never underlined, and its bordered-pill shape is the whole point of that variant.

Both variants share the toggle pill's rounding language (`rounded-full`, no new radius token) and MO-1's motion tokens (`--motion-fast`, `--ease-out`) rather than a literal duration.

### The gpui-kit control set (2026-09-29)

Every interactive primitive in `src/ui/` is now a hand port of [gpui-kit](https://github.com/longbridge/gpui-kit) (Longbridge's GPUI component library, Apache-2.0), drawn in Legato's palette and type. gpui-kit is Rust on GPUI and can't run inside this React webview, so nothing is imported: each component was rebuilt from gpui-kit's source, keeping its geometry, states, motion and keyboard behaviour. Each file's header comment cites the gpui-kit file it came from.

**The rule for conflicts: gpui-kit wins on how a control behaves and is shaped, and Legato keeps its fonts and colours.** Where gpui-kit reaches for its own theme tokens, the mapping is fixed:

| gpui-kit token | Legato token | Note |
|---|---|---|
| `primary` (checked/on/filled) | `--color-ink` | Legato has no accent colour, on purpose. Ink is already "genuinely active state" (see "The one rule") |
| `primary_foreground` (a mark on a filled control) | `--color-canvas` | A switch thumb and a checkmark are cut out of the fill |
| `switch` / `input` (resting control) | `--color-control` | |
| `ring` (focus) | `--color-ring` → `--color-muted-hi` | An alias, not a new hex, so the paper theme follows automatically |
| `popover` surface | The glass recipe | Every popup (tooltip, popover, listbox, dialog, toast) is glass |
| `muted` fill / hover | `--color-hover-wash` | |

The **focus ring** is gpui-kit's everywhere: 3px of `--color-ring` at 50%, hugging the control's own corners. It replaces MO-2's 1px hairline outline, and it's still in `index.css`'s single unlayered rule. A control whose ring belongs on one part of it sets `data-focus-ring="part"` and marks that part with `.focus-ring-part`: the switch's track (not track and label together), the slider's thumb, the checkbox's box. Text fields put it on their well with `.focus-ring-well`.

| Control | File | Geometry and behaviour |
|---|---|---|
| **Switch** | `Switch.tsx` | Replaces v2's 20 × 10 Toggle. 28×16 / **36×20** / 44×24 tracks, 12/16/20 thumbs, 2px inset (1px transparent border + 1px padding, so the focus tint has a line to colour). Off is a `--color-control` track, on is `--color-ink`, and the thumb is `--color-canvas` either way. The thumb travels on `--ease-spring`. Disabled fades only the track, to 50%. Optional clickable label on either side |
| **Slider** | `Slider.tsx`, `sliderMath.ts` | 6px track of ink at 20% (40% while pressed), selected span in full ink. 16px thumb: a 1px ink-50% rim around a canvas core, with a 3px ring growing out on hover, drag and keyboard focus. The value shows in a **tooltip on the thumb** while it's hovered, dragged or focused, replacing v2's always-on readout. Range (two thumbs that never cross), vertical, logarithmic scale, `reverse` fill. Keys: arrows one step, Page Up/Down ten, Home/End the ends. Pointer is captured for drags. `onCommit` fires on release |
| **Checkbox** | `Checkbox.tsx` | 14 / **16** / 20px box, `--radius-small` (gpui-kit's 4px cap, so a checked box never reads as a radio). Checked and indeterminate fill with ink and cut the mark (`checkmark` / `subtract`) out in canvas. The mark fades on `--ease-spring-control` |
| **RadioGroup** | `Radio.tsx` | 16px ring, 8px ink dot scaling in. The group is one tab stop and arrow keys move the selection itself, wrapping and skipping disabled options |
| **Select** | `Select.tsx`, `Listbox.tsx` | Replaces the native `<select>`, whose popup was OS chrome. Inset well (`--color-inset`, hairline, `--radius-control`, no shadow), 32px tall. Glass listbox at least as wide as the trigger, selected option in ink with a checkmark. Keys: WAI-ARIA select-only combobox, including type-ahead |
| **Combobox** | `Combobox.tsx` | A Select you type into to filter (case-insensitive substring). Same well and listbox. Focus stays in the input via `aria-activedescendant` |
| **NumberInput** | `NumberInput.tsx` | Replaces `<input type="number">`. Minus/plus buttons around a text field that parses on Enter or blur, clamps, snaps to step, and reverts non-numbers rather than erasing them. Up/Down step (Shift for ten). `well` or `bare` appearance; `bare` is MetadataFields' inline bpm edit |
| **Tabs** | `Tabs.tsx` | `segmented`: an inset well with a raised `--color-surface-flat` thumb sliding to the active option (the theme and replaygain choices, and the map/library switch as `bare` inside its own glass pill). `underline`: a 2px ink rule sliding under the active label (library albums/tracks). The indicator slides on `--ease-spring`. Active label is ink. Keys: automatic activation, arrows wrap, Home/End |
| **ToggleGroup** | `ToggleGroup.tsx` | Hairline pills, `aria-pressed`, single or multiple. Pressed = hover wash + ink text, which replaces the ColorSwatch ring the Music Map preset pills used to borrow. A single group can have nothing pressed ("custom") |
| **Tooltip** | `Tooltip.tsx`, `floating.ts` | Now at control-chrome scale: `--text-sm`, 8/2px padding. Optional shortcut in a muted Kbd. Slides `--distance-short` out of its trigger as it fades, on `--ease-enter`. **Flips** to the opposite side when its preferred side has no room. Keeps the 400ms dwell, TooltipGroup's hot skip, and C-82's dismiss-on-pointerdown. Keyboard focus shows it; a click's own focus doesn't. `TooltipBubble` is the floating half alone, which the slider uses |
| **Popover** | `Popover.tsx` | Now generic: any trigger, any content. Portaled and positioned by `floating.ts` (so no panel's `overflow-x-hidden` can crop it, which retires #86's width cap), focus moves in on open and back on close, Escape or an outside press closes it. `InfoPopover` is C-1's original (i) shape |
| **Dialog / AlertDialog** | `Dialog.tsx` | Glass surface over a `--color-canvas` 60% wash (never black; the graph stays visible). Focus trap, focus restore, Escape closes. The overlay closes a Dialog but never an AlertDialog. Enters rising `--distance-medium` over `--motion-base`. AlertDialog's initial focus is **cancel**, and a no-undo confirm uses Button's `destructive` pill. Removing a library folder and rebuilding the map now confirm in one, where they used to swap a sentence into the row |
| **Toast** | `Toast.tsx`, `toastContext.ts` | `useToast().show({ title, description?, action?, duration? })`. Glass, `--radius-control`, stacked top right under the header, newest on top. Five seconds by default, paused while the pointer is over the stack. No per-kind colours, because the palette has no semantic hues. `role="status"`. First use: the map rebuild's outcome |
| **Kbd** | `Kbd.tsx` | Keycap: hairline, `--radius-small`, 20px minimum width, Rubik `--text-sm` ink. `muted` is the borderless form used inside a tooltip. The shortcuts list uses it |
| **Progress / ProgressCircle** | `Progress.tsx` | Ink-20% track with ink fill, 4/6/**8**/10px. Indeterminate sweeps a 40% segment. See Motion's progress exception for when each applies. The scan row's stage bar is the `xs` form, and it sweeps when its stage has no total yet instead of sitting at a fake 0% |
| **Skeleton / Shimmer / Spinner** | `Skeleton.tsx`, `Spinner.tsx` | See Motion, "Loops, since the gpui-kit port" |
| **ScrollArea** | `ScrollArea.tsx` | Overlay scrollbar on both side panels. 6px thumb (8px under the pointer or while dragged), inset 4px, at least 48px long, square-ended, `--color-control` stepping to `--color-muted-hi`. Appears on scroll and fades two seconds after the last activity. Vertical only, since every panel pins x closed (#86) |

`Button` (link / destructive) and `ColorSwatch` are unchanged. gpui-kit's button variants were not adopted: the consequence-based split above is a Legato decision that gpui-kit's primary/secondary/ghost set doesn't map onto.

**What this overrode in v2's settings primitives**, for the record:
- The Toggle's rule that state reads from knob position alone, with one resting colour. The track colour changes now. At a glance across a settings panel, the old toggle made every setting look off.
- The Toggle's and Slider's 10px chrome (knob, thumb, 3px track). gpui-kit's sizes are roughly double. The settings rows still sit on the `--spacing-sm` pitch.
- The slider's always-visible Rubik readout. It's the thumb's tooltip now, still Rubik, still a control value rather than library data.
- "None of these have a defined hover/active/focus treatment yet." Every control has gpui-kit's now.

The radio-dot primitive retired on 2026-08-29 has a successor in `Radio.tsx`, though nothing uses a radio group yet.

---

## Motion

The mockup is static, so this is a stated position rather than a measurement, and it follows Daniel's documented rule for his own work: *the UI is the straightest, cleanest thing on the screen — the content is what is flashy.*

- No page transitions, no loading screens, no scroll-triggered reveals, no parallax.
- State changes that need to feel physical — panel pagination, up-next expanding, camera moves to a searched node — get a short ease, 120–200ms.
- The graph's own motion (pan, zoom, drag) is direct manipulation and must never be animated or eased. It tracks the input exactly.
- Nothing animates on a loop *as decoration*. The loops that exist are each a bounded exception below, and each stands for something actually happening.

### Tokens

Every transition in the app draws from this table, in `src/styles/tokens.css`. Since the gpui-kit port (2026-09-29), the durations and curves are gpui-kit's `MotionTokens` defaults. Legato's earlier 90ms instant and 140ms fast were replaced, and `--ease-out` was already gpui-kit's `easing_move` to the digit.

| Token | Value | Use |
|---|---|---|
| `--motion-instant` | 0ms | Press receipt. gpui-kit's `duration_instant`: an acknowledgement that has to be immediate shouldn't wait on a transition at all. |
| `--motion-fast` | 120ms | Hover, colour, small state change, a popup's enter. |
| `--motion-base` | 180ms | Pagination, disclosure, modal entry. |
| `--motion-slow` | 280ms | Larger surfaces arriving (a toast). |
| `--motion-exit` | 120ms | Leaving. Faster than arriving — on the way out the user has already decided; a slow exit is just waiting. |
| `--motion-spring` / `--ease-spring` | 280ms / `linear(…)` | gpui-kit's `spring_move` (280ms period, damping 0.85), sampled into a CSS `linear()` curve, its ~0.6% overshoot included. Control geometry: a switch thumb's travel, a tab indicator's slide. A CSS transition retargets from the live value, so a second toggle mid-travel reverses from where the thumb is, as a real spring does. |
| `--motion-spring-control` / `--ease-spring-control` | 210ms / `linear(…)` | gpui-kit's `spring_control` (180ms period, critically damped). Small reveals: a checkmark fading in, a radio dot scaling up. |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | The default. Starts at full speed and decelerates into place — a response to input, not an approach to it. Tailwind's built-in `ease-out` is close but not this; this token is the one to reach for. |
| `--ease-inout` | `cubic-bezier(0.4, 0, 0.2, 1)` | Reserved for things genuinely reversible mid-flight, like a disclosure toggled twice quickly. |
| `--ease-enter` / `--ease-exit` | `(0.16, 1, 0.3, 1)` / `(0.4, 0, 1, 1)` | gpui-kit's popup curves. A tooltip, popover, listbox, dialog or toast arrives on a steep deceleration and leaves on an acceleration. |
| `--distance-short` / `--distance-medium` | 4px / 8px | How far a popup travels as it fades in. A tooltip or popover slides the short distance out of its trigger; a dialog rises the medium one. A transform, so reduced motion drops it and keeps the fade. |

The spring durations are the settle times at gpui-kit's own tolerances, which is why they aren't round. An engine without `linear()` falls back to `--ease-out` via an `@supports` block rather than losing the transition.

**Acknowledge under 100ms, finish under 400ms.** Below roughly 100ms a response reads as instantaneous; past about 400ms attention starts to leave the task. Every control acknowledges the press immediately, even when the real work behind it hasn't returned yet.

**Animate to preserve identity, never to decorate.** Motion earns its place where something moves or changes identity and the user would otherwise have to re-find it — paging the inspector, a ring attaching to a node, a modal arriving over the canvas. It does not earn its place because content simply appeared.

**Never animate live data.** Playback position, elapsed time, waveform progress, volume. A transition here makes the display lag the truth, and a readout that disagrees with the audio is worse than one that steps. Step, do not ease.

**Motion is pre-attentive, so spend it once per interaction.** Movement is the strongest attention-grabbing channel available; two moving things compete and neither is read. One element moves per interaction — the one carrying the meaning.

### Reduced motion means less movement, not less feedback

A blanket `*{transition:none}` reset is the wrong reflex — it strips the feedback that tells someone their click registered. Under `prefers-reduced-motion: reduce`, transforms, translations and scale — the things that move through space and carry vestibular risk — drop to zero duration. Opacity and colour crossfades keep theirs: they carry the same state information without the risk. The base layer implementing this lives in `src/index.css`, deliberately outside any `@layer` block so it outranks Tailwind's utility layer without reaching for `!important`.

### A bounded exception: progress

"Nothing animates on a loop" holds for decoration. It does not hold for progress, which is data about work actually happening, not a mood. Three cases:

- **Determinate progress is data, not decoration.** A scan knows its file count; the enrichment queue knows its remaining jobs. Render the real value — a count, a bar that fills to a number — never a loop standing in for one.
- **Indeterminate and short shows nothing.** Under roughly 400ms, a spinner shown just to prove the wait happened costs more attention than the wait itself. Say nothing and let the result land.
- **Indeterminate and long gets a signal that work is happening.** Past roughly 800ms, silence starts to read as broken. This used to mean one state change and no loop; since the gpui-kit port, a Shimmer on the label, a Spinner beside the control, or an indeterminate Progress sweep are all allowed (see "Loops, since the gpui-kit port" below). Use one, next to whatever started the work, never several.

This is the same attention curve as "Acknowledge under 100ms, finish under 400ms" above, applied to work whose true length isn't known in advance.

### A second bounded exception: revealing overflow

Same principle, a different kind of "not decoration." A marquee that scrolls a truncated title through on hover (`src/ui/ScrollingText.tsx`) is the only way the rest of a cut-off track/album/artist name is ever seen — it isn't a mood, it's the content. It stays bounded the same three ways "Nothing animates on a loop" exists to guard against in the first place:

- **Static until proven otherwise.** Content that fits its container — or that hasn't been hovered yet — renders exactly like `truncate` always has: no measurement artifact, no tell that a marquee mechanism even exists underneath. Motion only appears where there is something a static ellipsis is actually hiding, and even then only in response to a pointer (or keyboard focus) actually landing on that field; it holds still for a beat before it starts, so a glance still reads as static first.
- **Hover-gated, not a wall of them.** Originally reserved for a single prominent field (the currently selected or playing node's title/album/artist) specifically to avoid every row in a list marqueeing at once on a shared timer — "Motion is pre-attentive, so spend it once per interaction" above is exactly that concern. Session issue #31 revised this: the cycle now only runs while the pointer or focus is actually on that one field (`ScrollingText`'s own `hovered` state), snapping back to the start the instant it leaves. That makes the original wall-of-motion failure structurally impossible — at most one field can be hovered at a time — so it's now wired into list rows too: `DataRow`'s value column, and the primary title in Favourites, Playlists, the inline search results list, up-next queue rows, Tag Manager rows, and the connections/facts lists. Still never more than the one row a pointer is actually on.
- **Reduced motion means the exception doesn't apply.** `usePrefersReducedMotion()` (`src/ui/usePrefersReducedMotion.ts` — the same hook `Disclosure.tsx` already uses) forces the plain static ellipsis, same as every other truncated field in the app.

**Nothing is truncated without a static way to read it (issue #86).** The marquee is one reveal, not the only one. It is off under reduced motion and never starts without a pointer. So every truncated field also carries a native `title` with its full text. `ScrollingText` sets it only while the text measurably overflows (`src/ui/overflow.ts`), so a value that fits never gets a tooltip that just repeats it. The few bare `truncate` spans left in the panels set it directly. Prose — a reason, a sentence, a description — wraps rather than truncates. Panel scrollers pin `overflow-x-hidden` as a backstop against a horizontal scrollbar, but that is not how content fits. Anything with an intrinsic width inside a flex row (a range input, a long unbroken word) still has to be allowed to shrink (`min-w-0`) or break (`wrap-anywhere`). Otherwise the backstop quietly crops it.

### Loops, since the gpui-kit port

Relaxed on 2026-09-29 at Daniel's direction, so that gpui-kit's loading primitives could come in with the rest. The same bounds as the other exceptions apply: each loop stands for something the user is waiting on, and each freezes on a readable frame under reduced motion (index.css's global rule zeroes animation duration), never disappearing.

- **Skeleton** (`--motion-skeleton`, 2s): a `--color-placeholder` block the shape of what's loading, breathing between full and half opacity. Opacity only, never a travelling gradient, so a grid of them doesn't read as motion sweeping the page. It's what the library view's unloaded covers and rows, and Legato Settings' loading states, show now.
- **Shimmer** (same period): an ink band travelling through a label that says work is under way ("rebuilding…"). For the label, never a value. Its rest frame is the plain text in its own colour.
- **Spinner** (`--motion-spinner`, 800ms): proicons' own spinner arc, rotating. The progress rules below still decide when one belongs: never for a wait under ~400ms, never where a real count exists.
- **Indeterminate Progress** (`--motion-progress`, 1s): gpui-kit's sweep, for work with a real bar slot but no known total yet.

What's still out: loops as mood. Nothing pulses to draw the eye, and nothing breathes when idle.

### A third bounded exception: the currently-playing halo

Issue #85: the currently playing track gets a soft, pulsing glow on the canvas — `src/canvas/NodePlayingHalo.tsx` — anchored to its node the same way the hover plate and selection card are (`useNodeAnchor`), independent of both: a track can keep playing while the user selects or hovers something else entirely, and nothing on the canvas said so before this. Same "an addition, not a substitution" rule as selection and hover — the node's own rendering never changes, this is a surface next to it.

The pulse itself is the one genuine loop in the app, and it earns the exception "nothing animates on a loop" exists to guard against for the same reason progress does: it isn't decoration, it's a true ongoing state. A static highlight on this node would read as "selected", not "playing" — the two already have their own, different visual language (a card vs. nothing), and playback needed one of its own that says *ongoing* rather than *chosen*. Bounded the same way as the other two exceptions here:

- **Opacity only.** The halo's box-shadow (spread and blur, both fixed) never changes; only the element's opacity breathes between 0.4 and 1, over `--motion-pulse` (1800ms) and `--ease-inout`. Transform/scale carry vestibular risk and are the property reduced motion exists to stop; opacity crossfades don't, and this is built as exactly that, done in a loop.
- **Reduced motion freezes it, doesn't hide it.** A real CSS `@keyframes` animation (`tokens.css`'s `node-halo-pulse`), not one of `Canvas.tsx`'s own rAF loops — so it falls straight under `index.css`'s existing global rule (`animation-duration`/`animation-iteration-count` zeroed under `prefers-reduced-motion` or the settings override) with no bespoke branch. The frame it freezes on is the loop's resting 40% opacity, a plain static halo rather than losing the cue outright.
- **Color, not a new one.** `--color-signal` — already the waveform's and the now-playing page dots' color — rather than inventing a hue for a third "this is playing" surface.
- **Swallowed by the card when the two coincide, on purpose.** If the playing node is also the selected one, `NodeCard`'s 255px cover (drawn after the halo in `Canvas.tsx`'s overlay stack) can fully cover a halo this size — the exact fate DESIGN.md's "Nodes" section already describes for the old selection ring, and for the same reason: the card already shows everything about that node, so a halo underneath has nothing left to add.

---

## Empty and error states

Every panel needs its blank case designed rather than discovered. The pattern: Rubik muted, centered in the panel's content column, one sentence that says what is true and what to do, no illustration.

The catalogue to build against:

| State | Where |
|---|---|
| Library has no roots yet | First run — takes over the whole window |
| Scan running, no nodes yet | Canvas |
| Search matched nothing | Collection panel |
| Node has no cover art | Graph node, similarity thumbnails, now-playing cover |
| Nothing playing | Now-playing panel and transport |
| Queue is empty | Up next |
| No maintenance items | Collection panel — this one is a *success* state and should read as calm, not empty |
| Server not reachable | Whole window |
| Scan failed | Canvas, with the error and a retry |

Issues #50/#57 revised "Nothing playing" specifically: the row above described a static message left sitting in an otherwise-normal panel and transport, and in practice that read as broken chrome rather than a designed empty state. Both surfaces now remove themselves instead of narrating their own emptiness — `TransportDock.tsx` unmounts outright rather than showing every control disabled, and the now-playing panel auto-collapses to `NowPlayingCollapsed`'s narrow column (same collapsed treatment "Panel collapsed (v2)" above already uses for a manual collapse) instead of rendering the old "nothing playing" paragraph.

Issue #87 revised this once more: that collapsed idle column had grown its own quick-play button (queues a random recording from the library) as the one way back in, since the panel could no longer be expanded into at all while idle — but that put a floating suggestion over the bare canvas any time playback was idle, whether or not the user had ever looked at the panel. The collapsed idle column is now genuinely empty, matching the rest of this row's "remove itself" pattern with no addition. The quick-play button moved to `NowPlayingPanel`'s own idle state instead — the "nothing playing" paragraph this section originally described, still muted and centered, now paired with the quick-play affordance — reachable only by the user explicitly expanding the panel (the right header's expand control is no longer forced inert while idle), matching the general rule that this panel's expanded/collapsed state is the user's own toggle, not something playback state overrides.

---

## Working rules

1. **Tokens, not values.** No hex, no px radius, no blur value inline in a component. If something needs a value that is not a token, add the token.
2. **Hairlines are 1px with alpha.** Never sub-pixel.
3. **Rubik is UI, Mono is metadata from a disk file.** *(v2)* Library data — raw tag or derived stat — is mono ink; the app's own interactive state (a slider readout, a toggle's on/off) is Rubik control-color. No exceptions.
4. **Artwork is reproduced, not styled.** Square in panels, circular in the graph, never tinted or filtered.
5. **Panels stay translucent.** Blur may degrade to `--color-surface-flat`; opacity may not go to 1.
6. **Two sizes, not a ramp.** *(v2)* 16px for every panel label and value; 12px only for control chrome (settings labels, slider/toggle readouts, tooltips). Reach for weight before inventing a third size.
7. **Controls come from `src/ui/`, and they're gpui-kit's.** *(2026-09-29)* A new interactive control is a port of the matching gpui-kit component in Legato's tokens, never a native form control (`<select>`, `<input type="range">`, `<input type="number">`) and never a one-off. See "The gpui-kit control set".

---

## Related

| File | What it owns |
|---|---|
| [AGENTS.md](AGENTS.md) | How to work in this repo |
| `src/styles/tokens.css` | The values, machine-readable |
| `src/ui/Icon.tsx` | The icon set |
