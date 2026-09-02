import add from '../assets/icons/add.svg?raw'
import arrowSwap from '../assets/icons/arrow-swap.svg?raw'
import cancel from '../assets/icons/cancel.svg?raw'
import chevronDown from '../assets/icons/chevron-down.svg?raw'
import chevronUp from '../assets/icons/chevron-up.svg?raw'
import database from '../assets/icons/database.svg?raw'
import fastForward from '../assets/icons/fast-forward.svg?raw'
import heart from '../assets/icons/heart.svg?raw'
import info from '../assets/icons/info.svg?raw'
import list from '../assets/icons/list.svg?raw'
import map from '../assets/icons/map.svg?raw'
import panelLeftCollapse from '../assets/icons/panel-left-collapse.svg?raw'
import pause from '../assets/icons/pause.svg?raw'
import pencil from '../assets/icons/pencil.svg?raw'
import play from '../assets/icons/play.svg?raw'
import reverse from '../assets/icons/reverse.svg?raw'
import search from '../assets/icons/search.svg?raw'
import sliders from '../assets/icons/sliders.svg?raw'
import tag from '../assets/icons/tag.svg?raw'
import volume from '../assets/icons/volume.svg?raw'

/* Icons are proicons (github.com/ProCode-Software/proicons), vendored as real
 * SVG rather than redrawn. Every glyph is a 24x24 currentColor stroke at 1.5
 * with round caps, so they inherit text color and size from their box.
 *
 * `sliders` is v2's left icon rail glyph for its "Legato Settings"
 * destination. A separate `settings` gear glyph briefly existed alongside it
 * for CollectionPanel's own settings-gear button (opening the old
 * SettingsView modal) — removed once that modal's content moved behind the
 * rail destination instead, its one call site going with it.
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
 * up. Flagged, not a clean match. */
const GLYPHS = {
  add,
  'arrow-swap': arrowSwap,
  cancel,
  'chevron-down': chevronDown,
  'chevron-up': chevronUp,
  database,
  'fast-forward': fastForward,
  heart,
  info,
  list,
  map,
  'panel-left-collapse': panelLeftCollapse,
  pause,
  pencil,
  play,
  reverse,
  search,
  sliders,
  tag,
  volume,
} as const

export type IconName = keyof typeof GLYPHS

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
  const markup = filled ? GLYPHS[name].replaceAll('fill="none"', 'fill="currentColor"') : GLYPHS[name]
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
