import type { ReactNode } from 'react'

/* A section's label: 12/16 500 ink-2 with +0.02em tracking, lowercase, and
 * an optional trailer on the right — a mono count, or a link ("see all").
 * This is the v2 replacement for SectionHeader's header-rule-row rhythm:
 * sections are separated by space now, not by rules. */

export function SectionLabel({
  children,
  count,
  action,
  className = '',
}: {
  children: ReactNode
  count?: number | string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-[8px] ${className}`}>
      <h3 className="text-label text-[var(--color-ink-2)]">{children}</h3>
      {count != null && <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{count}</span>}
      {action}
    </div>
  )
}
