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
 * The play glyph sits 2px right of centre (scaled with the circle): a
 * triangle's visual mass is left of its bounding box's middle, and a
 * centred one reads as drifting left. */

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
  const nudge = playing ? 0 : Math.round((size / 40) * 2)
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
      <span className="inline-flex" style={{ transform: `translateX(${nudge}px)` }}>
        <Icon name={playing ? 'pause' : 'play'} size={Math.round(size * 0.45)} filled />
      </span>
    </button>
  )
}
