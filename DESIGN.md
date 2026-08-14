# Legato — Design System

**This file is ground truth for how Legato looks and why.** [CLAUDE.md](CLAUDE.md) owns how to work in this repo; [Legato.md](~/Documents/Fifth%20Brain/projects/Legato.md) owns what the product is and why. This file owns the visual language, and `src/styles/tokens.css` is its machine-readable half — when the two disagree, this file explains the intent and the token file wins on values.

Source of truth for the design itself: Figma file `NSaK1N64NwcKzlKpqaYs49`, frame **Desktop - 1**, 1440 × 1024.

Every value below was measured from that frame and then cross-checked against the exported render by sampling pixels. Where the two disagreed, the note says so.

---

## The idea

A music library is a graph, and the graph is the application. Everything else floats above it.

There is no page, no sidebar, no header bar in the layout sense. There is a single full-bleed canvas of album covers, and three panes of frosted glass resting on top of it — collection on the left, now playing on the right, transport at the bottom. The graph runs continuously underneath all of them, visible through the blur. That is the whole concept, and every rule below exists to protect it.

Two consequences worth stating outright:

- **Panels never become opaque.** The blurred graph behind them is the design. A solid panel is a bug, not a fallback.
- **The graph is never a widget.** It does not live in a box with the rest of the UI arranged around it. It is the ground.

---

## Color

Legato is one dark theme. There is no light mode and no theme switcher; the app is a canvas of album art, and album art needs a dark, neutral, non-competing ground.

| Token | Value | Role |
|---|---|---|
| `--color-canvas` | `#14181A` | The backdrop everything sits on |
| `--color-inset` | `#14181A` | Fill of inset controls — *identical to canvas, by design* |
| `--color-surface` | `rgb(30 36 38 / 0.8)` | Floating glass panels |
| `--color-surface-flat` | `#1C2124` | Opaque equivalent, for no-blur fallback |
| `--color-hairline` | `rgb(255 255 255 / 0.3)` | Panel and control edges |
| `--color-divider` | `rgb(113 113 113 / 0.35)` | Rules inside a panel |
| `--color-ink` | `#FFFFFF` | Values |
| `--color-signal` | `#D9D9D9` | Waveform bars, page dots |
| `--color-muted` | `#717171` | Labels, dividers, inactive states |

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

Measured in the render, that 0.25px white line peaks at `rgb(90–101)` against the panel interior. `1px solid rgb(255 255 255 / 0.3)` composites to `rgb(96)`. Same appearance, stable at every scale factor. Dividers get the same treatment: Figma's 0.25px `#717171` measures `rgb(57, 61, 62)`, and `1px` at 35% alpha computes to `rgb(58)`.

**Rule: hairlines are always 1px with alpha doing the work. Never sub-pixel widths.**

### Blur is load-bearing and expensive

`backdrop-filter` over a live WebGL canvas is the highest-risk thing in this design, and it is applied to two 360 × 844 panels plus the titlebar and dock. On integrated graphics under Wayland this can collapse frame rate.

`--color-surface-flat` exists for that case. If blur has to be dropped, drop it to the flat fill — never to a different color, and never to full opacity, since the layering read depends on the panel being visibly lighter than the canvas rather than on seeing detail through it.

---

## Type

Three families, and the division of labor is strict.

| Token | Family | Use |
|---|---|---|
| `--font-display` | Luxurious Script 400 | The wordmark. Nothing else, ever. |
| `--font-ui` | Rubik Variable | Labels, section headers, controls, prose |
| `--font-mono` | Sometype Mono Variable | Values, data, anything the library supplied |

### The one rule

**Rubik in `--color-muted` names a thing. Sometype Mono in `--color-ink` is the thing.**

```
artists          5              ← Rubik #717171   |  Sometype Mono #FFFFFF
collection size  7GB
top artist       The Beatles
release date     2022-08-05
```

This is what makes the panels legible at a glance without any boxes, alignment aids, or weight changes. A grey value or a mono label breaks the pattern and should be treated as a defect. Track titles, artist names, durations, file paths, IDs — all data, all mono, all white. Section headers (`collection`, `now playing`, `overview`, `metadata`, `maintenance`, `up next`) are Rubik muted.

### Size

The mockup is single-size: **every label and every value is 16px.** The only other size in the file is the 40px wordmark.

That is unusual and it is worth keeping. There is no type ramp here yet and none should be invented speculatively — the hierarchy comes from the family/color split and from spacing, not from size. Add a size only when a real screen needs one, and add it to the tokens when you do.

Weight axis is available on both variable fonts and currently unused. Same principle: if hierarchy needs more than color and family provide, reach for weight before size.

---

## Geometry and rhythm

| Token | Value | Meaning |
|---|---|---|
| `--radius-surface` | `25px` | Every glass surface |
| `--spacing-panel` | `24px` | Panel side padding → 312px of content in a 360px panel |
| `--spacing-row` | `33px` | Vertical pitch of a label/value row |
| `--spacing-header-rule` | `31px` | Section header baseline to its divider |
| `--spacing-rule-body` | `16px` | Divider to the first row under it |

