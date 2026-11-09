import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NOTICE_CLOSE, NOTICE_PRIMARY, NOTICE_SECONDARY, NOTICE_TITLE, noticeBody } from '../connect/awayNotice'
import { NoticeExplanation, NoticeRows } from '../connect/AwayNoticeParts'
import type { AwayNoticeView } from '../connect/useAwayNotice'
import type { usePlayback } from '../playback/usePlayback'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { usePrefersReducedMotion } from '../ui/usePrefersReducedMotion'
import { forgetNoticeEntry, leaveNoticeEntry, onNoticeEntry, pushNoticeEntry } from './navigation'
import { DRAG_SLOP, FLICK_VELOCITY, VELOCITY_WINDOW_MS, releaseVelocity, type Sample } from './sheetGeometry'
import type { PlayingTrack } from './usePlayingTrack'

/* The away-from-home notice (#412) on the phone: a sheet of its own, rising
 * from the bottom edge over everything, the main sheet at any detent, node
 * detail, a pushed page and now playing alike, headed by the playing track
 * with play/pause, so the music can be paused before deciding. A wash of the
 * canvas covers the rest, which is out of reach while it's open.
 *
 * It's a history entry, so Android's back closes it, as do the ×, Escape, a
 * tap on the wash and a swipe down: past 30% of its height, or a flick
 * faster than the main sheet's (FLICK_VELOCITY). It rises over
 * --motion-slow and goes back down over --motion-exit; under reduced motion
 * it fades where it rests, and a swipe snaps back rather than springing.
 *
 * The notice itself takes the focus as it opens, so a screen reader reads
 * it from its title; Tab goes play/pause, close, keep original, standard
 * while away, and stays inside. Focus goes back where it was on close. */

type Playback = ReturnType<typeof usePlayback>

// --motion-slow and --motion-exit, mirrored: a JS timeout can't read a CSS
// custom property.
const EXIT_MS = 120

// A swipe past this share of the sheet's height closes it.
const CLOSE_FRACTION = 0.3

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

type Drag = { id: number; startY: number; samples: Sample[]; active: boolean }

