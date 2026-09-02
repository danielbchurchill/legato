import { useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* DESIGN.md Motion says "nothing animates on a loop" — decoration doesn't
 * get to compete for attention forever. This is the same class of exception
 * "A bounded exception: progress" already carves out for determinate/long
 * indeterminate progress: a loop that exists to make otherwise-invisible
 * content visible isn't a mood, it's the only way the rest of a `truncate`d
 * title is ever seen. See DESIGN.md's own sibling section for the three
 * things that keep it bounded (static until proven otherwise, one field at
 * a time, reduced motion turns it off) — this file is the implementation.
 *
 * Renders identically to today's `truncate` when the text fits: same
 * overflow-hidden/whitespace-nowrap/ellipsis, no measurement artifact, no
 * wrapper the caller has to account for beyond swapping `truncate` out of
 * its className. Only once the text is measurably wider than its container
 * does it switch to the hold/scroll/hold/scroll-back cycle below. */

type Phase = 'hold-start' | 'scroll-out' | 'hold-end' | 'scroll-back'

// A ticker's timing is reading pace, not a UI state change — tokens.css's
// --motion-* table tops out at 200ms (Disclosure, hover, pagination), and
// nothing in it means "pause long enough to read a word" or "cross N pixels
// at a legible speed". Local constants instead, same reasoning as
// Tooltip.tsx's own DWELL_MS.
const HOLD_START_MS = 1200 // let the truncated look register before anything moves
const HOLD_END_MS = 1000 // give the revealed tail a moment to actually be read
const REVEAL_PX_PER_MS = 40 / 1000 // ~40px/s: a comfortable reading pace
const REVEAL_MIN_MS = 1200
const REVEAL_MAX_MS = 9000
// DESIGN.md Motion: "leaving is faster than arriving — on the way out the
// user has already decided." Nobody is meant to read the text on its way
// back to the start, so the return leg runs over twice the speed.
const RETURN_PX_PER_MS = 90 / 1000
const RETURN_MIN_MS = 500
const RETURN_MAX_MS = 3500

// Sub-pixel layout rounding shouldn't be enough to trigger a scroll that
// moves nothing a viewer could ever perceive.
const MIN_OVERFLOW_PX = 1

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

type ScrollingTextProps = {
  text: string
  className?: string
}

export function ScrollingText({ text, className = '' }: ScrollingTextProps) {
  const containerRef = useRef<HTMLParagraphElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [distance, setDistance] = useState(0)
  const [phase, setPhase] = useState<Phase>('hold-start')
  const reducedMotion = usePrefersReducedMotion()

  // Re-measures whenever the text changes (a different node selected) and
  // whenever either box's own size changes (panel resize, a webfont
  // finishing its swap) — a plain mount-time measurement would miss both.
  useLayoutEffect(() => {
    const container = containerRef.current
    const span = textRef.current
    if (!container || !span) return

    const measure = () => {
      const overflow = Math.ceil(span.getBoundingClientRect().width - container.clientWidth)
      setDistance(overflow > MIN_OVERFLOW_PX ? overflow : 0)
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(span)
    return () => observer.disconnect()
  }, [text])

  const scrolling = distance > 0 && !reducedMotion
  const revealMs = clamp(distance / REVEAL_PX_PER_MS, REVEAL_MIN_MS, REVEAL_MAX_MS)
  const returnMs = clamp(distance / RETURN_PX_PER_MS, RETURN_MIN_MS, RETURN_MAX_MS)

  useLayoutEffect(() => {
    setPhase('hold-start')
    if (!scrolling) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const after = (ms: number, run: () => void) => {
      timers.push(
        setTimeout(() => {
          if (!cancelled) run()
        }, ms),
      )
    }

    // Recurses into itself at the end of scroll-back rather than using
    // setInterval — each leg's duration depends on the measured distance, so
    // the cycle can't be a single fixed-period timer.
    const loop = () => {
      after(HOLD_START_MS, () => {
        setPhase('scroll-out')
        after(revealMs, () => {
          setPhase('hold-end')
          after(HOLD_END_MS, () => {
            setPhase('scroll-back')
            after(returnMs, () => {
              setPhase('hold-start')
              loop()
            })
          })
        })
      })
    }
    loop()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [scrolling, revealMs, returnMs])

  const offsetX = phase === 'scroll-out' || phase === 'hold-end' ? -distance : 0
  const transitionMs = phase === 'scroll-out' ? revealMs : phase === 'scroll-back' ? returnMs : 0

  return (
    <p
      ref={containerRef}
      className={`${className} overflow-hidden whitespace-nowrap ${scrolling ? '' : 'text-ellipsis'}`}
    >
      <span
        ref={textRef}
        // display: inline (a bare <span>) can't take a transform at all —
        // this has to be a box of its own for translateX to do anything.
        className="inline-block"
        style={
          scrolling
            ? {
                transform: `translateX(${offsetX}px)`,
                transitionProperty: 'transform',
                transitionDuration: `${transitionMs}ms`,
                transitionTimingFunction: 'linear',
                willChange: 'transform',
              }
            : undefined
        }
      >
        {text}
      </span>
    </p>
  )
}
