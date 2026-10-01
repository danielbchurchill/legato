# Legato — Design System

**This file is ground truth for how Legato looks and why.** [AGENTS.md](AGENTS.md) owns how to work in this repo. This file owns the visual language, and `src/styles/tokens.css` is its machine-readable half — when the two disagree, this file explains the intent and the token file wins on values.

Source of truth for the design itself: Figma file `NSaK1N64NwcKzlKpqaYs49`. The original **Desktop - 1** frame (1440 × 1024) is still ground truth for anything not called out below. **Design v2** (canvas "version 2", frames **Search**, **Music Map**, **Panel Collapse**) is a new direction, still WIP as of 2026-08-27 — sections below marked *v2* reflect decisions confirmed against it so far. A full survey of the "version 2" canvas on 2026-08-30 confirmed those three frames are the entirety of it — there is no fourth v2 frame waiting to be found, and every rail icon and shell measurement in it has now been checked. What's still open: the transport dock's v2 redesign, and the Search panel's populated-query state — both flagged where they're discussed below, not resolved.

Every value below was measured from the relevant frame and then cross-checked against the exported render by sampling pixels, where a render exists to sample. v2 values are measured from Figma's own dev-mode output instead — no exported render to verify against yet, so treat those as provisional until one exists. Where a value disagreed with its render, the note says so.

---

## The idea

A music library is a graph, and the graph is the application. Everything else floats above it.

There is no page, no sidebar, no header bar in the layout sense. There is a single full-bleed canvas of album covers, and three panes of frosted glass resting on top of it — collection on the left, now playing on the right, transport at the bottom. The graph runs continuously underneath all of them, visible through the blur. That is the whole concept, and every rule below exists to protect it.

Two consequences worth stating outright:

- **Panels never become opaque.** The blurred graph behind them is the design. A solid panel is a bug, not a fallback.
- **The graph is never a widget.** It does not live in a box with the rest of the UI arranged around it. It is the ground.

---

## Color

