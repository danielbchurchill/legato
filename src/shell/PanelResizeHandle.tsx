import { useRef } from 'react'

/* A drag handle on a floating panel's own inner edge — the collection
 * panel's right edge, the now-playing panel's left edge — distinct from
 * ResizeHandles.tsx, which grabs the frameless *window's* outer edges via a
 * native OS resize. This one is a plain pointer drag updating React state,
 * since the panel isn't a real window.
 *
 * Reports every intermediate width live (so the panel visibly tracks the
 * drag) and a final width once on release (so App.tsx only persists to
 * settings once per drag, not once per pixel moved). */

type PanelResizeHandleProps = {
  /** Which edge of its own panel this sits on — determines which direction
   * of pointer travel grows the panel. */
  side: 'left' | 'right'
  widthPx: number
  minPx: number
  maxPx: number
  onChange: (widthPx: number) => void
  onCommit: (widthPx: number) => void
}

export function PanelResizeHandle({ side, widthPx, minPx, maxPx, onChange, onCommit }: PanelResizeHandleProps) {
  // Read inside the window listeners below rather than closed over at drag
  // start: minPx/maxPx track the window's own width live (P-8), and a drag
  // held open across a window resize should clamp against the current
  // bound, not the one that was true when the pointer went down.
  const boundsRef = useRef({ minPx, maxPx })
  boundsRef.current = { minPx, maxPx }

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthPx

    const resolve = (clientX: number): number => {
      const delta = clientX - startX
      // Dragging the left panel's right edge rightward grows it; dragging
      // the right panel's left edge leftward grows it — opposite signs for
      // the same rightward pointer motion.
      const signedDelta = side === 'left' ? delta : -delta
      const { minPx: min, maxPx: max } = boundsRef.current
      return Math.min(max, Math.max(min, startWidth + signedDelta))
    }

    const onMove = (moveEvent: PointerEvent) => onChange(resolve(moveEvent.clientX))
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      onCommit(resolve(upEvent.clientX))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize collection panel' : 'Resize now-playing panel'}
      className={`absolute top-0 bottom-0 z-10 w-[9px] cursor-ew-resize ${side === 'left' ? 'right-[-5px]' : 'left-[-5px]'}`}
    />
  )
}
