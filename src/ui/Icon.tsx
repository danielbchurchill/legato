import add from '../assets/icons/add.svg?raw'
import arrowSwap from '../assets/icons/arrow-swap.svg?raw'
import cancel from '../assets/icons/cancel.svg?raw'
import checkmark from '../assets/icons/checkmark.svg?raw'
import chevronDown from '../assets/icons/chevron-down.svg?raw'
import chevronUp from '../assets/icons/chevron-up.svg?raw'
import database from '../assets/icons/database.svg?raw'
import eye from '../assets/icons/eye.svg?raw'
import fastForward from '../assets/icons/fast-forward.svg?raw'
import heart from '../assets/icons/heart.svg?raw'
import info from '../assets/icons/info.svg?raw'
import list from '../assets/icons/list.svg?raw'
import map from '../assets/icons/map.svg?raw'
import panelLeftCollapse from '../assets/icons/panel-left-collapse.svg?raw'
import pause from '../assets/icons/pause.svg?raw'
import pencil from '../assets/icons/pencil.svg?raw'
import play from '../assets/icons/play.svg?raw'
import repeat from '../assets/icons/repeat.svg?raw'
import reverse from '../assets/icons/reverse.svg?raw'
import search from '../assets/icons/search.svg?raw'
import settings from '../assets/icons/settings.svg?raw'
import sliders from '../assets/icons/sliders.svg?raw'
import spinner from '../assets/icons/spinner.svg?raw'
import subtract from '../assets/icons/subtract.svg?raw'
import tag from '../assets/icons/tag.svg?raw'
import volume from '../assets/icons/volume.svg?raw'
import volumeMute from '../assets/icons/volume-mute.svg?raw'

/* Icons are proicons (github.com/ProCode-Software/proicons), vendored as real
 * SVG rather than redrawn. Every glyph is a 24x24 currentColor stroke at 1.5
 * with round caps, so they inherit text color and size from their box.
 *
 * `settings` is proicons' gear, the rail's Settings. `sliders` is the map
 * toolbar's map options. Both used `sliders` until #285, so two different
 * destinations looked like one. The gear was vendored once before, for
 * CollectionPanel's old settings button (the SettingsView modal), and went
 * with that button.
 *
 * `arrow-minimize` and `spacebar` (the minimize/maximize glyphs) went the
 * same way once the window went back to native OS decorations
 * (tauri.conf.json's `decorations: true`) and WindowControls.tsx, their one
 * caller, was removed.
 *
 * `list` is the playlists rail destination's glyph (proicons "Bullet List").
 * `chevron-up` pairs with the existing `chevron-down` for the up-next/
 * playlist-track reorder buttons — real vendored SVGs rather than one glyph
 * CSS-rotated, matching how every other pair here (play/pause) gets its own
 * file. `add` (a plain plus) is the "add to playlist" affordance.
 *
 * `fast-forward`/`reverse` are proicons' actual double-chevron transport
 * glyphs (⏩/⏪) — used for TransportDock's next/previous track buttons.
 * proicons has no shuffle/random glyph anywhere in its set (checked the full
 * 544-icon list); `arrow-swap` — its closest available crossing-arrows
 * glyph — stands in for the shuffle toggle until a purpose-built one turns
 * up. Flagged, not a clean match.
 *
 * `eye` is proicons' actual "Eye" glyph — the selected-node card's "open
 * full details" button (NodeCard.tsx) used `pencil` for this, which reads
 * as edit rather than view; the click only opens the read-only Inspector
 * Panel, never an edit form (that's MetadataFields.tsx's `onEdit`, a
 * genuinely separate action that keeps `pencil`).
 *
 * `repeat` is proicons' "Arrow Sync" glyph (two arced arrows forming a
 * loop) — same situation as `arrow-swap` above: proicons has no dedicated
 * repeat/loop glyph in its 544-icon set either (checked the manifest), so
 * this is the closest available stand-in, flagged rather than a clean
 * match. TransportDock distinguishes repeat-one from repeat-all with a
 * small "1" badge over the glyph rather than a second vendored icon,
 * since proicons has nothing closer for that state either.
 *
 * `checkmark`, `subtract`, `spinner` and `volume-mute` arrived with the
 * gpui-kit controls port (DESIGN.md "Controls"): the checkbox's checked and
 * indeterminate marks, Select's selected-option mark, NumberInput's
 * decrement (its increment reuses `add`), the Spinner's quarter-open arc
 * (proicons' own "Spinner" glyph, rotated by Spinner.tsx, never redrawn),
 * and the transport's muted-volume state. */
const GLYPHS = {
  add,
  'arrow-swap': arrowSwap,
  cancel,
  checkmark,
  'chevron-down': chevronDown,
  'chevron-up': chevronUp,
  database,
  eye,
  'fast-forward': fastForward,
  heart,
  info,
  list,
  map,
  'panel-left-collapse': panelLeftCollapse,
  pause,
  pencil,
  play,
  repeat,
  reverse,
  search,
  settings,
  sliders,
  spinner,
  subtract,
  tag,
  volume,
  'volume-mute': volumeMute,
} as const

export type IconName = keyof typeof GLYPHS

/* Glyphs whose outline is a closed shape, so filling it draws a solid version
 * of the same glyph. Filling an open path (arrow-swap's arrows, add's cross)
 * would flood the space between strokes instead, so `filled` is a no-op for
 * everything else and callers can pass it without checking. */
const FILLABLE = new Set<IconName>(['play', 'pause', 'heart'])

type IconProps = {
  name: IconName
  /** Rendered box in px. The source SVGs are sized in em, so this drives
   * both. A CSS length string (e.g. a `var(--some-token)` scaling with the
   * viewport) works too — React writes a string style value verbatim — for
   * icons that need to track a token rather than a fixed number. */
  size?: number | string
  className?: string
  /** Omit for icons that sit inside an already-labelled control. */
  title?: string
  /** Renders the glyph as a solid `currentColor` fill instead of an outline
   * stroke — the "on" state for a toggle like the favourites heart.
   * proicons has no filled counterpart for any glyph in its 544-icon set
   * (checked, same as the arrow-swap note above), so this swaps the vendored
   * path's own `fill="none"` at render time rather than hand-drawing a
   * second one, which DESIGN.md's Iconography section rules out. */
  filled?: boolean
}

export function Icon({ name, size = 24, className, title, filled }: IconProps) {
  const markup = filled && FILLABLE.has(name) ? GLYPHS[name].replaceAll('fill="none"', 'fill="currentColor"') : GLYPHS[name]
  return (
    <span
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      style={{
        fontSize: size,
        width: size,
        height: size,
        display: 'inline-flex',
        flex: 'none',
      }}
      // The markup is a build-time constant from our own assets directory,
      // never user input.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
