import type { MouseEvent } from 'react'
import { Icon } from './Icon'

/* The round play control. Two looks, by what the circle is doing:
 *
 *  - `accent`: a gradient disc with a shadow — "start this". Album hover, the
 *    hovered playlist row, the top search result. 40 or 30.
 *  - `ink`: a solid ink disc with the glyph cut out in the canvas colour —
 *    the player's own play/pause, where the control is about what's already
 *    playing rather than an invitation. 34.
 *
 * The glyph box is centred and the play glyph gets no nudge of its own (#283).
 * A triangle's visual mass is left of its bounding box's middle, so a
 * box-centred one reads as drifting left, but proicons' `play.svg` already
 * makes up for it: its path's box spans x 5.5 to 20.5 of 24, a unit right of
 * centre. In the circle that lands the triangle's box 0.6–0.75px right of
 * centre and its centroid about 0.5px left, between the two, which reads as
 * centred at 30, 34 and 40. A 2px shift on top of that pushed it visibly
 * right. */

type PlayCircleProps = {
  size?: number
  variant?: 'accent' | 'ink'
  playing?: boolean
  label: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  className?: string
}

export function PlayCircle({ size = 40, variant = 'accent', playing = false, label, onClick, disabled, className = '' }: PlayCircleProps) {
  const accent = variant === 'accent'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-[filter,transform] duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:brightness-110 disabled:pointer-events-none disabled:opacity-40 ${
        accent
          ? 'bg-[image:var(--accent-fill)] text-[var(--color-on-accent)] shadow-[var(--shadow-sm)]'
          : 'bg-[var(--color-ink)] text-[var(--color-canvas)]'
      } ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={Math.round(size * 0.45)} filled />
    </button>
  )
}
