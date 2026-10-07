import { Tooltip } from './Tooltip'

/* The on/off switch — a hand port of gpui-kit's Switch
 * (crates/component/src/switch.rs), drawn in Legato's palette. Replaces v2's
 * 20x10 Toggle. See DESIGN.md "Controls".
 *
 * What gpui-kit brought, and which Legato rule each one overrode:
 *  - State reads from colour as well as position. Off is a --color-control
 *    track; on is a --color-ink track — gpui-kit's `primary`, which Legato
 *    has no separate accent for, deliberately. The thumb is --color-canvas
 *    either way, so it cuts out of whichever track it sits on. v2's rule was
 *    knob position only, one resting colour throughout; at a glance across
 *    a settings panel that made every switch look off.
 *  - Three sizes, gpui-kit's own: 28x16 / 36x20 / 44x24 tracks, 12/16/20
 *    thumbs, 2px inset. The inset is a 1px transparent border plus 1px of
 *    padding, not a 2px border, for the reason switch.rs gives: the focus
 *    ring tints that line, and without it the ring's halo would all but
 *    vanish against an off track.
 *  - The thumb travels on --ease-spring over --motion-spring, gpui-kit's
 *    spring_move. A CSS transition retargets from the thumb's live position,
 *    so a second click mid-travel reverses from where it is — the property
 *    switch.rs's own comment calls out as why the thumb's position isn't a
 *    semantic state style there. It's a transform on transition-transform,
 *    so index.css's reduced-motion rule makes it a jump.
 *  - Disabled fades the track alone to 50%. Fading the whole control would
 *    let the track show through the thumb (switch.rs again), and the thumb
 *    is the canvas colour, so fading it would only reveal track.
 *  - The focus ring hugs the track, not the row — a label next to it stays
 *    outside the ring (data-focus-ring="part", see index.css).
 *  - An optional label, clickable as part of the control, to either side. */

export type SwitchSize = 'sm' | 'md' | 'lg'

/* v2: md is 34×20 with a 16px knob travelling 14px. On is the accent
 * gradient with an on-accent knob; off is a --color-wash-2 track with an
 * ink-2 knob, so off reads as a recess rather than as a second colour. */
const GEOMETRY: Record<SwitchSize, { track: string; thumb: string; travel: number }> = {
  sm: { track: 'h-[16px] w-[28px]', thumb: 'size-[12px]', travel: 28 - 12 - 4 },
  md: { track: 'h-[20px] w-[34px]', thumb: 'size-[16px]', travel: 34 - 16 - 4 },
  lg: { track: 'h-[24px] w-[44px]', thumb: 'size-[20px]', travel: 44 - 20 - 4 },
}

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  size?: SwitchSize
  /** Visible text beside the switch. Also its accessible name unless
   * `accessibilityLabel` says otherwise. */
  label?: string
  labelSide?: 'left' | 'right'
  /** The accessible name when there's no visible label, or when the
   * visible one is too terse on its own ("lock"). */
  accessibilityLabel?: string
  tooltip?: string
  className?: string
}

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  label,
  labelSide = 'right',
  accessibilityLabel,
  tooltip,
  className = '',
}: SwitchProps) {
  const geometry = GEOMETRY[size]

  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={accessibilityLabel ?? label}
      disabled={disabled}
      data-focus-ring="part"
      onClick={() => onChange(!checked)}
      className={`inline-flex shrink-0 items-center gap-[8px] disabled:cursor-not-allowed ${
        labelSide === 'left' ? 'flex-row-reverse' : ''
      } ${className}`}
    >
      <span
        className={`focus-ring-part flex shrink-0 items-center rounded-full border border-transparent p-[1px] transition-[background-color,opacity] duration-[var(--motion-fast)] ease-[var(--ease-out)] ${geometry.track} ${
          checked ? 'bg-[image:var(--accent-fill)]' : 'bg-[var(--color-wash-2)]'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className={`rounded-full transition-[transform,background-color] duration-[var(--motion-spring)] ease-[var(--ease-spring)] ${geometry.thumb} ${
            checked ? 'bg-[var(--color-on-accent)]' : 'bg-[var(--color-ink-2)]'
          }`}
          style={{ transform: `translateX(${checked ? geometry.travel : 0}px)` }}
        />
      </span>
      {label && (
        <span
          className={`min-w-0 text-left text-[length:var(--text-secondary)] ${
            disabled ? 'text-[color:var(--color-ink-3)]' : 'text-[color:var(--color-ink)]'
          }`}
        >
          {label}
        </span>
      )}
    </button>
  )

  return tooltip ? <Tooltip label={tooltip}>{control}</Tooltip> : control
}
