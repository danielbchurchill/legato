import type { ReactNode } from 'react'
import { SectionLabel } from '../ui/SectionLabel'
import { useTouchLayout } from '../ui/touchLayout'

/* Settings layout, v2: a stack of cards (--color-wash, 14px corners and
 * padding, 10px between rows), each headed by a lowercase section label.
 * A row is a body-size label on the left and its control on the right,
 * or — for a control that wraps (a folder list, a long select) — the
 * label above it.
 *
 * On the phone's Settings page (#389, the touch layout) a group is one of
 * Legato Mobile v2's grouped cards instead: the label above the card, and
 * the card solid with 16px corners, a hairline edge and 16px padding. */

export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const touch = useTouchLayout()
  if (touch) {
    return (
      <section className="flex flex-col">
        <SectionLabel action={action} className="px-[4px] pt-[20px] pb-[8px]">
          {title}
        </SectionLabel>
        <div className="flex flex-col gap-[12px] rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] p-[16px]">
          {children}
        </div>
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-[10px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[14px]">
      <SectionLabel action={action}>{title}</SectionLabel>
      {children}
    </section>
  )
}

export function SettingsRow({
  label,
  align = 'center',
  children,
}: {
  label: string
  /** 'start' stacks the label over a control that can wrap to several lines. */
  align?: 'center' | 'start'
  children: ReactNode
}) {
  if (align === 'start') {
    return (
      <div className="flex flex-col gap-[6px]">
        <span className="text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{label}</span>
        <div className="min-w-0">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex min-h-[32px] items-center justify-between gap-[12px]">
      <span className="min-w-0 text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{label}</span>
      <div className="flex min-w-0 shrink-0 justify-end">{children}</div>
    </div>
  )
}