export function AwayNoticeSheet({ view, playback, track }: { view: AwayNoticeView; playback: Playback; track: PlayingTrack }) {
  const { open } = view
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const reduced = usePrefersReducedMotion()
  const washRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const titleId = useId()
  const bodyId = useId()
  const rowsId = useId()

  // What it last showed while open, so its exit doesn't change under it.
  const content = useRef({ server: view.server, rows: view.rows })
  if (open) content.current = { server: view.server, rows: view.rows }

  // Mount, then shown on the next frame so the rise has a from-state;
  // hidden, then unmounted once the exit has played.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      // oxlint-disable-next-line react/set-state-in-effect
      setMounted(true)
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [open])

  // The history entry: pushed as it opens, left as it closes by any other
  // way than back. An entry left over from before a reload isn't it.
  const pushed = useRef(false)
  useEffect(() => {
    forgetNoticeEntry()
  }, [])
  const onDismiss = view.onDismiss
  useEffect(() => {
    if (!open) {
      if (pushed.current) leaveNoticeEntry()
      pushed.current = false
      return
    }
    pushNoticeEntry()
    pushed.current = true
    const onPop = () => {
      if (!onNoticeEntry()) {
        pushed.current = false
        onDismiss()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [open, onDismiss])

  // Focus in on open, back out on close.
  useEffect(() => {
    if (!mounted || !open) return
    sheetRef.current?.focus({ preventScroll: true })
    return () => restoreRef.current?.focus({ preventScroll: true })
  }, [mounted, open])

  // Everything beside it is out of reach while it's open.
  useEffect(() => {
    const wash = washRef.current
    if (!mounted || !open || !wash?.parentElement) return
    const made = Array.from(wash.parentElement.children).filter(
      (el): el is HTMLElement => el !== wash && el !== sheetRef.current && el instanceof HTMLElement && !el.inert,
    )
    for (const el of made) el.inert = true
    return () => {
      for (const el of made) el.inert = false
    }
  }, [mounted, open])

  // Escape closes; Tab stays inside.
  useEffect(() => {
    if (!mounted || !open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onDismiss()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (focusable.length === 0) return e.preventDefault()
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === sheetRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [mounted, open, onDismiss])

  // Where the sheet sits while a finger holds it, written straight to it.
  const place = (offset: number, how: 'follow' | 'spring' | 'none') => {
    const sheet = sheetRef.current
    if (!sheet) return
    sheet.style.transition =
      how === 'spring' && !reduced
        ? 'transform var(--motion-spring) var(--ease-spring), opacity var(--motion-base) var(--ease-out)'
        : 'none'
    sheet.style.transform = offset > 0 ? `translate3d(0, ${offset}px, 0)` : ''
  }

  const begin = (id: number, y: number, t: number) => {
    if (dragRef.current) return
    dragRef.current = { id, startY: y, samples: [{ y, t }], active: false }
  }
  // Down only, and only once what's inside is back at its top.
  const move = (id: number, y: number, t: number, claim: () => void): boolean => {
    const drag = dragRef.current
    if (!drag || drag.id !== id) return false
    const dy = y - drag.startY
    if (!drag.active) {
      if (Math.abs(dy) < DRAG_SLOP) return false
      if (dy < 0 || (scrollerRef.current?.scrollTop ?? 0) > 0) {
        dragRef.current = null
        return false
      }
      drag.active = true
      drag.startY = y
      claim()
    }
    drag.samples.push({ y, t })
    while (drag.samples.length > 2 && t - drag.samples[1].t > VELOCITY_WINDOW_MS) drag.samples.shift()
    place(Math.max(0, y - drag.startY), 'follow')
    return true
  }
  const end = (id: number, t: number, cancelled: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.id !== id) return
    dragRef.current = null
    if (!drag.active) return
    const last = drag.samples[drag.samples.length - 1]
    const offset = Math.max(0, last.y - drag.startY)
    const height = sheetRef.current?.offsetHeight ?? 1
    // releaseVelocity is positive upwards.
    const flick = !cancelled && releaseVelocity(drag.samples, t) <= -FLICK_VELOCITY
    if (!cancelled && (offset > height * CLOSE_FRACTION || flick)) {
      // It goes on down from where the finger left it.
      const sheet = sheetRef.current
      if (sheet) {
        sheet.style.transition = ''
        sheet.style.transform = ''
      }
      onDismiss()
    } else {
      place(0, 'spring')
    }
  }

  // What the touch listeners call, kept current without adding them again.
  const gesture = useRef({ begin, move, end })
  gesture.current = { begin, move, end }

  // A finger: touch events, so a drag is claimed before anything scrolls.
  useEffect(() => {
    const sheet = sheetRef.current
    if (!mounted || !sheet) return
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        dragRef.current = null
        return
      }
      gesture.current.begin(e.touches[0].identifier, e.touches[0].clientY, e.timeStamp)
    }
    const onMove = (e: TouchEvent) => {
      const touch = [...e.touches].find((t) => t.identifier === dragRef.current?.id)
      if (!touch) return
      if (gesture.current.move(touch.identifier, touch.clientY, e.timeStamp, () => {}) && e.cancelable) e.preventDefault()
    }
    const onEnd = (e: TouchEvent) => {
      const drag = dragRef.current
      if (drag && ![...e.touches].some((t) => t.identifier === drag.id)) gesture.current.end(drag.id, e.timeStamp, e.type === 'touchcancel')
    }
    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd)
    sheet.addEventListener('touchcancel', onEnd)
    return () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onEnd)
    }
  }, [mounted])

  // A mouse or a pen: pointer events, captured once it's a drag so a click
  // on a button stays a click.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    begin(e.pointerId, e.clientY, e.timeStamp)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch') return
    const target = e.currentTarget
    move(e.pointerId, e.clientY, e.timeStamp, () => target.setPointerCapture(e.pointerId))
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch') return
    end(e.pointerId, e.timeStamp, e.type === 'pointercancel')
  }

  if (!mounted) return null

  const { status, currentTitle, queueBusy } = playback
  const playing = status.playing
  const { server, rows } = content.current
  const enter = shown ? 'duration-[var(--motion-slow)] ease-[var(--ease-enter)]' : 'duration-[var(--motion-exit)] ease-[var(--ease-exit)]'

  return (
    <>
      <div
        ref={washRef}
        aria-hidden="true"
        onClick={onDismiss}
        className={`absolute inset-0 z-40 bg-[var(--color-modal-wash)] transition-opacity ${
          shown ? 'duration-[var(--motion-base)] ease-[var(--ease-enter)]' : 'duration-[var(--motion-exit)] ease-[var(--ease-exit)]'
        }`}
        style={{ opacity: shown ? 1 : 0 }}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${bodyId} ${rowsId}`}
        tabIndex={-1}
        data-away-notice
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        // Glass, its top border only, with the main sheet's corners. Under
        // reduced motion it fades where it rests rather than rising.
        className={`glass absolute inset-x-0 bottom-0 z-40 flex max-h-[calc(100%-env(safe-area-inset-top)-64px)] flex-col rounded-t-[var(--radius-sheet)] outline-none ${
          reduced ? 'transition-opacity' : 'transition-transform'
        } ${enter}`}
        style={{
          borderLeftWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: 0,
          transform: reduced || shown ? undefined : 'translate3d(0, 100%, 0)',
          opacity: reduced && !shown ? 0 : undefined,
        }}
      >
        {/* The grabber, 8px down a 20px band. A swipe anywhere closes it,
         * and the × does the same for anything that can't swipe. */}
        <div aria-hidden="true" className="flex h-[20px] shrink-0 justify-center pt-[8px]">
          <span className="h-[5px] w-[36px] rounded-[3px] bg-[var(--color-line-strong)]" />
        </div>
        <div
          ref={scrollerRef}
          className="min-h-0 overflow-y-auto overscroll-contain px-[var(--spacing-panel)] pb-[calc(20px+env(safe-area-inset-bottom))]"
        >
          {currentTitle != null && (
            <>
              <div role="region" aria-label="Player" className="grid h-[56px] grid-cols-[40px_minmax(0,1fr)_44px] items-center gap-[12px]">
                <CoverArt nodeId={track.nodeId} size="thumb" alt="" radius="art" style={{ width: 40, height: 40 }} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-heading text-[var(--color-ink)]">{currentTitle}</span>
                  {track.artist && <span className="truncate text-secondary text-[var(--color-ink-2)]">{track.artist}</span>}
                </div>
                <IconButton
                  icon={playing ? 'pause' : 'play'}
                  filled
                  label={playing ? 'Pause' : 'Play'}
                  size={44}
                  iconSize={24}
                  tone="ink"
                  tooltip={false}
                  disabled={queueBusy}
                  onClick={playing ? playback.pause : playback.resume}
                />
              </div>
              <div aria-hidden="true" className="mt-[12px] h-px bg-[var(--color-line)]" />
            </>
          )}
          <div className="mt-[16px] flex items-start justify-between gap-[12px]">
            <h2 id={titleId} className="text-title text-[var(--color-ink)]">
              {NOTICE_TITLE}
            </h2>
            <IconButton
              icon="cancel"
              label={NOTICE_CLOSE}
              size={32}
              tone="ink-2"
              tooltip={false}
              onClick={onDismiss}
              // 32px on the title's 26px line, without making it taller.
              className="touch-target -my-[3px] -mr-[6px]"
            />
          </div>
          <p id={bodyId} className="mt-[6px] text-body [text-wrap:pretty] text-[var(--color-ink-2)]">
            {noticeBody(server)}
          </p>
          <div className="mt-[16px]">
            <NoticeRows rows={rows} id={rowsId} />
          </div>
          <div className="mt-[16px]">
            <NoticeExplanation />
          </div>
          <div className="mt-[16px] flex gap-[10px]">
            <Button variant="secondary" size="sheet" className="flex-1" onClick={view.onKeep}>
              {NOTICE_SECONDARY}
            </Button>
            <Button variant="primary" size="sheet" className="flex-1" onClick={view.onStandard}>
              {NOTICE_PRIMARY}
            </Button>
          </div>
        </div>
      </section>
    </>
  )
}
