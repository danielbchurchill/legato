import type { MouseEvent, Ref } from 'react'
import { Icon, type IconName } from './Icon'
import { Tooltip } from './Tooltip'
import type { Placement } from './floating'

/* The ghost icon button: no fill at rest, a --color-wash on hover, and
 * --color-wash-2 with an ink glyph while `active` (the rail's open panel, the
 * player's queue button while the queue is showing). Square, with corners at
 * size/3.2 and the glyph at 0.6 × size, so every size keeps one proportion.
 *
 * The label is both the accessible name and the tooltip, so an icon-only
 * control is never unnamed. */

type IconButtonProps = {
  icon: IconName
  label: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  size?: number
  active?: boolean
  /** Solid glyph for an on state that needs more than the wash (a favourite). */
  filled?: boolean
  disabled?: boolean
  /** Colour of the glyph at rest. Most sit in ink-2; a few quiet ones in ink-3. */
  tone?: 'ink-2' | 'ink-3'
  tooltip?: boolean
  tooltipPlacement?: Placement
  shortcut?: string
  className?: string
  /** For popovers anchoring to the button. */
  ref?: Ref<HTMLButtonElement>
  'aria-pressed'?: boolean
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'dialog' | 'menu' | 'listbox' | true
}

export function IconButton({
  icon,
  label,
  onClick,
  size = 32,
  active = false,
  filled = false,
  disabled,
  tone = 'ink-2',
  tooltip = true,
  tooltipPlacement,
  shortcut,
  className = '',
  ref,
  ...aria
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      {...aria}
      className={`inline-flex shrink-0 items-center justify-center transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] disabled:pointer-events-none disabled:opacity-40 ${
        active
          ? 'bg-[var(--color-wash-2)] text-[var(--color-ink)]'
          : `${tone === 'ink-3' ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink-2)]'} hover:bg-[var(--color-wash)] hover:text-[var(--color-ink)]`
      } ${className}`}
      style={{ width: size, height: size, borderRadius: size / 3.2 }}
    >
      <Icon name={icon} size={Math.round(size * 0.6)} filled={filled} />
    </button>
  )
  return tooltip ? (
    <Tooltip label={label} placement={tooltipPlacement} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
