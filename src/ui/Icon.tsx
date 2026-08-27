import arrowMinimize from '../assets/icons/arrow-minimize.svg?raw'
import cancel from '../assets/icons/cancel.svg?raw'
import chevronDown from '../assets/icons/chevron-down.svg?raw'
import info from '../assets/icons/info.svg?raw'
import pause from '../assets/icons/pause.svg?raw'
import pencil from '../assets/icons/pencil.svg?raw'
import play from '../assets/icons/play.svg?raw'
import search from '../assets/icons/search.svg?raw'
import settings from '../assets/icons/settings.svg?raw'
import spacebar from '../assets/icons/spacebar.svg?raw'
import volume from '../assets/icons/volume.svg?raw'

/* Icons are proicons, the set the mockup specifies, vendored as real SVG from
 * Iconify rather than redrawn. Every glyph is a 24x24 currentColor stroke at
 * 1.5 with round caps, so they inherit text color and size from their box. */
const GLYPHS = {
  'arrow-minimize': arrowMinimize,
  cancel,
  'chevron-down': chevronDown,
  info,
  pause,
  pencil,
  play,
  search,
  settings,
  spacebar,
  volume,
} as const

export type IconName = keyof typeof GLYPHS

type IconProps = {
  name: IconName
  /** Rendered box in px. The source SVGs are sized in em, so this drives
   * both. A CSS length string (e.g. `var(--titlebar-control-size)`) works
   * too — React writes a string style value verbatim — for icons that need
   * to track a scaling token rather than a fixed number. */
  size?: number | string
  className?: string
  /** Omit for icons that sit inside an already-labelled control. */
  title?: string
}

export function Icon({ name, size = 24, className, title }: IconProps) {
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
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] }}
    />
  )
}
