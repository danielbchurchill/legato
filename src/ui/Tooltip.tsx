import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMountFade } from './useMountFade'

/* C-1: native title= tooltips render as OS chrome — wrong typeface, wrong
 * colors, roughly a second of delay, positioned by the window manager,
 * unstylable. One glass tooltip instead, on the same recipe as every other
 * raised surface (DESIGN.md "Glass"): --color-surface, hairline border,
 * --radius-surface, Rubik at --text-base.
 *
 * A short dwell before showing, and a fade rather than a snap, so sweeping
 * the pointer across a row of icons doesn't flash a tooltip per icon —
 * the same "distinguish holding still from passing over" reasoning as the
 * graph's own hover dwell (MO-6). aria-label is what actually carries the
 * accessible name; this is a purely visual affordance layered on top. */

const DWELL_MS = 400

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const shown = useMountFade(mounted)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDwell = () => {
    if (dwellRef.current != null) clearTimeout(dwellRef.current)
    dwellRef.current = null
  }

  const scheduleShow = () => {
    clearDwell()
    dwellRef.current = setTimeout(() => setMounted(true), DWELL_MS)
  }

  const hide = () => {
    clearDwell()
    setMounted(false)
  }

  useEffect(() => clearDwell, [])


  return (
    <span
      className="relative inline-flex"
      onPointerEnter={scheduleShow}
      onPointerLeave={hide}
      onFocus={scheduleShow}
      onBlur={hide}
    >
      {children}
      {mounted && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-1/2 z-30 mt-[6px] -translate-x-1/2 rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-[10px] py-[4px] text-[length:var(--text-base)] whitespace-nowrap text-[var(--color-ink)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]"
          style={{ opacity: shown ? 1 : 0 }}
        >
          {label}
        </span>
      )}
    </span>
  )
}
