import type { ReactNode } from 'react'

/* A filter or connection chip: 28px pill, 13/500 ink-2 inside a
 * --color-line-strong border. Active inverts to an ink fill with canvas text,
 * the strongest "this one" the palette has short of the accent. The optional
 * count rides at 70% in mono 11, so it reads as a property of the label
 * rather than a second label. */

type ChipProps = {
  children: ReactNode
  active?: boolean
  count?: number | string
  onClick?: () => void
  /** A chip with no onClick is a plain label (a connection), not a button. */
  className?: string
  title?: string
}

export function Chip({ children, active = false, count, onClick, className = '', title }: ChipProps) {
  const classes = `inline-flex h-[28px] shrink-0 items-center gap-[6px] rounded-full border px-[12px] text-[length:var(--text-secondary)] leading-none font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
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
    <button type="button" onClick={onClick} aria-pressed={active} className={classes} title={title}>
      {content}
    </button>
  )
}
