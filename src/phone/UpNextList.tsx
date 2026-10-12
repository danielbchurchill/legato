import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { formatDuration, NO_VALUE, plural } from '../ui/format'
import { usePrefersReducedMotion } from '../ui/usePrefersReducedMotion'
import { useGraph } from '../canvas/graphContext'
import { Empty } from '../panels/NowPlaying'
import type { QueueEntry, usePlayback } from '../playback/usePlayback'
import {
  LONG_PRESS_MS,
  ROW_HEIGHT,
  SWIPE_ACTION_WIDTH,
  edgeScrollSpeed,
  holdBroken,
  moveEntry,
  reorderTarget,
  rowShift,
  swipeOffset,
  swipeRelease,
} from './queueGestures'
import { DRAG_SLOP, VELOCITY_WINDOW_MS, releaseVelocity, type Sample } from './sheetGeometry'

/* The phone's up next list (#389, Legato Mobile v2 screen 6): "Playing from
 * …" with clear, then the queue as 58px rows of a 44px cover, the title
 * over the artist, and the mono duration.
 *
 * It does what the desktop's up next does. A tap on a row plays it,
 * stepping forward to it. A row held still lifts and drags to a new place,
 * and a row swiped left shows "remove" (queueGestures.ts says why those
 * two). A screen reader or a keyboard has neither gesture, so every row
 * also carries move up, move down and remove buttons, out of sight until
 * one of them has the focus, when they show in place of the duration.
 *
 * Gestures are touch events on the list, not pointer events: a lift or a
 * swipe has to stop the browser scrolling, and the sheet behind deciding
 * it's a drag of the sheet, and only a non-passive touchmove can do that.
 * Rows move by transforms written straight to the DOM while a finger
 * moves, as the sheet does, so a drag doesn't re-render the list. An edit
 * shows at once, in the order it leaves the queue, until the queue itself
 * catches up (the desktop app's native queue answers a moment later). */

type Playback = ReturnType<typeof usePlayback>

type UpNextListProps = {
  playback: Playback
  /** "Playing from …"'s source, or null when the queue came from nowhere
   * in particular. */
  from: string | null
  onShuffleLibrary: () => void
}

/** A queue edit already made on screen, until playback.upNext changes. */
type Pending = { base: readonly QueueEntry[]; entries: readonly QueueEntry[] }

type Gesture = {
  /** The touch's identifier. */
  id: number
  index: number
  row: HTMLElement
  startX: number
  startY: number
  /** Waiting to see what the touch is; a row being dragged; a row being
   * swiped; or a touch that only closed a row swiped open. */
  kind: 'pending' | 'lift' | 'swipe' | 'consumed'
  timer: number
  // A lift.
  scroller: HTMLElement | null
  startScroll: number
  y: number
  target: number
  base: readonly QueueEntry[]
  // A swipe.
  startOffset: number
  offset: number
  samples: Sample[]
}

/* The nearest ancestor that scrolls: the sheet's content. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/* Rows keyed by track and how many times it has come up so far, so a row
 * keeps its element, and the focus, as it moves. */
function rowKeys(entries: readonly QueueEntry[]): string[] {
  const seen = new Map<number, number>()
  return entries.map((entry) => {
    const n = seen.get(entry.recordingNodeId) ?? 0
    seen.set(entry.recordingNodeId, n + 1)
    return `${entry.recordingNodeId}#${n}`
  })
}

