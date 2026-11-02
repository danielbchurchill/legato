import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { usePrefersReducedMotion } from '../ui/usePrefersReducedMotion'

/* How synced lyrics follow the song (#445), on the desktop's lyrics tab and
 * the phone's Now playing alike. The sung line is held at a reading
 * position, its middle a third of the way down the visible lyrics: clear of
 * the phone's fades, with what's coming next below it. A trailing space
 * two thirds of the scroller tall lets the last lines get there too.
 *
 * Someone who scrolls away to read ahead (or back) isn't pulled back: the
 * follow waits until they've scrolled the sung line back near its place, or
 * until RESUME_MS has passed since they last scrolled, then picks it up
 * again. Each new line glides there, or jumps under reduced motion. Opening
 * the lyrics, a new track's lyrics and a resized scroller place it at once. */

/** Where the sung line sits, as a fraction of the visible lyrics' height. */
export const READING_POSITION = 1 / 3

/** How long after the reader's last scroll the follow picks up again. */
export const RESUME_MS = 4000

/** A scroll that has stopped this long is finished, and is checked for
 * having come back to the sung line. */
const SETTLE_MS = 150

/** Back within this fraction of the scroller's height of the reading
 * position counts as back at the sung line. */
const NEAR_FRACTION = 0.15

/** How long a smooth scroll of the follow's own is given to arrive; its
 * scroll events before then aren't the reader's. */
const GLIDE_MS = 1000

/** The scrollTop that puts a line's middle at the reading position, as far
 * as the scroller can go. `lineTop` is measured from the top of the
 * scrolled content. */
export function readingScrollTop(lineTop: number, lineHeight: number, viewportHeight: number, scrollHeight: number): number {
  const top = lineTop + lineHeight / 2 - viewportHeight * READING_POSITION
  return Math.round(Math.max(0, Math.min(top, scrollHeight - viewportHeight)))
}

/** The scrollTop that puts `sung` at the reading position in `el`; the top
 * before the first line. */
function targetTop(el: HTMLElement, sung: HTMLElement | null): number {
  if (!sung) return 0
  const lineTop = sung.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  return readingScrollTop(lineTop, sung.offsetHeight, el.clientHeight, el.scrollHeight)
}

/** The follow's own scroll in flight: scroll events between `from` and
 * `to`, until `until`, are its own rather than the reader's. */
type OwnScroll = { from: number; to: number; until: number }

type Follow = {
  /** The element that scrolls the lyrics. */
  scroller: RefObject<HTMLElement | null>
  /** The sung line's element, null before the first line. */
  line: RefObject<HTMLElement | null>
  /** The sung line's index, -1 before the first. */
  current: number
  /** The synced lines, or null when there's nothing to follow (no lyrics
   * yet, or unsynced ones). A new value is a new song's lyrics. */
  lines: unknown
}

/** Follows the sung line; returns how tall the space after the last line
 * has to be. */
export function useLyricsFollow({ scroller, line, current, lines }: Follow): { tail: number } {
  const enabled = lines != null
  const reduced = usePrefersReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const [height, setHeight] = useState(0)

  // True while the reader has the lyrics somewhere else.
  const away = useRef(false)
  const ours = useRef<OwnScroll | null>(null)
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Read when it runs, from the effects below: the elements are the ones
  // on screen then, so nothing here is memoized on them.
  const follow = (glide: boolean) => {
    const el = scroller.current
    if (!el) return
    const to = targetTop(el, line.current)
    const from = el.scrollTop
    if (Math.abs(to - from) < 1) return
    const smooth = glide && !reducedRef.current
    // Said before scrolling: a scroll event can come before scrollTo returns.
    ours.current = { from, to, until: performance.now() + (smooth ? GLIDE_MS : 100) }
    el.scrollTo({ top: to, behavior: smooth ? 'smooth' : 'auto' })
  }
  const followRef = useRef(follow)
  followRef.current = follow

  // The scroller's height sets the reading position and the trailing space.
  // A ResizeObserver reports the size it starts with, so that's the first.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!enabled || !el) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, scroller])

  // The reader's own scrolling: anything that isn't the follow's.
  useEffect(() => {
    const el = scroller.current
    if (!enabled || !el) return

    const settle = () => {
      if (Math.abs(el.scrollTop - targetTop(el, line.current)) > el.clientHeight * NEAR_FRACTION) return
      away.current = false
      clearTimeout(resumeTimer.current)
    }
    const resume = () => {
      away.current = false
      followRef.current(true)
    }
    const onScroll = () => {
      const o = ours.current
      if (o) {
        const top = el.scrollTop
        if (performance.now() < o.until && top >= Math.min(o.from, o.to) - 1 && top <= Math.max(o.from, o.to) + 1) {
          if (Math.abs(top - o.to) < 1) ours.current = null
          return
        }
        ours.current = null
      }
      away.current = true
      clearTimeout(resumeTimer.current)
      resumeTimer.current = setTimeout(resume, RESUME_MS)
      clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(settle, SETTLE_MS)
    }
    // A wheel, a touch, a press or a key from the reader takes over from a
    // glide still on its way, so what scrolls next is theirs. Heard on the
    // scroller's parent too, which holds the desktop's scrollbar thumb.
    const takeOver = () => {
      ours.current = null
    }
    const frame = el.parentElement ?? el
    const intents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    el.addEventListener('scroll', onScroll, { passive: true })
    for (const type of intents) frame.addEventListener(type, takeOver, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      for (const type of intents) frame.removeEventListener(type, takeOver)
      clearTimeout(resumeTimer.current)
      clearTimeout(settleTimer.current)
    }
  }, [enabled, scroller, line])

  // A new song's lyrics, or the lyrics just opened: straight to the sung
  // line, following again whatever the last song's reader was doing.
  useLayoutEffect(() => {
    if (!enabled) return
    away.current = false
    clearTimeout(resumeTimer.current)
    followRef.current(false)
  }, [enabled, lines])

  // A resized scroller moves the reading position.
  useLayoutEffect(() => {
    if (enabled && !away.current) followRef.current(false)
  }, [enabled, height])

  // Each new line.
  useEffect(() => {
    if (enabled && !away.current) followRef.current(true)
  }, [enabled, current])

  return { tail: Math.round(height * (1 - READING_POSITION)) }
}