Legato is a two-theme app now (issue #136): dark, and a paper light mode. Dark is the original, unchanged intent — a canvas of album art needs a dark, neutral, non-competing ground — and stays the default in every context that has no stored preference. Light is not a dimmed or inverted copy of it; it has its own rationale (below) and its own signed-off palette (issue #104's approval comment), not a formula derived from the dark values. A component never branches on which is active — both live as the same `--color-*` custom property names, dark in `tokens.css`'s `@theme` block, light overriding them under `:root[data-theme="light"]`, and every component just reads `var(--color-*)` either way. The one structural exception is the sigma canvas, which renders to WebGL and never sees CSS at all — see "The graph" below for how it stays in sync instead.

| Token | Dark value | Role |
|---|---|---|
| `--color-canvas` | `#14181A` | The backdrop everything sits on |
| `--color-inset` | `#14181A` | Fill of inset controls — *identical to canvas, by design* |
| `--color-surface` | `rgb(30 36 38 / 0.8)` | Floating glass panels |
| `--color-surface-flat` | `#1C2124` | Opaque equivalent, for no-blur fallback |
| `--color-hairline` | `rgb(255 255 255 / 0.3)` | Panel and control edges |
| `--color-divider` | `rgb(100 100 100 / 0.35)` | Rules inside a panel |
| `--color-ink` | `#fefefe` | Values |
| `--color-signal` | `#D9D9D9` | Waveform bars, page dots |
| `--color-muted` | `#646464` | Labels, dividers, inactive states |
| `--color-control` | `#646464` *(v2)* | Switch/slider/checkbox/radio chrome, resting state |

### Paper (light mode, issue #136)

**Sheet music in colour and contrast.** Warm paper that is not yellow — a subtly tinted off-white, the colour of good engraving paper under daylight, not parchment. Ink is pen-ink black, a little softer than pure `#000`. Staff-line grays for dividers, edge colours darkened to clear WCAG 3:1 against the paper canvas (4.5:1 anywhere an edge colour also carries text), each hue kept recognizable next to its dark-mode counterpart. Glass becomes frosted paper — surface at high opacity, with a softer, shorter, lower-alpha shadow than dark mode's punchier one; a paper shadow that read as heavy would fight the "resting on a lit desk" feeling the theme is going for.

Exact values live only in `tokens.css`'s `:root[data-theme="light"]` block, copied verbatim from issue #104's sign-off comment — this file doesn't duplicate a second token table that would just drift out of sync with it. A handful of values in that block are *not* from the approved table (the node-dot fallback colors, the edge/placeholder washes, the light-mode shadow) — each is called out inline there as a derived extension pending design review, not an approved value.

Preference is dark / light / follow-system, stored per device (`localStorage`, not the server-backed settings store — a work laptop and a phone can genuinely differ) — see `src/hooks/useTheme.ts`. Follow-system tracks `prefers-color-scheme` live on the web and the Tauri window theme API's `onThemeChanged` event in the desktop shell. `index.html` carries a synchronous inline script that sets `data-theme` before the stylesheet or React ever run, so a light-mode user never sees a dark first paint.

### v2: one muted tone, not two

The v2 mockup carried two near-identical greys forward from two different origins — a label color and a separate control-chrome color — that turned out to share the exact same hex, `#646464`. Collapsed to one on 2026-08-27: `--color-muted` is the app's only muted text tone now, and `--color-control` is a separate token at the same value for control chrome specifically (toggle tracks, slider tracks, radio dots, swatch borders), kept distinct for the same reason `--color-inset` stays its own token even while identical to `--color-canvas` — see below. `--color-ink` moved off pure white to `#fefefe` in the same pass; visually identical, keeps the app off a true-black-on-true-white pair that was never a deliberate choice. `--color-divider`'s base value tracks `--color-muted`'s shift (113 → 100 per channel), same derivation as before. `--color-muted-hi` (`#a0a0a0`, the hover step) is untouched — it wasn't part of this decision, and it still sits cleanly between the new muted and ink values.

### Raised and inset

The single most useful rule in the palette, and it is easy to miss: **the search field's fill is exactly the canvas color.**

A field is not a lighter surface stacked on the glass. It is a hole punched back down through the glass to the backdrop. Raised things are lighter than their parent; inset things return to `--color-canvas`. Keep `--color-inset` and `--color-canvas` identical — if a future control needs a different well color, that is a new token and a deliberate decision, not a tweak to these two.

The two are also distinguished by shadow, not just fill: raised surfaces carry `--shadow-surface`, inset ones carry none.

### Verification

`rgb(30 36 38 / 0.8)` over `#14181A` composites to `rgb(28, 33.6, 35.6)`. The render measures `#1C2124` = `rgb(28, 33, 36)`. The glass value is correct and `--color-surface-flat` is its honest opaque twin.

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
a `theme` prop and pick `white-wordmark.svg`/`white-logo.png` for dark,
`black-wordmark.svg`/`black-logo.png` for light. Every other component still
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
- **The two settings entry points are now one.** `src/panels/CollectionPanel.tsx`'s settings gear (top-right of the search content, opening the old `SettingsView` modal) and the rail's `sliders` "Legato Settings" destination used to duplicate each other, one real and one placeholder-only. Resolved by moving `SettingsView`'s content — library roots, enrichment, replaygain, audio device, hover-dim, reduced motion, shortcuts — into `src/panels/LegatoSettings.tsx`, restyled onto the Music Map settings panel's GroupHeader/SettingsRow geometry (now shared via `src/panels/SettingsPrimitives.tsx`) and mounted behind the rail destination. The gear button, `SettingsView.tsx`, and the unused `settings` gear glyph are gone.

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

---

## Library view

**Issue #126**: a map/library switch in the shell, persisted like every other settings-backed toggle (`ViewSwitch.tsx`, `settings.viewMode`, `'map' | 'library'`, default `'map'`). Library has two layouts — an albums cover grid (`src/library/AlbumsGrid.tsx`) and a virtualized track table (`src/library/TracksTable.tsx`) — behind one container, `src/library/LibraryView.tsx`, with its own albums/tracks sub-toggle.

No Figma frame exists for any of this yet — same footing as "v2: panels without a frame" above (Database Inspector, Favourites, Tag Manager): the system gets reused correctly rather than matched pixel-for-pixel against a mockup that doesn't exist. Concretely, that means:

- **The map/library pill reuses the retired `GraphToggle.tsx`'s `Surface` pill**, holding Tabs' segmented variant (`bare`) since the gpui-kit port: a raised thumb slides to the active view, whose label is ink, and the other steps from control to `--color-muted-hi` on hover. Rubik at `--text-base`. Repositioned from that component's old fixed `top-[69px]` (measured for the single titlebar v1 had) to `top-[calc(var(--header-height)+var(--spacing-lg))]`, so it clears both v2 headers regardless of window width instead of assuming a specific one's height.
- **Title and artist, wherever the library view shows both, are both Sometype Mono `--color-ink` — no muted label.** This is `NodeHoverPlate.tsx`'s existing precedent (its own comment: "a title and an artist are both data. There is no label here to be muted."), not a new call: a grep for any existing muted-colored mono line in the codebase before writing `AlbumsGrid.tsx` turned up nothing, so there was no competing convention to reconcile against. Position (title first, artist under it) carries the meaning DataRow's label column would otherwise carry.
- **`TracksTable.tsx`'s column headers are Rubik, muted → ink for the active sort column** (the one Rubik-labels/mono-values split DataRow already formalizes, just laid out as a table header row instead of a label/value grid) — with a `chevron-up`/`chevron-down` marking direction, clicking the active column again flips it. `AlbumsGrid.tsx` has no column headers to click (a grid of cells, not a table), so it gets an equivalent row of sort options above the grid instead, same active/muted/chevron language.
- **Row height and geometry are reasoned from existing tokens, not measured from a frame.** `TracksTable.tsx` reuses `--spacing-row` (33px) directly — it's already defined as "the vertical pitch of a label/value row," and a table row is exactly that. `AlbumsGrid.tsx`'s cell width (160px) and the `leading-[24px]` its two text lines use have no token to reuse (there's no existing "library grid cell" anywhere else in the app), so they're named constants in the component itself, commented with which existing rhythm they mirror, rather than new entries in `tokens.css` — that file's own header states every value there is "measured from the Figma mockup," which none of this is.
- **Full-bleed, same as the canvas it replaces.** `LibraryView.tsx` takes over the exact stage `Canvas` occupies in `AppShell` (`App.tsx` renders one or the other, never both) and inherits the same relationship with the rail/panels: a row can scroll in and out from behind the Inspector Panel's glass exactly the way a graph node already can. Only `--rail-width` is reserved as real padding, since the rail (unlike the panel it opens) has no glass background and is always present — content starting underneath it would be genuinely hidden, not just visually layered.

**Sort options.** Albums: artist, title, year, date added, recently played (the last derived server-side from `plays` via the album's own recordings — there's no direct album↔plays edge in the schema). Tracks: title, artist, album, duration, format, date added. Both default ascending on `title`/`artist` respectively; nulls (no year, never played) always sort last regardless of direction, `server/src/routes/library.ts`'s `orderClause` convention.

**Smooth at 30k albums, two mechanisms, not one.** DOM virtualization (`@tanstack/react-virtual`, chosen for being small — it only adds itself plus `@tanstack/virtual-core` — and the de facto standard for this in React) keeps the node count down regardless of scroll position, but a single `GET /library/albums` for the whole table would still ship and JSON-parse 30k rows before the first frame. `src/library/useLibraryPage.ts` is the other half: it sizes the scrollable area from `total` (known after the very first page) and fills a sparse array only as the virtualizer's visible range asks for it, 150 rows at a time. Covers load through the existing `GET /nodes/:id/cover?size=thumb` (256px) endpoint, resolved server-side per row (`resolveCoverForNode`, same per-page-only cost `GET /nodes` already accepts for its own cover resolution) — never for more than one page at a time.

**What "shared search/filters" means here, concretely.** Search: `CollectionPanel.tsx`'s `SearchField` no longer owns its query as local state — it's lifted to `MainApp` (`libraryQuery`) and passed down as a controlled prop to both `SearchField` and `LibraryView`, so the same text filters the global search dropdown and the library list at once, and survives switching views. Filters: there is no filter concept on the map today beyond that search box, so none was invented for the library view either — "shared filters" is satisfied by there being exactly one filter (the search query) to share, not by a second, independent mechanism. Selection: reuses `selectedNodeId`/`selectAndFly` unchanged — a library row calls the exact function a canvas node click already does.

**Documented scope boundary: switching back to the map does not re-fly the camera to whatever was last selected in the library.** `selectAndFly` calls `canvasRef.current?.flyToNode(id)`, which is a no-op while `Canvas` is unmounted (library active) since the ref is null — so the selection itself carries over (the node card shows correctly once back on the map, if still selected) but the fly-to-it camera move does not replay retroactively. Fixing this means touching `Canvas.tsx`'s 1500-line, carefully-commented effect stack for a polish item outside issue #126's "Done when" list — left as a follow-up rather than done speculatively.

**Also deliberately not built:** a per-row/per-cell play button. Selecting a row or cover selects+flies only; playing something found this way means switching to the map first, where the now-selected node's own card already has one. Issue #126's "Done when" list doesn't mention a transport affordance here, so — same reasoning as the camera fly-to above — it's flagged as a follow-up rather than added on spec.

---

## Iconography

**proicons**, vendored as real SVG from Iconify into `src/assets/icons/` and rendered through `src/ui/Icon.tsx`.

Every glyph is 24 × 24, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps and joins. They inherit color and size from their container, so an icon in a muted label row is muted automatically.

Never hand-draw an icon or inline a `<path>`. If a needed glyph is missing, pull it from proicons; if proicons does not have it, that is a design decision, not an implementation one.

Icons in use: `search`, `cancel`, `chevron-down`, `pencil`, `info`, `pause`, `play`, `volume`, `map`, `database`, `heart`, `tag`, `sliders`, `panel-left-collapse` (the last five vendored for v2's rail and panel-collapse icon — see "The shell (v2)"), `eye` (proicons' actual "Eye" glyph, vendored for the selected-node card's "open full details" button — see "Controls"), and `checkmark`, `subtract`, `spinner`, `volume-mute` for the gpui-kit controls (checkbox marks, Select's selected option, NumberInput's decrement, the Spinner's arc, the muted dock).

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

**`link`'s underline was removed app-wide 2026-09-02 (issue #30)** — it read badly wherever it appeared, and it was never load-bearing: the hover color-shift to `--color-muted-hi` was already the affordance doing the real work, the underline just rode along. Every "click a title to fly to this node" spot outside the shared component (Favourites' row, the collection panel's maintenance preview and similarity thumbnails, search results) had already converged on plain-text-plus-color-shift with no underline — TagManager's row title was brought in line with that convention first (see "v2: panels without a frame" below); `Button.tsx`'s `link` variant, `ArticleBody.tsx`'s inline article links, and `ConnectionsContent.tsx`'s recordings/personal-edges rows were the three remaining holdouts, fixed in the same pass. `destructive` is untouched — it was never underlined, and its bordered-pill shape is the whole point of that variant.

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
