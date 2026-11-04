import { useContext, type ReactNode } from 'react'
import { formatCount } from '../ui/format'
import { TitledContext } from './titledContext'

/* The parts every Library health worklist is drawn from: its heading (a
 * title and count over one line on what it is), a card per item, and the
 * quiet line when there's nothing. Worklists.tsx and MetadataGaps.tsx share
 * them. */

export function Heading({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  const titled = useContext(TitledContext)
  if (!titled) {
    return (
      <div className="mt-[4px] mb-[14px] flex items-start justify-between gap-[12px]">
        <p className="text-[length:var(--text-secondary)] leading-[18px] [text-wrap:pretty] text-[var(--color-ink-2)]">{children}</p>
        {count != null && (
          <span className="mono pt-[1px] text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatCount(count)}</span>
        )}
      </div>
    )
  }
  return (
    <>
      <div className="flex min-h-[36px] items-start justify-between gap-[8px]">
        <h2 className="text-title text-[var(--color-ink)]">{title}</h2>
        {count != null && (
          <span className="mono pt-[6px] text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatCount(count)}</span>
        )}
      </div>
      <p className="mt-[6px] mb-[14px] text-[length:var(--text-secondary)] leading-[18px] [text-wrap:pretty] text-[var(--color-ink-2)]">
        {children}
      </p>
    </>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-[10px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px] ${className}`}>{children}</div>
  )
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="pt-[12px] text-center text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">{children}</p>
}