export function UpNextList({ playback, from, onShuffleLibrary }: UpNextListProps) {
  const graph = useGraph()
  const reduced = usePrefersReducedMotion()
  const [pending, setPending] = useState<Pending | null>(null)
  const [lifted, setLifted] = useState<number | null>(null)
  // The row swiped open, in the queue it was opened in.
  const [swiped, setSwiped] = useState<{ index: number; base: readonly QueueEntry[] } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  const { upNext, queueBusy } = playback
  const entries = pending != null && pending.base === upNext ? pending.entries : upNext
  // A track ending moves every row up one, so a row left open closes
  // rather than show remove beside another track.
  const open = swiped != null && swiped.base === upNext ? swiped.index : null
  const listed = playback.currentTitle != null && entries.length > 0

  // What the touch handlers read, so they can stay the same functions.
  const state = useRef({ entries, upNext, busy: queueBusy, open, reduced, playback })
  state.current = { entries, upNext, busy: queueBusy, open, reduced, playback }

  const move = (index: number, to: number) => {
    const { entries, upNext, playback } = state.current
    if (to < 0 || to >= entries.length || to === index) return
    setPending({ base: upNext, entries: moveEntry(entries, index, to) })
    void playback.moveUpNext(index, to)
  }
  const remove = (index: number) => {
    const { entries, upNext, playback } = state.current
    setSwiped(null)
    setPending({ base: upNext, entries: entries.filter((_, i) => i !== index) })
    void playback.removeUpNext(index)
  }
  const handlers = useRef({ move, remove })
  handlers.current = { move, remove }

  // Whatever closed it, a row that isn't open slides back.
  useLayoutEffect(() => {
    if (open != null) return
    for (const face of listRef.current?.querySelectorAll<HTMLElement>('[data-swipe]') ?? []) face.style.transform = ''
  }, [open])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    let g: Gesture | null = null
    let frame = 0
    // A tap right after a gesture isn't a tap on the row under it.
    let swallowClicksUntil = 0

    const rows = () => [...list.querySelectorAll<HTMLElement>(':scope > li[data-index]')]
    const ease = () => (state.current.reduced ? 'none' : 'transform var(--motion-base) var(--ease-out)')

    const setSwipe = (row: HTMLElement, offset: number, animate: boolean) => {
      const face = row.querySelector<HTMLElement>('[data-swipe]')
      const action = row.querySelector<HTMLElement>('[data-swipe-action]')
      if (!face || !action) return
      face.style.transition = animate ? ease() : 'none'
      face.style.transform = offset > 0 ? `translate3d(${-offset}px, 0, 0)` : ''
      action.style.width = `${Math.max(SWIPE_ACTION_WIDTH, offset)}px`
    }
    const closeOpen = () => {
      const index = state.current.open
      if (index == null) return
      const row = list.querySelector<HTMLElement>(`:scope > li[data-index="${index}"]`)
      if (row) setSwipe(row, 0, true)
      setSwiped(null)
    }

    // The lifted row follows the finger, and the list's scroll; the rows
    // it passes slide out of its way.
    const layoutLift = () => {
      if (!g || g.kind !== 'lift') return
      const dy = g.y - g.startY + (g.scroller ? g.scroller.scrollTop - g.startScroll : 0)
      g.row.style.transform = `translate3d(0, ${dy}px, 0)`
      const target = reorderTarget(g.index, dy, state.current.entries.length)
      if (target === g.target) return
      g.target = target
      for (const row of rows()) {
        const index = Number(row.dataset.index)
        if (index === g.index) continue
        const shift = rowShift(index, g.index, target)
        row.style.transition = ease()
        row.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : ''
      }
    }
    const autoScroll = (time: number, last: number) => {
      if (!g || g.kind !== 'lift' || !g.scroller) return
      const rect = g.scroller.getBoundingClientRect()
      const speed = edgeScrollSpeed(g.y, rect.top, rect.bottom)
      if (speed !== 0) {
        g.scroller.scrollTop += speed * Math.min(32, time - last)
        layoutLift()
      }
      frame = requestAnimationFrame((next) => autoScroll(next, time))
    }

    const lift = () => {
      if (!g || g.kind !== 'pending') return
      g.kind = 'lift'
      g.scroller = scrollParent(list)
      g.startScroll = g.scroller?.scrollTop ?? 0
      g.base = state.current.upNext
      g.target = g.index
      g.row.style.transition = 'none'
      setLifted(g.index)
      frame = requestAnimationFrame((time) => autoScroll(time, time))
    }

    const settleRows = () => {
      for (const row of rows()) {
        row.style.transition = 'none'
        row.style.transform = ''
      }
    }

    const finish = (cancelled: boolean, time = performance.now()) => {
      if (!g) return
      const done = g
      g = null
      window.clearTimeout(done.timer)
      cancelAnimationFrame(frame)
      if (done.kind === 'lift') {
        settleRows()
        setLifted(null)
        // A track that ended mid-drag moved every row up one: the drop
        // would land somewhere else, so it doesn't.
        if (!cancelled && done.base === state.current.upNext) handlers.current.move(done.index, done.target)
      } else if (done.kind === 'swipe') {
        const width = done.row.getBoundingClientRect().width
        const velocity = releaseVelocity(done.samples, time)
        const end = cancelled ? (done.startOffset > 0 ? 'open' : 'closed') : swipeRelease({ offset: done.offset, velocity, width })
        if (end === 'remove') {
          setSwipe(done.row, 0, false)
          handlers.current.remove(done.index)
        } else {
          setSwipe(done.row, end === 'open' ? SWIPE_ACTION_WIDTH : 0, true)
          setSwiped(end === 'open' ? { index: done.index, base: state.current.upNext } : null)
        }
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        finish(true)
        return
      }
      if (g) return
      const target = e.target instanceof Element ? e.target : null
      const item = target?.closest<HTMLElement>('li[data-index]')
      const row = item?.parentElement === list ? item : null
      const index = row ? Number(row.dataset.index) : -1
      const touch = e.touches[0]
      const base: Gesture = {
        id: touch.identifier,
        index,
        row: row ?? list,
        startX: touch.clientX,
        startY: touch.clientY,
        kind: 'pending',
        timer: 0,
        scroller: null,
        startScroll: 0,
        y: touch.clientY,
        target: index,
        base: state.current.upNext,
        startOffset: 0,
        offset: 0,
        samples: [{ y: touch.clientX, t: e.timeStamp }],
      }
      // A row swiped open closes at the next touch anywhere but its own
      // "remove", and that touch does nothing else, as a native list's does.
      const openIndex = state.current.open
      if (openIndex != null) {
        if (index === openIndex) {
          if (target?.closest('[data-swipe-action]')) return
          g = { ...base, kind: 'pending', startOffset: SWIPE_ACTION_WIDTH, offset: SWIPE_ACTION_WIDTH }
          return
        }
        closeOpen()
        g = { ...base, kind: 'consumed' }
        return
      }
      if (!row || state.current.busy) return
      g = base
      g.timer = window.setTimeout(lift, LONG_PRESS_MS)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!g) return
      const touch = [...e.touches].find((t) => t.identifier === g?.id)
      if (!touch) return
      const dx = touch.clientX - g.startX
      const dy = touch.clientY - g.startY
      if (g.kind === 'consumed') return
      if (g.kind === 'pending') {
        if (!holdBroken(dx, dy)) return
        window.clearTimeout(g.timer)
        // Sideways and leftwards, or back from open: a swipe. Anything
        // else is the content's scroll or the sheet's drag.
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= DRAG_SLOP && (dx < 0 || g.startOffset > 0)) {
          g.kind = 'swipe'
          g.startX = touch.clientX
        } else {
          if (g.startOffset > 0) closeOpen()
          g = null
          return
        }
      }
      e.stopPropagation()
      if (e.cancelable) e.preventDefault()
      if (g.kind === 'lift') {
        g.y = touch.clientY
        layoutLift()
      } else {
        g.offset = swipeOffset(g.startOffset, touch.clientX - g.startX, g.row.getBoundingClientRect().width)
        setSwipe(g.row, g.offset, false)
        g.samples.push({ y: touch.clientX, t: e.timeStamp })
        while (g.samples.length > 2 && e.timeStamp - g.samples[1].t > VELOCITY_WINDOW_MS) g.samples.shift()
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (!g) return
      if (g.kind === 'pending') {
        // A tap: the row's own click plays it. An open row's face closes.
        window.clearTimeout(g.timer)
        if (g.startOffset > 0) {
          closeOpen()
          if (e.cancelable) e.preventDefault()
          swallowClicksUntil = performance.now() + 400
        }
        g = null
        return
      }
      if (e.cancelable) e.preventDefault()
      swallowClicksUntil = performance.now() + 400
      finish(e.type === 'touchcancel', e.timeStamp)
    }

    const onClick = (e: MouseEvent) => {
      if (performance.now() >= swallowClicksUntil) return
      e.preventDefault()
      e.stopPropagation()
    }
    // A held row is the list's, not the system's long-press menu.
    const onContextMenu = (e: Event) => {
      if (g) e.preventDefault()
    }

    list.addEventListener('touchstart', onTouchStart, { passive: true })
    list.addEventListener('touchmove', onTouchMove, { passive: false })
    list.addEventListener('touchend', onTouchEnd, { passive: false })
    list.addEventListener('touchcancel', onTouchEnd, { passive: false })
    list.addEventListener('click', onClick, true)
    list.addEventListener('contextmenu', onContextMenu)
    return () => {
      finish(true)
      list.removeEventListener('touchstart', onTouchStart)
      list.removeEventListener('touchmove', onTouchMove)
      list.removeEventListener('touchend', onTouchEnd)
      list.removeEventListener('touchcancel', onTouchEnd)
      list.removeEventListener('click', onClick, true)
      list.removeEventListener('contextmenu', onContextMenu)
    }
    // The list element comes and goes with the queue being empty.
  }, [listed])

  if (playback.currentTitle == null) {
    return (
      <Empty title="Nothing playing" body="Pick anything to play, or let the library choose.">
        <Button variant="secondary" icon="arrow-swap" size="lg" onClick={onShuffleLibrary} className="touch-target">
          Shuffle library
        </Button>
      </Empty>
    )
  }

  // There's no "jump to index" in the player, so a tap steps forward that
  // many times, each step serialized behind the last, as the desktop does.
  const jumpTo = async (index: number) => {
    for (let i = 0; i <= index; i++) await playback.next()
  }

  const keys = rowKeys(entries)

  return (
    <div className="px-[20px] pb-[20px]">
      <div className="mt-[12px] flex items-center justify-between gap-[12px] text-small text-[var(--color-ink-2)]">
        <span className="min-w-0 truncate">
          {from ? (
            <>
              Playing from <span className="text-[var(--color-ink)]">{from}</span>
            </>
          ) : (
            `${plural(entries.length, 'track')} up next`
          )}
        </span>
        {entries.length > 0 && (
          <Button onClick={() => void playback.clearUpNext()} disabled={queueBusy} className="touch-target">
            clear
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <Empty title="Nothing after this track" body="Play an album or a playlist to fill it, or let the library choose.">
          <Button variant="secondary" icon="arrow-swap" size="lg" onClick={onShuffleLibrary} className="touch-target">
            Shuffle library
          </Button>
        </Empty>
      ) : (
        <ol ref={listRef} aria-label="Up next" className="-mx-[4px] mt-[6px] flex flex-col [-webkit-touch-callout:none]">
          {entries.map((entry, i) => (
            <UpNextRow
              key={keys[i]}
              entry={entry}
              index={i}
              count={entries.length}
              artist={graph.byId.get(entry.recordingNodeId)?.subtitle ?? null}
              busy={queueBusy}
              lifted={lifted === i}
              open={open === i}
              onPlay={() => void jumpTo(i)}
              onMove={(to) => handlers.current.move(i, to)}
              onRemove={() => handlers.current.remove(i)}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

type UpNextRowProps = {
  entry: QueueEntry
  index: number
  count: number
  artist: string | null
  busy: boolean
  lifted: boolean
  open: boolean
  onPlay: () => void
  onMove: (to: number) => void
  onRemove: () => void
}

function UpNextRow({ entry, index, count, artist, busy, lifted, open, onPlay, onMove, onRemove }: UpNextRowProps) {
  return (
    <li
      data-index={index}
      // The rows scroll the list up and down; sideways is the swipe's.
      className={`relative touch-pan-y overflow-hidden select-none ${
        lifted ? 'z-[1] rounded-[10px] bg-[var(--color-raised)] shadow-[var(--shadow-sm)]' : ''
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <div data-swipe className="relative h-full">
        <div className="grid h-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-[12px] px-[4px]">
          <CoverArt nodeId={entry.recordingNodeId} size="thumb" radius="none" className="size-[44px] rounded-[5px]" />
          <button type="button" onClick={onPlay} disabled={busy} className="flex min-w-0 flex-col text-left">
            <span title={entry.title} className="truncate text-[15px] leading-[20px] font-medium text-[var(--color-ink)]">
              {entry.title}
            </span>
            <span className="truncate text-secondary text-[var(--color-ink-2)]">{artist ?? NO_VALUE}</span>
          </button>
          <div className="group/actions flex items-center">
            <span className="mono text-mono text-[var(--color-ink-2)] group-focus-within/actions:hidden">
              {formatDuration(entry.durationMs)}
            </span>
            {/* For a keyboard or a screen reader, which can't hold or swipe:
             * out of sight until one has the focus. */}
            <div className="sr-only flex items-center group-focus-within/actions:not-sr-only">
              <IconButton
                icon="chevron-up"
                label={`Move ${entry.title} up`}
                size={44}
                iconSize={20}
                tooltip={false}
                disabled={busy || index === 0}
                onClick={() => onMove(index - 1)}
              />
              <IconButton
                icon="chevron-down"
                label={`Move ${entry.title} down`}
                size={44}
                iconSize={20}
                tooltip={false}
                disabled={busy || index === count - 1}
                onClick={() => onMove(index + 1)}
              />
              <IconButton
                icon="cancel"
                label={`Remove ${entry.title} from up next`}
                size={44}
                iconSize={20}
                tooltip={false}
                disabled={busy}
                onClick={onRemove}
              />
            </div>
          </div>
        </div>
        {/* Behind the row's right edge, uncovered as the row swipes left. */}
        <button
          type="button"
          data-swipe-action
          aria-hidden={!open}
          tabIndex={open ? 0 : -1}
          onClick={onRemove}
          disabled={busy}
          className="absolute inset-y-0 left-full flex items-center justify-center bg-[var(--color-bad)] text-[15px] font-medium text-[var(--color-canvas)]"
          style={{ width: SWIPE_ACTION_WIDTH }}
        >
          remove
        </button>
      </div>
    </li>
  )
}
