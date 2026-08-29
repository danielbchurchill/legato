import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMountFade } from './useMountFade'
import { useTooltipGroup } from './TooltipGroup'

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
 * accessible name; this is a purely visual affordance layered on top.
 *
 * Two refinements on top of that base behavior:
 *  - Viewport-edge collision avoidance: the box is measured against the
 *    trigger's own position after it mounts and shifted horizontally to
 *    stay clear of the window edge (see the useLayoutEffect below).
 *  - "Hot" group dwell-skip: wrapping a row of triggers in TooltipGroup
 *    (TooltipGroup.tsx) lets a sibling's tooltip appear immediately if the
 *    previous one in the group was dismissed within the dwell window,
 *    rather than every icon paying the full 400ms from cold. */

const DWELL_MS = 400
const EDGE_MARGIN = 8

type TooltipProps = {
  label: string
  children: ReactNode
  /** The label is data (a URL, a path) rather than UI copy — Sometype Mono
   * instead of the default Rubik. See DESIGN.md "The one rule". */
  monospace?: boolean
}

export function Tooltip({ label, children, monospace = false }: TooltipProps) {
  const [mounted, setMounted] = useState(false)
  const shown = useMountFade(mounted)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const boxRef = useRef<HTMLSpanElement>(null)
  const [shiftPx, setShiftPx] = useState(0)
  const group = useTooltipGroup()

  const clearDwell = () => {
    if (dwellRef.current != null) clearTimeout(dwellRef.current)
    dwellRef.current = null
  }

  const scheduleShow = () => {
    clearDwell()
    // Hot group: a sibling in the same TooltipGroup was dismissed within the
    // dwell window, so skip straight to showing — this is what actually
    // makes sweeping across a row of icons read as one continuous tooltip
    // rather than N independent cold-start waits (see TooltipGroup.tsx).
    const lastDismissed = group?.current
    if (lastDismissed != null && Date.now() - lastDismissed < DWELL_MS) {
      setMounted(true)
      return
    }
    dwellRef.current = setTimeout(() => setMounted(true), DWELL_MS)
  }

  const hide = () => {
    clearDwell()
    setMounted(false)
    if (group) group.current = Date.now()
  }

  useEffect(() => clearDwell, [])

  // Collision avoidance: derived fresh from the trigger's rect and the box's
  // own width every time, never from the previously-applied shift — feeding
  // an already-shifted rect back in would drift the box further off its
  // true centered position on every re-measure. useLayoutEffect (not
  // useEffect) so the corrected position lands before the browser paints;
  // the box starts centered via the left-1/2/-translate-x-1/2 classes below
  // and this only overrides that once a correction is actually needed.
  useLayoutEffect(() => {
    if (!mounted) return
    const wrap = wrapRef.current
    const box = boxRef.current
    if (wrap == null || box == null) return

    const wrapRect = wrap.getBoundingClientRect()
    const boxWidth = box.getBoundingClientRect().width
    const wrapCenterX = wrapRect.left + wrapRect.width / 2

    const naturalLeft = wrapCenterX - boxWidth / 2
    const minLeft = EDGE_MARGIN
    const maxLeft = window.innerWidth - EDGE_MARGIN - boxWidth
    const clampedLeft = Math.min(Math.max(naturalLeft, minLeft), maxLeft)

    setShiftPx(clampedLeft - naturalLeft)
  }, [mounted, label])

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onPointerEnter={scheduleShow}
      onPointerLeave={hide}
      onFocus={scheduleShow}
      onBlur={hide}
    >
      {children}
      {mounted && (
        <span
          ref={boxRef}
          role="tooltip"
          className={`pointer-events-none absolute top-full left-1/2 z-30 mt-[6px] -translate-x-1/2 rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-[10px] py-[4px] text-[length:var(--text-base)] whitespace-nowrap text-[var(--color-ink)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] ${monospace ? 'font-[family-name:var(--font-mono)]' : ''}`}
          style={{ opacity: shown ? 1 : 0, transform: `translateX(calc(-50% + ${shiftPx}px))` }}
        >
          {label}
        </span>
      )}
    </span>
  )
}
