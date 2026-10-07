import type { ReactNode } from 'react'

/* A keycap, v2: at least 18 wide and 20 tall so "/" doesn't collapse next to
 * "space", 5px corners, a --color-line-strong border, mono 11 in ink-2 —
 * a key name is a fixed token, like a format or a path. `muted` is the
 * borderless form for a key riding inside something else, like a tooltip,
 * where a second bordered box would crowd the first. */
export function Kbd({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <kbd
      className={`mono inline-flex shrink-0 items-center justify-center text-[11px] leading-none ${
        muted
          ? 'text-[color:var(--color-ink-3)]'
          : 'h-[20px] min-w-[18px] rounded-[5px] border border-[var(--color-line-strong)] px-[5px] text-[var(--color-ink-2)]'
      }`}
    >
      {children}
    </kbd>
  )
}
