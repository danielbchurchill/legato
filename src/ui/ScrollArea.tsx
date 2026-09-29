import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'

/* An overlay scrollbar — a hand port of gpui-kit's Scrollbar (crates/base/
 * src/scrollbar.rs) in its default Scrolling mode. The native bar is hidden
 * on this viewport (.scrollbar-none, index.css) and a thumb is drawn over
 * the content instead, so the scrollbar takes no width from a 300px panel
 * and isn't there at all until the content moves.
 *
 * gpui-kit's geometry: a 6px thumb inset 4px from the edge, widening to 8px
 * under the pointer or while dragged, never shorter than 48px, square-
 * ended (THUMB_RADIUS is zero there). --color-control, lifted to
 * --color-muted-hi while hovered or dragged. It appears on scroll, stays
 * while the pointer is over its rail, and fades out on --motion-base two
 * seconds after the last activity — gpui-kit's DEFAULT_IDLE.
 *
 * Dragging the thumb scrolls proportionally with the pointer captured; a
 * press on the bare rail pages toward it. Wheel, touch and keyboard scrolling
 * are the viewport's own, untouched — this only draws and drags.
 *
 * Vertical only: every scroller this wraps pins overflow-x hidden on
 * purpose (issue #86 — see InspectorPanel.tsx), so there is never a
 * horizontal bar to draw. */

const THUMB_INSET = 4
const MIN_THUMB = 48
const IDLE_MS = 2000

type ScrollAreaProps = {
  children: ReactNode
  /** Sizing for the outer box — typically `min-h-0 flex-1`. */
  className?: string
  /** Padding and layout for the scrolled content itself. */
  contentClassName?: string
  /** The element that actually scrolls, for a caller that needs it (a
   * virtualizer's scroll element, scroll-to-top on navigation). */
  viewportRef?: Ref<HTMLDivElement>
}

export function ScrollArea({ children, className = '', contentClassName = '', viewportRef }: ScrollAreaProps) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ thumbTop: 0, thumbHeight: 0, scrollable: false })
  const [visible, setVisible] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef({ startY: 0, startScroll: 0 })

  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewport.current = el
      if (typeof viewportRef === 'function') viewportRef(el)
      else if (viewportRef) viewportRef.current = el
    },
    [viewportRef],
  )

  const measure = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const scrollable = scrollHeight > clientHeight + 1
    const track = clientHeight - THUMB_INSET * 2
    const thumbHeight = scrollable ? Math.max(MIN_THUMB, (clientHeight / scrollHeight) * track) : 0
    const maxScroll = scrollHeight - clientHeight
    const thumbTop = THUMB_INSET + (maxScroll > 0 ? (scrollTop / maxScroll) * (track - thumbHeight) : 0)
    setMetrics({ thumbTop, thumbHeight, scrollable })
  }, [])

  const reveal = useCallback(() => {
    setVisible(true)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(() => setVisible(false), IDLE_MS)
  }, [])

  useLayoutEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (viewport.current) observer.observe(viewport.current)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [measure])

  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current)
    },
    [],
  )

  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !viewport.current) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startScroll: viewport.current.scrollTop }
    setDragging(true)
  }

  const onThumbPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = viewport.current
    if (!dragging || !el) return
    const track = el.clientHeight - THUMB_INSET * 2 - metrics.thumbHeight
    const maxScroll = el.scrollHeight - el.clientHeight
    if (track <= 0) return
    el.scrollTop = drag.current.startScroll + ((e.clientY - drag.current.startY) / track) * maxScroll
  }

  const onThumbPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    reveal()
  }

  const onRailPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = viewport.current
    if (e.button !== 0 || !el) return
    const railTop = e.currentTarget.getBoundingClientRect().top
    const above = e.clientY - railTop < metrics.thumbTop
    el.scrollBy({ top: (above ? -1 : 1) * el.clientHeight * 0.9 })
  }

  const active = hovered || dragging
  const shown = metrics.scrollable && (visible || active)

  return (
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      <div
        ref={setViewport}
        onScroll={() => {
          measure()
          reveal()
        }}
        className="scrollbar-none min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div ref={content} className={contentClassName}>
          {children}
        </div>
      </div>
      {metrics.scrollable && (
        <div
          aria-hidden="true"
          onPointerEnter={() => {
            setHovered(true)
            setVisible(true)
          }}
          onPointerLeave={() => {
            setHovered(false)
            reveal()
          }}
          onPointerDown={onRailPointerDown}
          className="absolute top-0 right-0 bottom-0 w-[16px] transition-opacity duration-[var(--motion-base)] ease-[var(--ease-out)]"
          style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}
        >
          <div
            onPointerDown={onThumbPointerDown}
            onPointerMove={onThumbPointerMove}
            onPointerUp={onThumbPointerUp}
            onPointerCancel={onThumbPointerUp}
            className={`absolute right-[4px] transition-[width,background-color] duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
              active ? 'w-[8px] bg-[var(--color-muted-hi)]' : 'w-[6px] bg-[var(--color-control)]'
            }`}
            style={{ top: `${metrics.thumbTop}px`, height: `${metrics.thumbHeight}px` }}
          />
        </div>
      )}
    </div>
  )
}
