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

`--color-ink` is reserved for values and for genuinely active state (the current tab, the current filter) — never for hover. A hovered label steps to `--color-muted-hi` instead: distinct enough from `--color-muted` to read as a response, but not the color of a value, so hovering a label never makes it look like data.

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

Because the working zoom is now much deeper than the 0.7 to 1 it used to be, switching granularity frames the new graph rather than carrying the ratio across. Carrying it dropped the camera onto 11% of a bbox it had never seen, which is empty canvas more often than not.

Three ways out of a selection, and none of them move the camera: click empty canvas, press Escape, or click the selected node again. The camera stays where it was asked to go.

### Edge palette

Edge color encodes **relationship type**.

Session 4 split the graph into three granularities (artists/albums/tracks), each its own view with its own edge types — and none of those three views ever render together. That relaxes the constraint the original three-color palette had to satisfy: colors only need to be mutually distinguishable *within one graph*, not across all ten types at once. So the table below is grouped by which graph a type actually appears in, not listed as one flat wheel.

**Tracks graph — 7 types, all mutually distinguishable:**

| Token | Value | HSL | Relationship |
|---|---|---|---|
| `--color-edge-performed-by` | `#BF68EB` | 283° 76% 66% | Recording → artist |
| `--color-edge-appears-on` | `#68B6EB` | 203° 76% 66% | Recording → release |
| `--color-edge-released-in` | `#68EB79` | 115° 76% 66% | Recording → year |
| `--color-edge-featured-artist` | `#66EABC` | 159° 76% 66% | Recording → artist (featured) |
| `--color-edge-released-on` | `#EA66A6` | 331° 76% 66% | Recording → label |
| `--color-edge-produced-by` | `#EA9066` | 19° 76% 66% | Recording → credit (producer) |
| `--color-edge-engineered-by` | `#DBEA66` | 67° 76% 66% | Recording → credit (engineer) |

**Albums graph — 2 types** (`entities/collaboration.ts`'s derived relations, never rendered alongside the tracks graph's palette above):

| Token | Value | HSL | Relationship |
|---|---|---|---|
| `--color-edge-same-artist` | `#7166EA` | 245° 76% 66% | Release ↔ release, shared primary artist |
| `--color-edge-same-label` | `#EA667C` | 350° 76% 66% | Release ↔ release, shared dominant label |

**Artists graph — 1 type:**

| Token | Value | HSL | Relationship |
|---|---|---|---|
| `--color-edge-collaborated-with` | `#EA8766` | 15° 76% 66% | Artist ↔ artist, shared a recording |

Edges are 1px (Figma: 0.5px — same sub-pixel reasoning as hairlines).

**One family, every hue.** Identical saturation and lightness (76%/66%) at every hue, no exceptions. The mockup drew its green at 50%/33%, which read as much heavier and darker than its two siblings rather than as a peer; it was normalized to 76%/66% to complete the original set (decided 2026-08-14). It does not get a fourth kind of color — no darker tone for "weaker", no grey for "structural". If edges ever need to express strength as well as type, that is opacity or width, not a second color dimension.

The original three types' hues were spaced ~80° apart (283°/203°/115°) — that spacing doesn't scale to ten types without either colliding or leaving no headroom for an eleventh. Session 4's seven new hues are chosen with ≥44° clearance from every *co-rendering* neighbor (the tracks graph's 7 types, spaced ~44-80° apart around the full circle) — colors that never appear in the same view (a tracks-graph hue and an albums-graph hue, say) aren't spaced against each other at all, since there's nothing to confuse them with. The original three anchors' exact hex values are untouched — they were measured against the Figma render and are correct; only the *methodology* for adding more is revised here, exactly as invited by this section's own note that the assignment was "provisional... revisit when edge types widen."

The type-to-color assignment within the tracks graph is still provisional in the same sense the original three were — no meaningful-order convention (e.g., "hard metadata warmest, personal edges coolest") has been decided, just clearance-based spacing. Revisit if that becomes worth doing deliberately.

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

## Controls

Underline was the only button affordance in the app (C-3) — "retry", "rescan", "approve — write to file" and "cancel" all read as the same plain underlined text, so the one irreversible action in the product looked exactly like the one that isn't. Two shapes, `src/ui/Button.tsx`, split by consequence rather than prominence:

| Variant | Looks like | Use |
|---|---|---|
| `link` | Ink text, underlined, hairline decoration | Anything reversible — navigation, retry, resubmit, undo itself. Most actions in the app genuinely are this, and it's the shape the app already had. |
| `destructive` | A bordered pill: hairline border, rounded-full, padded | The rare action with no undo — currently only "approve — write to file" and its twin in the maintenance view. |

`destructive` is distinguished by shape, not color. The palette has no danger token, deliberately (`--color-*` in tokens.css is glass/ink/muted/edge-hue, full stop — inventing a red for one rare state would be the first exception), so weight carries what color can't: a bordered pill reads as a control to commit to, a plain underline reads as a link to follow.

Both variants share the toggle pill's rounding language (`rounded-full`, no new radius token) and MO-1's motion tokens (`--motion-fast`, `--ease-out`) rather than a literal duration.

---

## Motion

The mockup is static, so this is a stated position rather than a measurement, and it follows Daniel's documented rule for his own work: *the UI is the straightest, cleanest thing on the screen — the content is what is flashy.*

- No page transitions, no loading screens, no scroll-triggered reveals, no parallax.
- State changes that need to feel physical — panel pagination, up-next expanding, camera moves to a searched node — get a short ease, 120–200ms.
- The graph's own motion (pan, zoom, drag) is direct manipulation and must never be animated or eased. It tracks the input exactly.
- Nothing animates on a loop. No pulsing, no shimmer, no breathing.

### Tokens

Four durations and two curves; every transition in the app draws from this table, in `src/styles/tokens.css`'s `@theme` block.

| Token | Value | Use |
|---|---|---|
| `--motion-instant` | 90ms | Press receipt. Below this, a response reads as instantaneous — reserved for acknowledging a click before the real work (often a Rust IPC round trip) has finished. |
| `--motion-fast` | 140ms | Hover, colour, small state change. |
| `--motion-base` | 180ms | Pagination, disclosure, modal entry. |
| `--motion-exit` | 120ms | Leaving. Faster than arriving — on the way out the user has already decided; a slow exit is just waiting. |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | The default. Starts at full speed and decelerates into place — a response to input, not an approach to it. Tailwind's built-in `ease-out` is close but not this; this token is the one to reach for. |
| `--ease-inout` | `cubic-bezier(0.4, 0, 0.2, 1)` | Reserved for things genuinely reversible mid-flight, like a disclosure toggled twice quickly. |

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
- **Indeterminate and long gets one state change, not a loop.** Past roughly 800ms, silence starts to read as broken. Change something once — a label from muted to ink, a single sweep that completes and stops — and hold it there. The change earns its place by telling the user work is happening; it does not need to keep telling them.

This is the same attention curve as "Acknowledge under 100ms, finish under 400ms" above, applied to work whose true length isn't known in advance.

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
