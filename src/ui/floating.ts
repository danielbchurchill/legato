import { useLayoutEffect, useState, type RefObject } from 'react'

/* Anchored positioning for everything that floats off a trigger — Tooltip,
 * Popover, Select/Combobox's listbox, the slider's value bubble. Factored
 * out of Tooltip.tsx, which had the only copy, once four components needed
 * it (the gpui-kit port — gpui-kit's own Positioner, base/src/positioner.rs,
 * is likewise one shared piece every popup routes through).
 *
 * Every floating box is portaled to document.body and positioned in fixed
 * viewport coordinates: no ancestor stacking context or overflow clip can
 * reach it (the Inspector Panel's overflow-x-hidden is load-bearing, see
 * InspectorPanel.tsx, and would crop anything rendered inside it). The
 * preferred side flips to the opposite one when it doesn't fit — gpui-kit's
 * behaviour, and the reason a tooltip on the rail's bottom icon now opens
 * upward instead of being clamped over its own trigger — and the cross axis
 * is clamped EDGE_MARGIN inside the viewport either way.
 *
 * Re-measured on any scroll (capture phase, so a scrolling panel counts),
 * on resize, and whenever the floating box itself changes size — a Select
 * list filtering down, a slider bubble's text growing a digit. */

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

const EDGE_MARGIN = 8

const OPPOSITE: Record<Placement, Placement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

export type FloatingPosition = { top: number; left: number; placement: Placement; anchorWidth: number }

function fits(side: Placement, anchor: DOMRect, box: DOMRect, gap: number): boolean {
  switch (side) {
    case 'top':
      return anchor.top - gap - box.height >= EDGE_MARGIN
    case 'bottom':
      return anchor.bottom + gap + box.height <= window.innerHeight - EDGE_MARGIN
    case 'left':
      return anchor.left - gap - box.width >= EDGE_MARGIN
    case 'right':
      return anchor.right + gap + box.width <= window.innerWidth - EDGE_MARGIN
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function alignOn(start: number, size: number, boxSize: number, align: Align): number {
  if (align === 'start') return start
  if (align === 'end') return start + size - boxSize
  return start + size / 2 - boxSize / 2
}

export function computePosition(
  anchor: DOMRect,
  box: DOMRect,
  preferred: Placement,
  align: Align,
  gap: number,
): FloatingPosition {
  const placement = fits(preferred, anchor, box, gap) || !fits(OPPOSITE[preferred], anchor, box, gap)
    ? preferred
    : OPPOSITE[preferred]

  let top: number
  let left: number
  if (placement === 'top' || placement === 'bottom') {
    top = placement === 'top' ? anchor.top - gap - box.height : anchor.bottom + gap
    left = alignOn(anchor.left, anchor.width, box.width, align)
  } else {
    left = placement === 'left' ? anchor.left - gap - box.width : anchor.right + gap
    top = alignOn(anchor.top, anchor.height, box.height, align)
  }

  return {
    top: clamp(top, EDGE_MARGIN, window.innerHeight - EDGE_MARGIN - box.height),
    left: clamp(left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - box.width),
    placement,
    anchorWidth: anchor.width,
  }
}

export function useAnchoredPosition({
  open,
  anchorRef,
  floatingRef,
  placement = 'bottom',
  align = 'center',
  gap = 6,
  deps = [],
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  floatingRef: RefObject<HTMLElement | null>
  placement?: Placement
  align?: Align
  gap?: number
  /** Anything else that moves the anchor without a scroll or resize — a
   * slider thumb following its value. */
  deps?: readonly unknown[]
}): FloatingPosition {
  const [position, setPosition] = useState<FloatingPosition>({ top: 0, left: 0, placement, anchorWidth: 0 })

  // useLayoutEffect so the first measured position lands before paint — a
  // useEffect would show one frame at 0,0 in the window's corner.
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const box = floatingRef.current
    if (anchor == null || box == null) return

    const measure = () => {
      setPosition(computePosition(anchor.getBoundingClientRect(), box.getBoundingClientRect(), placement, align, gap))
    }

    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(box)
    resizeObserver.observe(anchor)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own extra trigger list
  }, [open, placement, align, gap, anchorRef, floatingRef, ...deps])

  return position
}

/* The CSS translate a popup starts from before it settles into place —
 * gpui-kit's enter motion slides a popup --distance-short out of its
 * trigger, so the offset points back toward the anchor. */
export function enterOffset(placement: Placement): string {
  switch (placement) {
    case 'top':
      return 'translateY(var(--distance-short))'
    case 'bottom':
      return 'translateY(calc(var(--distance-short) * -1))'
    case 'left':
      return 'translateX(var(--distance-short))'
    case 'right':
      return 'translateX(calc(var(--distance-short) * -1))'
  }
}
