import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { usePrefersReducedMotion } from '../ui/usePrefersReducedMotion'
import { useSafeArea } from './safeArea'
import {
  DRAG_SLOP,
  VELOCITY_WINDOW_MS,
  contentDragMovesSheet,
  detentHeights,
  largeProgress,
  nextDetent,
  peekProgress,
  releaseVelocity,
  rubberBand,
  snapDetent,
  type Detent,
  type DetentHeights,
  type Sample,
} from './sheetGeometry'

/* The phone's bottom sheet (#389, Legato Mobile v2 "The sheet"): one glass
 * sheet over the map that everything but the map lives in. Later steps put
 * node detail, the library and up next in it, so it knows nothing about
 * what it holds.
 *
 * Three detents. Peek is the header and the peek line, as tall as they are,
 * over the home indicator. Medium puts the sheet's top 40% of the way down
 * the screen. Large leaves a 64px strip of map under the status bar, and
 * the map behind dims. The caller owns the detent; a drag or the handle
 * asks for a new one through onDetentChange.
 *
 * An overlay (search's results, a node's detail) covers the content in its
 * place, with a scroll of its own, while the content stays mounted under it
 * out of reach: back from the overlay finds the tab where it was left.
 *
 * The header, under the handle, always drags the sheet. The content drags
 * it as a native sheet's does: up until the sheet is large, then the
 * content scrolls; down once the content is back at its top. So scrolling
 * at large never fights the drag. A release lands on the nearest detent,
 * carried on by its speed, and a flick goes on to the next one.
 *
 * Positions are written straight to the DOM while a finger moves, so a drag
 * doesn't re-render whatever the sheet holds. Settling uses the spring
 * (--ease-spring); under reduced motion it snaps. The sheet is laid out at
 * its large height and slid down, so its content never reflows as it
 * moves. */

const DETENT_NAME: Record<Detent, string> = { peek: 'collapsed', medium: 'half height', large: 'full height' }

type SheetProps = {
  /** The sheet's accessible name; the handle is named after it. */
  label: string
  detent: Detent
  /** A drag asks with the element it started on, so where it began can
   * decide where it goes: the mini player dragged up opens up next. */
  onDetentChange: (detent: Detent, origin?: Element | null) => void
  /** Under the handle, and always on screen: the part that drags. */
  header: ReactNode
  /** Under the header at peek only, in place of the content. */
  peek?: ReactNode
  /** The content, mounted the first time the sheet leaves peek. It scrolls
   * inside the sheet; a child with a scroller of its own works too. */
  children: ReactNode
  /** Drawn over the content, in its place, scrolling on its own. */
  overlay?: ReactNode
  /** Names what the overlay shows: a new one starts at its top. */
  overlayKey?: string
  /** How much map large leaves under the status bar: 64px, or search's 70. */
  largeTopGap?: number
  /** Whether the map dims behind the sheet at large. Search's results
   * don't: the handoff draws the map under its field as it is. */
  dim?: boolean
  /** Live, as the sheet moves: 0 at medium or lower, 1 at large, the dim's
   * own progress. `animate` says whether the sheet is springing there or
   * following a finger. */
  onExpansion?: (progress: number, animate: boolean) => void
  /** Each detent's height, whenever they change. */
  onHeightsChange?: (heights: DetentHeights) => void
  /** A background over the glass from the sheet's top edge, under
   * everything in it: up next's cover-colour wash. */
  wash?: string
}

type Drag = {
  source: 'pointer' | 'touch'
  id: number
  /** What the drag started on. */
  origin: Element | null
  startX: number
  startY: number
  startHeight: number
  samples: Sample[]
  /** The drag is moving the sheet. */
  active: boolean
}

/* What a drag started on. The handle's 44px target lies over the top of the
 * header, the mini player's included, so a drag that starts on the handle
 * started on whatever it covers. */
function dragOrigin(target: EventTarget | null, x: number, y: number, handle: HTMLElement | null): Element | null {
  const el = target instanceof Element ? target : null
  if (!el || !handle?.contains(el) || typeof document.elementsFromPoint !== 'function') return el
  return document.elementsFromPoint(x, y).find((under) => !handle.contains(under)) ?? null
}

/* Whether everything between a touch and the content's root is scrolled to
 * its top, so a drag down there has nothing left to scroll. */
function scrolledToTop(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && root.contains(el); el = el.parentElement) {
    if (el.scrollTop > 0) return false
    if (el === root) break
  }
  return true
}

