import type { ReactNode } from 'react'

/* Label/value rows for metadata: a 110px label column in small ink-2, the
 * value in mono ink, 36px rows with a hairline between them. Values are
 * selectable — an MBID or a path is something you copy. */

export type DetailRow = { label: string; value: ReactNode; title?: string }

export function DetailRows({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="flex flex-col">
      {rows.map((row, i) => (
        <div
          key={row.label}
          className={`grid h-[36px] grid-cols-[110px_minmax(0,1fr)] items-center gap-[10px] ${i > 0 ? 'border-t border-[var(--color-line)]' : ''}`}
        >
          <dt className="text-small text-[var(--color-ink-2)]">{row.label}</dt>
          <dd data-selectable title={row.title} className="mono min-w-0 truncate text-[length:var(--text-mono)] text-[var(--color-ink)]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
