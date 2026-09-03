import type { ReactNode } from 'react'
import { ScrollingText } from './ScrollingText'

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
  // Only a plain string/number value can be handed to ScrollingText, which
  // measures and renders `text` itself — an in-progress edit's <input> (see
  // MetadataFields.tsx) or any other element value keeps the plain span.
  const scrollable = truncate && (typeof value === 'string' || typeof value === 'number')
  return (
    // min-h, not h: a label with no room to itself (e.g. "edges: featured_artist")
    // wraps to two lines rather than overflowing its column, and a fixed row
    // height combined with items-center meant the wrapped line spilled into
    // the row below it with no line-height to separate the two. min-h lets
    // the row grow for that case while staying exactly --spacing-row tall
    // for the common single-line one.
    <div className="grid min-h-[var(--spacing-row)] grid-cols-[57%_43%] items-center">
      <span className="text-[length:var(--text-base)] leading-[24px] text-[var(--color-muted)]">{label}</span>
      {scrollable ? (
        <ScrollingText
          text={String(value)}
          className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
        />
      ) : (
        <span
          className={`font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)] ${
            truncate ? 'truncate' : ''
          }`}
        >
          {value}
        </span>
      )}
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
