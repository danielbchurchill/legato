import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useMountFade } from './useMountFade'
import { useTooltipGroup } from './tooltipGroupContext'
import { enterOffset, useAnchoredPosition, type Placement } from './floating'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import { Kbd } from './Kbd'

/* C-1: native title= tooltips render as OS chrome — wrong typeface, wrong
 * colors, roughly a second of delay, positioned by the window manager,
 * unstylable. One glass tooltip instead, on the same recipe as every other
 * raised surface (DESIGN.md "Glass"): --color-surface, hairline border,
 * --radius-surface.
 *
 * gpui-kit port (2026-09-29) — its tooltip.rs, drawn in Legato's glass:
 *  - Control-chrome scale: --text-sm, 8px/2px padding, where it used to be a
 *    16px panel label on 10px/4px. A tooltip is chrome about a control, the
 *    exact register --text-sm exists for.
 *  - An optional keyboard shortcut, right-aligned in muted Kbd.
 *  - Arrives sliding --distance-short out of its trigger as it fades
 *    (gpui-kit's enter transition), over --motion-fast on --ease-enter.
 *    The slide is a transform, so reduced motion drops it and keeps the
 *    fade (DESIGN.md "Reduced motion means less movement, not less
 *    feedback").
 *  - Opens on its preferred side and flips when that side has no room,
 *    rather than clamping over its own trigger (floating.ts).
 *
 * Kept from before: the 400ms dwell, so sweeping the pointer across a row
 * of icons doesn't flash a tooltip per icon; TooltipGroup's "hot" skip of
 * that dwell for a sibling; dismiss on pointerdown (C-82, below); aria-label
 * on the trigger carrying the accessible name, with this purely visual. */

const DWELL_MS = 400

type TooltipProps = {
  label: string
  children: ReactNode
  /** The label is data (a URL, a path) rather than UI copy — Sometype Mono
   * instead of the default Rubik. See DESIGN.md "The one rule". */
  monospace?: boolean
  placement?: Placement
  /** A keyboard shortcut for the action, e.g. "space" or "/". */
  shortcut?: string
}

/* The floating half on its own, for a caller that owns when it shows —
 * Slider's value bubble opens on thumb hover, drag or focus rather than on
 * a dwell. */
export function TooltipBubble({
  open,
  anchorRef,
  label,
  placement = 'bottom',
  monospace = false,
  shortcut,
  trackDeps = [],
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  label: ReactNode
  placement?: Placement
  monospace?: boolean
  shortcut?: string
  /** Re-measure when these change — Slider passes its value, since the
   * thumb moves under a stationary bubble while dragging. */
  trackDeps?: readonly unknown[]
}) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const shown = useMountFade(open)
  const reduced = usePrefersReducedMotion()
  const position = useAnchoredPosition({ open, anchorRef, floatingRef: boxRef, placement, deps: [label, ...trackDeps] })

  if (!open) return null
  return createPortal(
    <span
      ref={boxRef}
      role="tooltip"
      className={`pointer-events-none fixed z-40 flex items-center gap-[var(--spacing-sm)] rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-solid)] px-[8px] py-[2px] text-[length:var(--text-sm)] whitespace-nowrap text-[var(--color-ink)] shadow-[var(--shadow-sm)] transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)] ${monospace ? 'font-[family-name:var(--font-mono)]' : ''}`}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown || reduced ? 'none' : enterOffset(position.placement),
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {label}
      {shortcut && <Kbd muted>{shortcut}</Kbd>}
    </span>,
    document.body,
  )
}

export function Tooltip({ label, children, monospace = false, placement = 'bottom', shortcut }: TooltipProps) {
  const [mounted, setMounted] = useState(false)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
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
    if (group?.dismissedWithin(DWELL_MS)) {
      setMounted(true)
      return
    }
    dwellRef.current = setTimeout(() => setMounted(true), DWELL_MS)
  }

  const hide = () => {
    clearDwell()
    setMounted(false)
    group?.markDismissed()
  }

  useEffect(() => clearDwell, [])

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onPointerEnter={scheduleShow}
      onPointerLeave={hide}
      // C-82: a click on the trigger routinely reorders or removes the very
      // row it lives in (Playlists' move up/down, Favourites' remove,
      // NowPlayingPanel's queue reorder — all keyed lists, so React
      // relocates the same DOM node rather than remounting it) without the
      // pointer itself moving. Browsers only recompute hover on an actual
      // pointer move, so no pointerleave ever fires on a node that was
      // yanked out from under a stationary cursor — the tooltip is
      // orphaned at its old position until the next real mouse movement
      // finally produces a leave/enter pair, sometimes surfacing a
      // neighboring tooltip in its place. Dismissing on pointerdown, before
      // the click handler gets a chance to touch the DOM, sidesteps this
      // outright instead of chasing it through every list that reorders or
      // shrinks on click.
      onPointerDown={hide}
      // Keyboard focus only, gpui-kit's rule: a click also focuses its
      // button, and the pointerdown dismissal above would otherwise be
      // undone 400ms later by that same click's focus.
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches(':focus-visible')) scheduleShow()
      }}
      onBlur={hide}
    >
      {children}
      <TooltipBubble
        open={mounted}
        anchorRef={wrapRef}
        label={label}
        placement={placement}
        monospace={monospace}
        shortcut={shortcut}
      />
    </span>
  )
}
