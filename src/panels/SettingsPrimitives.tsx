import type { ReactNode } from 'react'

/* Shared layout primitives for the app's settings surfaces — Music Map
 * settings (MusicMapSettings.tsx) and Legato settings (LegatoSettings.tsx).
 * See DESIGN.md "Controls" -> "v2: settings primitives": every group is a
 * muted --text-base title over a stack of --text-sm label/control rows. */

export function GroupHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{title}</p>
      {action}
    </div>
  )
}

/* A settings group's title plus the rest of its rows, closed off by the
 * divider Figma draws at the bottom of every group ("nodes", "links",
 * "forces", and Legato Settings' own groups alike) to separate it from the
 * next — confirmed against the Music Map settings frame, node 58:2, where
 * each group is one bordered/pb-[15px] block, not a bare header. */
export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--spacing-sm)] border-b border-[var(--color-divider)] pb-[15px]">
      <GroupHeader title={title} action={action} />
      {children}
    </div>
  )
}

export function SettingsRow({
  label,
  align = 'center',
  children,
}: {
  label: string
  /** 'start' for a row whose control can wrap to more than one line (color
   * swatches, a folder list) — 'center' would otherwise vertically center the
   * label against the whole wrapped block instead of its first line. */
  align?: 'center' | 'start'
  children: ReactNode
}) {
  return (
    <div className={`flex gap-[var(--spacing-sm)] ${align === 'center' ? 'items-center' : 'items-start'}`}>
      <span className="w-[68px] shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
