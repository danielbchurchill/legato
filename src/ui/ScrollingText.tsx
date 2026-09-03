import { useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* DESIGN.md Motion says "nothing animates on a loop" — decoration doesn't
 * get to compete for attention forever. This is the same class of exception
 * "A bounded exception: progress" already carves out for determinate/long
 * indeterminate progress: a loop that exists to make otherwise-invisible
 * content visible isn't a mood, it's the only way the rest of a `truncate`d
 * title is ever seen. See DESIGN.md's own sibling section for what keeps it
 * bounded — this file is the implementation.
 *
 * Hover-gated (issue #31): the cycle only runs while the pointer (or focus)
 * is actually on this field, snapping straight back to the start the moment
 * it leaves, rather than looping from the instant the component mounts.
 * That's also what let this stop being reserved for a single prominent
 * field — DESIGN.md's older "one field, not a wall of them" guidance was
 * protecting against every row in a list animating at once on a shared
 * timer; gating on hover makes that structurally impossible; at most one
 * row can be hovered at a time, so it's now wired into list rows too.
 *
 * Renders identically to today's `truncate` when the text fits, or when it
 * isn't currently hovered: same overflow-hidden/whitespace-nowrap/ellipsis,
 * no measurement artifact, no wrapper the caller has to account for beyond
 * swapping `truncate` out of its className. Only once the text is measurably
 * wider than its container AND hovered does it switch to the
 * hold/scroll/hold/scroll-back cycle below. */

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
  const [hovered, setHovered] = useState(false)
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

  // canScroll: the text is long enough to need this at all. active: it's
  // actually cycling right now — gated on hover (or focus, for the same
  // reason Tooltip.tsx watches both) so the marquee is a response to
  // attention on this one field rather than a loop running the moment it
  // mounts. This is what lets DESIGN.md's "one field, not a wall of them"
  // now extend to list rows too: nothing animates unless a pointer is
  // actually over it, so there is never more than one field scrolling at
  // once no matter how many rows on screen could.
  const canScroll = distance > 0 && !reducedMotion
  const active = canScroll && hovered
  const revealMs = clamp(distance / REVEAL_PX_PER_MS, REVEAL_MIN_MS, REVEAL_MAX_MS)
  const returnMs = clamp(distance / RETURN_PX_PER_MS, RETURN_MIN_MS, RETURN_MAX_MS)

  useLayoutEffect(() => {
    // Runs on every dependency change, hover end included — which is what
    // snaps the phase (and so the transform) straight back to the start
    // the instant hover ends, rather than finishing whatever leg of the
    // cycle was in flight.
    setPhase('hold-start')
    if (!active) return

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
    // the cycle can't be a single fixed-period timer. Keeps recursing for as
    // long as `active` stays true, i.e. for as long as the pointer stays
    // over this field.
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
  }, [active, revealMs, returnMs])

  const offsetX = phase === 'scroll-out' || phase === 'hold-end' ? -distance : 0
  const transitionMs = phase === 'scroll-out' ? revealMs : phase === 'scroll-back' ? returnMs : 0

  // 'hold-start' is the phase whenever nothing is actively sliding — before
  // the first hover, between hovers, and during the beat at the start of
  // each cycle before motion actually begins (`active` flips true the
  // instant hover starts, well before `phase` leaves 'hold-start'). Keying
  // the ellipsis/inline-block switch off `phase` rather than `active` is
  // what makes that beat actually look static: text-overflow:ellipsis can
  // only ellipsize plain inline content, never an atomic inline-block box
  // (needed once translateX has to move it), so the two states can't share
  // one rendering — swap back to plain inline text the instant the cycle
  // returns to 'hold-start', not only once hover fully ends.
  const settled = phase === 'hold-start'

  return (
    <p
      ref={containerRef}
      className={`${className} overflow-hidden whitespace-nowrap ${settled ? 'text-ellipsis' : ''}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <span
        ref={textRef}
        // display: inline (a bare <span>) can't take a transform at all —
        // this has to be a box of its own for translateX to do anything.
        // Only switched on while actually sliding: an inline-block span is
        // an atomic box as far as text-overflow is concerned, so keeping it
        // inline-block at rest would keep the ellipsis from ever rendering.
        className={settled ? undefined : 'inline-block'}
        style={
          settled
            ? undefined
            : {
                transform: `translateX(${offsetX}px)`,
                transitionProperty: 'transform',
                transitionDuration: `${transitionMs}ms`,
                transitionTimingFunction: 'linear',
                willChange: 'transform',
              }
        }
      >
        {text}
      </span>
    </p>
  )
}
