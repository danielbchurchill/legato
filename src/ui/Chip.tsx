import type { ReactNode } from 'react'
import { useTouchLayout } from './touchLayout'

/* A filter or connection chip: 28px pill, 13/500 ink-2 inside a
 * --color-line-strong border. Active inverts to an ink fill with canvas text,
 * the strongest "this one" the palette has short of the accent. The optional
 * count rides at 70% in mono 11, so it reads as a property of the label
 * rather than a second label. A chip that's a button takes taps across 44px
 * in the phone's touch layout (touchLayout.ts).
 *
 * `lg` is the phone library's chip (#389, Legato Mobile v2): 32px with 14px
 * sides. Its row places its 44px target, since where there's room for one
 * depends on what's around the row. */

type ChipProps = {
  children: ReactNode
  active?: boolean
  count?: number | string
  onClick?: () => void
  /** A chip with no onClick is a plain label (a connection), not a button. */
  className?: string
  size?: 'md' | 'lg'
  title?: string
}

const SIZE = {
  md: 'h-[28px] px-[12px]',
  lg: 'h-[32px] px-[14px]',
}

export function Chip({ children, active = false, count, onClick, className = '', title, size = 'md' }: ChipProps) {
  const touch = useTouchLayout()
  const classes = `inline-flex ${SIZE[size]} shrink-0 items-center gap-[6px] rounded-full border text-[length:var(--text-secondary)] leading-none font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
    active
      ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
      : 'border-[var(--color-line-strong)] text-[var(--color-ink-2)]'
  } ${onClick && !active ? 'hover:bg-[var(--color-wash)] hover:text-[var(--color-ink)]' : ''} ${className}`
  const content = (
    <>
      <span className="min-w-0 truncate">{children}</span>
      {count != null && <span className="mono text-[11px] opacity-70">{count}</span>}
    </>
  )
  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {content}
      </span>
    )
  }
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${classes} ${touch ? 'touch-target' : ''}`} title={title}>
      {content}
    </button>
  )
}