The 33px row pitch is consistent across both the overview list and the metadata list — it is a real rhythm, not a coincidence, and new lists should adopt it.

`--spacing-panel` is a reconciliation: the mockup drifts between 20px and 26px of side padding across panels. 24px is the value that makes 360 − 48 = 312 match the 314px dividers as drawn. Use 24 everywhere and treat the drift as mockup noise.

### Radius, and what does not get it

- **Glass surfaces:** 25px.
- **Album artwork: square.** Both the 75×75 thumbnails and the 255×255 now-playing cover have no radius in the file. Cover art is reproduced, not restyled.
- **Graph nodes: circular.** Covers are clipped to circles on the canvas and only there.

Artwork being square in panels and circular in the graph is the deliberate signal for "this is a list item" versus "this is a node."

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

Panels are inset 51px from the window edge and 120px from the top — they float, and they do not reach the bottom of the window. That gap is where the graph shows through, so it is structural.

---

## The graph

### Nodes

- **44px** circular album cover — the default.
- **74px** concentric ring, `--color-node-ring` at 1px, for the selected node. The node itself does not change size or color; the ring is drawn around it with 15px of clearance.

Selection is an addition, never a substitution. Do not brighten, scale, or recolor a cover to indicate state — the artwork must stay readable as artwork.

A node with no cover art falls back to a filled circle in `--color-muted`. (Worth knowing: the solid red node in the mockup is not a fallback state, it is the actual cover of *Struggler* by Genesis Owusu.)

### Edge palette

Edge color encodes **relationship type**.

| Token | Value | HSL | Relationship |
|---|---|---|---|
| `--color-edge-performed-by` | `#BF68EB` | 283° 76% 66% | Recording → artist |
| `--color-edge-appears-on` | `#68B6EB` | 203° 76% 66% | Recording → release |
| `--color-edge-released-in` | `#68EB79` | 115° 76% 66% | Recording → year |

Edges are 1px (Figma: 0.5px — same sub-pixel reasoning as hairlines).

**One family, three hues.** Identical saturation and lightness, rotated roughly 80° per step. The mockup drew the green at 50%/33%, which read as much heavier and darker than its two siblings rather than as a peer; it was normalized to 76%/66% to complete the set (decided 2026-08-14).

This is the rule that makes the palette extensible: **a new relationship type continues around the wheel at 76% saturation and 66% lightness.** It does not get a fourth kind of color — no darker tone for "weaker", no grey for "structural". If edges ever need to express strength as well as type, that is opacity or width, not a second color dimension.

The type-to-color assignment is provisional — the mockup shows three colors but does not label them, so they are assigned here by visual frequency (purple densest in clusters, blue spanning long distances, green sparse). Revisit when edge types widen beyond the current three.

---

## Iconography

**proicons**, vendored as real SVG from Iconify into `src/assets/icons/` and rendered through `src/ui/Icon.tsx`.

Every glyph is 24 × 24, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps and joins. They inherit color and size from their container, so an icon in a muted label row is muted automatically.

Never hand-draw an icon or inline a `<path>`. If a needed glyph is missing, pull it from proicons; if proicons does not have it, that is a design decision, not an implementation one.

Icons in use: `search`, `cancel`, `arrow-minimize`, `spacebar`, `chevron-down`, `pencil`, `info`, `pause`, `play`, `volume`.

### Window controls

The frameless titlebar's three controls, left to right:

| Glyph | Action |
|---|---|
| `spacebar` | Minimize |
| `arrow-minimize` | Maximize / restore toggle |
| `cancel` | Close |

The wordmark is centered in the titlebar and the whole bar outside the controls is the drag region.

---

## Motion

The mockup is static, so this is a stated position rather than a measurement, and it follows Daniel's documented rule for his own work: *the UI is the straightest, cleanest thing on the screen — the content is what is flashy.*

- No page transitions, no loading screens, no scroll-triggered reveals, no parallax.
- State changes that need to feel physical — panel pagination, up-next expanding, camera moves to a searched node — get a short ease, 120–200ms.
- The graph's own motion (pan, zoom, drag) is direct manipulation and must never be animated or eased. It tracks the input exactly.
- Nothing animates on a loop. No pulsing, no shimmer, no breathing.

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

---

## Working rules

1. **Tokens, not values.** No hex, no px radius, no blur value inline in a component. If something needs a value that is not a token, add the token.
2. **Hairlines are 1px with alpha.** Never sub-pixel.
3. **Rubik/muted labels, Mono/ink values.** No exceptions.
4. **Artwork is reproduced, not styled.** Square in panels, circular in the graph, never tinted or filtered.
5. **Panels stay translucent.** Blur may degrade to `--color-surface-flat`; opacity may not go to 1.
6. **One size until a screen earns another.** 16px everywhere; reach for weight before size.

---

## Related

| File | What it owns |
|---|---|
| [CLAUDE.md](CLAUDE.md) | How to work in this repo |
| [Legato.md](~/Documents/Fifth%20Brain/projects/Legato.md) | Product status, architecture, decisions |
| `src/styles/tokens.css` | The values, machine-readable |
| `src/ui/Icon.tsx` | The icon set |
