/* An 8px status dot. The status palette (--color-ok/warn/bad) is the only
 * place v2 spends hue on meaning outside the map, so a dot always sits next to
 * words that say the same thing — colour is the glance, not the message. */

export type Status = 'ok' | 'warn' | 'bad' | 'accent' | 'idle'

const FILL: Record<Status, string> = {
  ok: 'bg-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn)]',
  bad: 'bg-[var(--color-bad)]',
  accent: 'bg-[var(--color-accent)]',
  idle: 'bg-[var(--color-ink-3)]',
}

export function StatusDot({ status, size = 8, className = '' }: { status: Status; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${FILL[status]} ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
