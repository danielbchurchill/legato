import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { SectionLabel } from '../ui/SectionLabel'

/* The pushed pages' grouped cards (#389, Legato Mobile v2's screens 8 and
 * 9): a 12/500 ink-2 label over a solid card with 16px corners and a
 * hairline edge, holding rows at least 52px tall, divided by hairlines.
 * The desktop's settings groups draw the same way on a phone page
 * (SettingsPrimitives.tsx), for the cards that hold a control rather than
 * rows. */

export function PageGroup({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <SectionLabel className="px-[4px] pt-[20px] pb-[8px]">{label}</SectionLabel>
      <div className="flex flex-col divide-y divide-[var(--color-line)] rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] px-[16px]">
        {children}
      </div>
      {note && <PageNote>{note}</PageNote>}
    </section>
  )
}

/** A line under a card, saying what its rows mean. */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="px-[4px] pt-[12px] text-[13px] leading-[18px] [text-wrap:pretty] text-[var(--color-ink-2)]">{children}</p>
}

type PageRowProps = {
  label: ReactNode
  /** A second, quieter line under the label. */
  detail?: ReactNode
  /** On the right: a value, or the row's own control. */
  trailing?: ReactNode
  /** Makes the whole row one button, with a chevron when it goes somewhere. */
  onClick?: () => void
  chevron?: boolean
  /** The accessible name, when the row's words alone don't say it. */
  'aria-label'?: string
}

/* A row: its label in 16px ink on the left, and on the right a value, a
 * control or a chevron. A row that's a button is a 52px tap target end to
 * end. */
export function PageRow({ label, detail, trailing, onClick, chevron = false, 'aria-label': ariaLabel }: PageRowProps) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col py-[8px]">
        <span className="text-[16px] leading-[21px] text-[var(--color-ink)]">{label}</span>
        {detail && <span className="truncate text-[13px] leading-[18px] text-[var(--color-ink-2)]">{detail}</span>}
      </span>
      {trailing}
      {chevron && (
        <span className="inline-flex shrink-0 -rotate-90 text-[var(--color-ink-3)]">
          <Icon name="chevron-down" size={18} />
        </span>
      )}
    </>
  )
  const layout = 'flex min-h-[52px] w-full items-center gap-[10px] text-left'
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={layout}>
      {body}
    </button>
  ) : (
    <div className={layout}>{body}</div>
  )
}

/** A row's value: what the setting is now, in ink-2. Mono for data (counts,
 * names off the server), Rubik for words. */
export function RowValue({ mono = false, children }: { mono?: boolean; children: ReactNode }) {
  return (
    <span
      className={`flex min-w-0 shrink items-center gap-[6px] truncate text-[var(--color-ink-2)] ${mono ? 'mono text-[13px]' : 'text-[14px]'}`}
    >
      {children}
    </span>
  )
}
