import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
 *  - Portaled + viewport-fixed collision avoidance: the box renders through
 *    a portal into document.body rather than as a normal DOM child of the
 *    trigger, so it never inherits a stacking context from an ancestor
 *    (InspectorRail and InspectorPanel are both z-10 positioned siblings —
 *    without the portal, the box's own z-30 only wins comparisons *inside*
 *    InspectorRail's local stacking context, never against InspectorPanel's
 *    z-10 at the parent level). Positioned via getBoundingClientRect() in
 *    fixed viewport coordinates and clamped against both the horizontal and
 *    vertical viewport edges (see the useLayoutEffect below) — the rail's
 *    icons run down the full window height, so a bottom icon's tooltip needs
 *    the same edge protection top-to-bottom that a wide header row already
 *    needed left-to-right. Re-measured on scroll/resize so a tooltip open in
 *    a scrollable panel (Playlists, Favourites, NowPlayingPanel, ...) stays
 *    glued to its trigger rather than a stale fixed position.
 *  - "Hot" group dwell-skip: wrapping a row of triggers in TooltipGroup
 *    (TooltipGroup.tsx) lets a sibling's tooltip appear immediately if the
 *    previous one in the group was dismissed within the dwell window,
 *    rather than every icon paying the full 400ms from cold. */

const DWELL_MS = 400
const EDGE_MARGIN = 8
const GAP_PX = 6

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
  const [coords, setCoords] = useState({ top: 0, left: 0 })
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
  // own size every time, in fixed viewport coordinates — the box is portaled
  // to document.body, so there is no ancestor offset to account for, just
  // the trigger's own position and the window's edges. useLayoutEffect (not
  // useEffect) so the position lands before the browser paints. Re-measured
  // on scroll/resize while mounted so a tooltip open inside a scrollable
  // panel tracks its trigger instead of drifting once the panel scrolls.
  useLayoutEffect(() => {
    if (!mounted) return
    const wrap = wrapRef.current
    const box = boxRef.current
    if (wrap == null || box == null) return

    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()

      const naturalLeft = wrapRect.left + wrapRect.width / 2 - boxRect.width / 2
      const minLeft = EDGE_MARGIN
      const maxLeft = window.innerWidth - EDGE_MARGIN - boxRect.width
      const left = Math.min(Math.max(naturalLeft, minLeft), maxLeft)

      const naturalTop = wrapRect.bottom + GAP_PX
      const minTop = EDGE_MARGIN
      const maxTop = window.innerHeight - EDGE_MARGIN - boxRect.height
      const top = Math.min(Math.max(naturalTop, minTop), maxTop)

      setCoords({ top, left })
    }

    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
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
      {mounted &&
        createPortal(
          <span
            ref={boxRef}
            role="tooltip"
            className={`pointer-events-none fixed z-30 rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-[10px] py-[4px] text-[length:var(--text-base)] whitespace-nowrap text-[var(--color-ink)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] ${monospace ? 'font-[family-name:var(--font-mono)]' : ''}`}
            style={{ opacity: shown ? 1 : 0, top: `${coords.top}px`, left: `${coords.left}px` }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  )
}