export function Sheet({
  label,
  detent,
  onDetentChange,
  header,
  peek,
  children,
  overlay,
  overlayKey,
  largeTopGap,
  dim = true,
  onExpansion,
  onHeightsChange,
  wash,
}: SheetProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLButtonElement>(null)
  const peekRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dimRef = useRef<HTMLDivElement>(null)

  const safe = useSafeArea()
  const reduced = usePrefersReducedMotion()
  const [viewportHeight, setViewportHeight] = useState(0)
  const [peekContent, setPeekContent] = useState(0)
  const heights = useMemo(
    () => detentHeights({ viewportHeight, safeTop: safe.top, safeBottom: safe.bottom, peekContent, largeTopGap }),
    [viewportHeight, safe.top, safe.bottom, peekContent, largeTopGap],
  )

  // The content waits for the first time it could be seen.
  const [opened, setOpened] = useState(detent !== 'peek')
  if (detent !== 'peek' && !opened) setOpened(true)

  // What the gesture handlers read, so they can stay the same functions.
  const dragRef = useRef<Drag | null>(null)
  const heightRef = useRef(0)
  const heightsRef = useRef(heights)
  heightsRef.current = heights
  const detentRef = useRef(detent)
  detentRef.current = detent
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const onDetentChangeRef = useRef(onDetentChange)
  onDetentChangeRef.current = onDetentChange
  const onExpansionRef = useRef(onExpansion)
  onExpansionRef.current = onExpansion
  const dimsRef = useRef(dim)
  dimsRef.current = dim

  const apply = useCallback((height: number, animate: boolean) => {
    const sheet = sheetRef.current
    if (!sheet) return
    const hs = heightsRef.current
    heightRef.current = height
    const expansion = largeProgress(height, hs)
    const opened = peekProgress(height, hs)
    const transition = (property: string) => (animate ? `${property} var(--motion-spring) var(--ease-spring)` : 'none')
    sheet.style.transition = transition('transform')
    sheet.style.transform = `translate3d(0, ${hs.large - height}px, 0)`
    for (const [el, opacity] of [
      [dimRef.current, dimsRef.current ? expansion : 0],
      [peekRef.current, 1 - opened],
      [bodyRef.current, opened],
      [overlayRef.current, opened],
    ] as const) {
      if (!el) continue
      el.style.transition = transition('opacity')
      el.style.opacity = String(opacity)
    }
    onExpansionRef.current?.(expansion, animate)
  }, [])

  // The viewport, and what peek has to show. Peek is measured at peek or
  // medium, where the header is the height it is at peek, so a header that
  // changes at medium (a node's detail in place of the player) brings peek
  // with it. Not at large: the player's header is shorter there.
  useLayoutEffect(() => {
    const stage = stageRef.current
    const head = headerRef.current
    if (!stage || !head) return
    const measure = () => {
      setViewportHeight(stage.clientHeight)
      if (detentRef.current !== 'large' && !dragRef.current?.active) {
        setPeekContent(head.offsetHeight + (peekRef.current?.offsetHeight ?? 0))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    observer.observe(head)
    if (peekRef.current) observer.observe(peekRef.current)
    return () => observer.disconnect()
  }, [detent])

  // Settle on the detent, springing there once the sheet has been placed.
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (dragRef.current?.active || heights.large <= 0) return
    apply(heights[detent], placed.current && !reduced)
    placed.current = true
  }, [detent, heights, reduced, apply])

  useEffect(() => {
    onHeightsChange?.(heights)
  }, [heights, onHeightsChange])

  const begin = useCallback((drag: Drag, y: number, t: number) => {
    drag.active = true
    // From where the drag was claimed, so the sheet doesn't jump the slop.
    drag.startY = y
    drag.startHeight = heightRef.current
    drag.samples = [{ y, t }]
    setOpened(true)
  }, [])

  const move = useCallback(
    (drag: Drag, y: number, t: number) => {
      apply(rubberBand(drag.startHeight + (drag.startY - y), heightsRef.current), false)
      drag.samples.push({ y, t })
      // Only the last stretch counts towards the release's speed.
      while (drag.samples.length > 2 && t - drag.samples[1].t > VELOCITY_WINDOW_MS) drag.samples.shift()
    },
    [apply],
  )

  const end = useCallback(
    (drag: Drag, t: number, cancelled: boolean) => {
      const hs = heightsRef.current
      const target = snapDetent(hs, heightRef.current, cancelled ? 0 : releaseVelocity(drag.samples, t))
      apply(hs[target], !reducedRef.current)
      if (target !== detentRef.current) onDetentChangeRef.current(target, drag.origin)
    },
    [apply],
  )

  // The header: pointer events, so a mouse drags it as well as a finger.
  // The pointer is captured only once it's a drag, so a tap on a button in
  // the header still lands on the button.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    dragRef.current = {
      source: 'pointer',
      id: e.pointerId,
      origin: dragOrigin(e.target, e.clientX, e.clientY, handleRef.current),
      startX: e.clientX,
      startY: e.clientY,
      startHeight: heightRef.current,
      samples: [],
      active: false,
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.source !== 'pointer' || drag.id !== e.pointerId) return
    if (!drag.active) {
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return
      if (Math.abs(dx) > Math.abs(dy)) {
        dragRef.current = null
        return
      }
      begin(drag, e.clientY, e.timeStamp)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    move(drag, e.clientY, e.timeStamp)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.source !== 'pointer' || drag.id !== e.pointerId) return
    dragRef.current = null
    if (drag.active) end(drag, e.timeStamp, e.type === 'pointercancel')
  }

  // The content: touch events, because a drag here has to be claimed before
  // the browser starts scrolling, and only a non-passive touchmove can
  // refuse a scroll. A mouse scrolls the content with its wheel.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        // A second finger is a pinch or a zoom, not a drag.
        if (dragRef.current?.source === 'touch') dragRef.current = null
        return
      }
      if (dragRef.current) return
      const touch = e.touches[0]
      dragRef.current = {
        source: 'touch',
        id: touch.identifier,
        origin: e.target instanceof Element ? e.target : null,
        startX: touch.clientX,
        startY: touch.clientY,
        startHeight: heightRef.current,
        samples: [],
        active: false,
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      const drag = dragRef.current
      if (!drag || drag.source !== 'touch') return
      const touch = [...e.touches].find((t) => t.identifier === drag.id)
      if (!touch) return
      if (!drag.active) {
        const dx = touch.clientX - drag.startX
        const dy = touch.clientY - drag.startY
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return
        const movesSheet =
          Math.abs(dy) > Math.abs(dx) &&
          contentDragMovesSheet({ detent: detentRef.current, dy, scrolledToTop: scrolledToTop(e.target, content) })
        if (!movesSheet) {
          // The content's: let it scroll, for the rest of this touch.
          dragRef.current = null
          return
        }
        begin(drag, touch.clientY, e.timeStamp)
      }
      if (e.cancelable) e.preventDefault()
      move(drag, touch.clientY, e.timeStamp)
    }
    const onTouchEnd = (e: TouchEvent) => {
      const drag = dragRef.current
      if (!drag || drag.source !== 'touch') return
      dragRef.current = null
      if (drag.active) end(drag, e.timeStamp, e.type === 'touchcancel')
    }
    content.addEventListener('touchstart', onTouchStart, { passive: true })
    content.addEventListener('touchmove', onTouchMove, { passive: false })
    content.addEventListener('touchend', onTouchEnd)
    content.addEventListener('touchcancel', onTouchEnd)
    return () => {
      content.removeEventListener('touchstart', onTouchStart)
      content.removeEventListener('touchmove', onTouchMove)
      content.removeEventListener('touchend', onTouchEnd)
      content.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [begin, move, end])

  const atPeek = detent === 'peek'

  return (
    <div ref={stageRef} className="pointer-events-none absolute inset-0 z-20">
      {/* The handoff's dim at large, the same in both themes: it darkens
       * whatever map is behind. A tap on it goes back to the map. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        onClick={() => onDetentChange('peek')}
        className="absolute inset-0 bg-[rgb(0_0_0/0.18)]"
        style={{ opacity: 0, pointerEvents: detent === 'large' && dim ? 'auto' : 'none' }}
      />
      <section
        ref={sheetRef}
        aria-label={label}
        data-detent={detent}
        // Glass, with its top border only, as the handoff draws the sheet.
        // 28px corners: rounder than any panel, as a native sheet's are.
        className="glass pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col rounded-t-[28px]"
        style={{
          height: heights.large,
          borderLeftWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: 0,
          visibility: heights.large > 0 ? undefined : 'hidden',
        }}
      >
        {wash && <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-t-[28px]" style={{ background: wash }} />}
        <div
          ref={headerRef}
          className="relative shrink-0 touch-none pt-[23px] select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {/* The handle, 8px from the top. As a button it steps through the
           * detents, for a keyboard or a screen reader; its target is 44px
           * tall, over the top of the header. */}
          <button
            ref={handleRef}
            type="button"
            aria-label={`${label}, ${DETENT_NAME[detent]}`}
            onClick={() => onDetentChange(nextDetent(detent))}
            className="absolute top-0 left-1/2 z-[1] flex h-[44px] w-[88px] -translate-x-1/2 justify-center rounded-[12px] pt-[8px]"
          >
            <span aria-hidden="true" className="h-[5px] w-[36px] rounded-[3px] bg-[var(--color-line-strong)]" />
          </button>
          {header}
        </div>
        <div ref={contentRef} className="relative min-h-0 flex-1">
          {peek != null && (
            <div
              ref={peekRef}
              aria-hidden={!atPeek}
              className="absolute inset-x-0 top-0"
              style={{ pointerEvents: atPeek ? undefined : 'none' }}
            >
              {peek}
            </div>
          )}
          <div
            ref={bodyRef}
            inert={atPeek || overlay != null}
            className="absolute inset-0 overflow-y-auto overscroll-contain"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)', opacity: 0, visibility: overlay != null ? 'hidden' : undefined }}
          >
            {opened && children}
          </div>
          {overlay != null && (
            <div
              key={overlayKey}
              ref={overlayRef}
              inert={atPeek}
              className="absolute inset-0 overflow-y-auto overscroll-contain"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)', opacity: atPeek ? 0 : 1 }}
            >
              {overlay}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
