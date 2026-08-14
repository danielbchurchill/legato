import type { ReactNode } from 'react'

/* The core pattern of every panel: Rubik/muted names a thing, Sometype
 * Mono/ink is the thing. See DESIGN.md "The one rule" — a grey value or a mono
 * label breaks the read and should be treated as a defect.
 *
 * Values are left-aligned at a fixed column rather than right-aligned against
 * the panel edge, which is what the mockup measures: every value in both the
 * overview and metadata lists starts at the same x, ~57% across the content
 * width, regardless of how long its label is. */

type DataRowProps = {
  label: string
  value: ReactNode
  /** Long values (paths, titles) ellipsize rather than wrapping the row. */
  truncate?: boolean
}

export function DataRow({ label, value, truncate = true }: DataRowProps) {
  return (
    <div className="grid h-[var(--spacing-row)] grid-cols-[57%_43%] items-center">
      <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">{label}</span>
      <span
        className={`font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] ${
          truncate ? 'truncate' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )
}

/* Section header plus its rule, at the measured 31px/16px rhythm. Used by
 * overview, metadata, maintenance and up-next alike. */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="pt-[15px]">
      <div className="flex h-[16px] items-center justify-between">
        <span className="text-[length:var(--text-base)] leading-none text-[var(--color-muted)]">
          {title}
        </span>
        {action}
      </div>
      <div className="mt-[15px] h-px w-full bg-[var(--color-divider)]" />
    </div>
  )
}
