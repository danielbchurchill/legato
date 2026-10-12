import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatDuration } from '../ui/format'
import { SEEK_STEP_MS, scrubberTimes, seekFraction, seekPosition } from './scrubberMath'

/* The phone's scrubber (#389, Legato Mobile v2 screens 6 and 7): a 4px track
 * filled with the accent gradient up to a 12px ink thumb, over mono elapsed
 * and remaining readouts, with whatever the caller puts between them (Now
 * playing's stream quality).
 *
 * The track is 4px but its target is 44px tall, 20px either side, so a
 * finger finds it. Pressing anywhere on it jumps the thumb there and keeps
 * dragging; the readouts follow the finger, and the seek lands on release,
 * as the desktop's waveform does: seeking on every move would restart the
 * stream dozens of times. The press doesn't reach the sheet behind, so a
 * scrub never drags the sheet.
 *
 * Live data, so the fill and thumb step rather than ease (DESIGN.md
 * "Never animate live data"). It isn't the ui Slider: that's a quantity in
 * ink, with a tooltip for its value; this is progress in the accent, with
 * its value written under it. */

type ScrubberProps = {
  positionMs: number
  durationMs: number | null
  onSeek: (positionMs: number) => void
  /** Between elapsed and remaining. */
  middle?: ReactNode
  className?: string
}

export function Scrubber({ positionMs, durationMs, onSeek, middle, className = '' }: ScrubberProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragMs, setDragMs] = useState<number | null>(null)
  const length = durationMs != null && durationMs > 0 ? durationMs : null
  const seekable = length != null

  const shownMs = dragMs ?? positionMs
  const fraction = length != null ? Math.min(1, Math.max(0, shownMs / length)) : 0
  const times = scrubberTimes(shownMs, durationMs)

  const msAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect()
    return seekPosition(seekFraction(clientX, rect.left, rect.width), length ?? 0)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The sheet's header drags on a press anywhere in it; a scrub isn't one.
    e.stopPropagation()
    if (!seekable || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragMs(msAt(e.clientX))
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return
    setDragMs(msAt(e.clientX))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return
    onSeek(msAt(e.clientX))
    setDragMs(null)
  }

  return (
    <div className={className}>
      <div
        ref={ref}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={durationMs ?? 0}
        aria-valuenow={positionMs}
        aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(durationMs)}`}
        aria-disabled={!seekable || undefined}
        tabIndex={seekable ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragMs(null)}
        onKeyDown={(e) => {
          if (length == null) return
          if (e.key === 'ArrowRight') onSeek(Math.min(length, positionMs + SEEK_STEP_MS))
          else if (e.key === 'ArrowLeft') onSeek(Math.max(0, positionMs - SEEK_STEP_MS))
          else return
          e.preventDefault()
        }}
        className={`relative -my-[20px] h-[44px] touch-none select-none ${seekable ? 'cursor-pointer' : ''}`}
      >
        <div className="absolute inset-x-0 top-[20px] h-[4px] rounded-[2px] bg-[var(--color-wash-2)]">
          <div className="h-full rounded-[2px] bg-[image:var(--accent-fill)]" style={{ width: `${fraction * 100}%` }} />
        </div>
        {seekable && (
          <span
            aria-hidden="true"
            className="absolute top-[16px] -ml-[6px] size-[12px] rounded-full bg-[var(--color-ink)]"
            style={{ left: `${fraction * 100}%` }}
          />
        )}
      </div>
      <div className="mono mt-[8px] flex items-center justify-between gap-[12px] text-mono text-[var(--color-ink-2)]">
        <span>{times.elapsed}</span>
        {middle != null && <span className="min-w-0 truncate">{middle}</span>}
        <span>{times.remaining}</span>
      </div>
    </div>
  )
}
