import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { Icon, type IconName } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { useCoverColor, withAlpha } from '../ui/coverColor'
import { usePrefersReducedMotion } from '../ui/usePrefersReducedMotion'
import { PlaylistPicker } from '../panels/AddToPlaylistButton'
import { Lyrics } from '../panels/NowPlaying'
import type { RepeatMode, usePlayback } from '../playback/usePlayback'
import { useStreamQuality } from '../playback/useStreamQuality'
import { dismissesOnRelease } from './nowPlayingGesture'
import type { PhonePlatform } from './phoneLayout'
import { MenuItem } from './PhoneNode'
import { Scrubber } from './Scrubber'
import { DRAG_SLOP, VELOCITY_WINDOW_MS, releaseVelocity, type Sample } from './sheetGeometry'
import { Transport } from './Transport'
import { FavouriteButton } from './UpNextTransport'
import type { PlayingTrack } from './usePlayingTrack'

/* Now playing (#389, Legato Mobile v2 screen 7): the track full screen,
 * from a tap on the cover in the mini player or up next. The cover's
 * colour washes down the screen. A header with the collapse chevron,
 * "playing from" and its source, and the more menu; the square cover; the
 * title (22/500), the artist (16) and the heart; the scrubber with the
 * stream's quality between elapsed and remaining, named as #118's
 * connection indicator names it; the transport at 48 / 56 / 76 / 56 / 48;
 * and three chips: lyrics, show on map, up next.
 *
 * Lyrics swap in for the cover, in the same square, the sung line kept in
 * view, and come back out on a second tap. Show on map closes it and shows
 * the track on the map; the more menu's go to album and go to artist close
 * it and open that node. Up next closes it onto the sheet's up next.
 *
 * It's a history entry (navigation.ts), so the collapse chevron, a swipe
 * down, Escape and Android's back all close it the same way. It rises from
 * the bottom on the sheet's spring and follows a finger back down; under
 * reduced motion it fades instead. */

type Playback = ReturnType<typeof usePlayback>

/* The cover's distance under the header: what the handoff's two frames
 * draw, the taller Android frame giving it more room. */
const COVER_GAP: Record<PhonePlatform, number> = { ios: 28, android: 40 }

/* Everything in the column but the cover, its gap and the space over the
 * chips, as the frames stack it: the 4px top padding, the 44px header, 28
 * and the title block's 50, 20 and the 4px track, 8 and the 16px
 * readouts, 14 and the 76px transport, 12 and the 40px chips, and the 12px
 * bottom padding. A screen too short for a full-width cover shrinks the
 * cover rather than pushing the chips off the bottom. */
const COLUMN_CHROME = 4 + 44 + 28 + 50 + 20 + 4 + 8 + 16 + 14 + 76 + 12 + 40 + 12

/* As long as the sheet's spring, so closing ends when the slide does. */
const CLOSE_MS = 300

type NowPlayingScreenProps = {
  /** False while it closes; it's unmounted once it has. */
  open: boolean
  /** Ask for it to close: a back in history. */
  onClose: () => void
  /** It has finished closing. */
  onClosed: () => void
  playback: Playback
  track: PlayingTrack
  /** "Playing from …"'s source, or null when the queue came from nowhere
   * in particular. */
  from: string | null
  platform: PhonePlatform
  repeatMode: RepeatMode
  onCycleRepeat: () => void
  /** Close Now playing and show the track's node on the map. */
  onShowOnMap: (id: number) => void
  /** Close Now playing and open a node: the track's album or artist. */
  onOpenNode: (id: number) => void
  /** Close Now playing onto the sheet's up next. */
  onOpenUpNext: () => void
}

type Drag = { id: number; startX: number; startY: number; samples: Sample[]; active: boolean; offset: number }

export function NowPlayingScreen({
  open,
  onClose,
  onClosed,
  playback,
  track,
  from,
  platform,
  repeatMode,
  onCycleRepeat,
  onShowOnMap,
  onOpenNode,
  onOpenUpNext,
}: NowPlayingScreenProps) {
  const ref = useRef<HTMLElement>(null)
  const reduced = usePrefersReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  const [lyrics, setLyrics] = useState(false)

  const { status, currentTitle, problem } = playback
  const color = useCoverColor(track.nodeId)
  const quality = useStreamQuality({ embedded: false, currentFileId: status.currentFileId, streaming: status.streaming })
  const gap = COVER_GAP[platform]

  /** Places the screen `y` px down from where it rests, or off the bottom
   * (null). Written to the DOM, so a drag doesn't re-render it. */
  const place = useCallback((y: number | null, animate: boolean) => {
    const screen = ref.current
    if (!screen) return
    const fade = reducedRef.current
    screen.style.transition = animate
      ? fade
        ? 'opacity var(--motion-fast) var(--ease-out)'
        : 'transform var(--motion-spring) var(--ease-spring)'
      : 'none'
    if (y == null) {
      screen.style.opacity = fade ? '0' : '1'
      screen.style.transform = fade ? '' : 'translate3d(0, 100%, 0)'
    } else {
      screen.style.opacity = '1'
      screen.style.transform = y > 0 ? `translate3d(0, ${y}px, 0)` : ''
    }
  }, [])

  // It starts off the bottom, and rises once that's been laid out.
  useLayoutEffect(() => {
    place(null, false)
    ref.current?.getBoundingClientRect()
  }, [place])

  useLayoutEffect(() => {
    if (open) {
      place(0, true)
      return
    }
    place(null, true)
    const timer = window.setTimeout(() => onClosedRef.current(), CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [open, place])

  // The focus moves in, so a screen reader starts here, and goes back to
  // the cover that opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  // Swiping down. Pointer events, as the sheet's header uses: nothing here
  // scrolls but the lyrics, which pan natively and cancel the drag.
  const drag = useRef<Drag | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!open || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    // The more menu is portaled out of the screen but its events bubble
    // through it.
    if (!ref.current?.contains(e.target as Node)) return
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, samples: [], active: false, offset: 0 }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!d.active) {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return
      if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
        drag.current = null
        return
      }
      // From where the drag was claimed, so the screen doesn't jump the slop.
      d.active = true
      d.startY = e.clientY
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    d.offset = Math.max(0, e.clientY - d.startY)
    place(d.offset, false)
    d.samples.push({ y: e.clientY, t: e.timeStamp })
    while (d.samples.length > 2 && e.timeStamp - d.samples[1].t > VELOCITY_WINDOW_MS) d.samples.shift()
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.active) return
    // releaseVelocity counts upwards as positive; a dismissal goes down.
    const velocity = e.type === 'pointercancel' ? 0 : -releaseVelocity(d.samples, e.timeStamp)
    if (dismissesOnRelease({ offset: d.offset, velocity, height: e.currentTarget.clientHeight })) {
      place(null, true)
      onClose()
    } else {
      place(0, true)
    }
  }

  const wash = color ? `linear-gradient(180deg, ${withAlpha(color, 0.55)} 0%, ${withAlpha(color, 0.18)} 55%, transparent 100%)` : undefined

  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // Opaque: the map and the sheet are out of reach under it.
      className="absolute inset-0 z-30 flex touch-none flex-col bg-[var(--color-canvas)] outline-none [container-type:size]"
      style={{ backgroundImage: wash }}
    >
      <div className="flex min-h-0 flex-1 flex-col px-[24px] pt-[calc(env(safe-area-inset-top)+4px)] pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <header className="grid h-[44px] shrink-0 grid-cols-[44px_minmax(0,1fr)_44px] items-center">
          <IconButton icon="chevron-down" label="Close now playing" size={44} iconSize={24} tone="ink" tooltip={false} onClick={onClose} />
          <div className="flex min-w-0 flex-col items-center text-center">
            {from ? (
              <>
                {/* 11px, the smallest the handoff allows, kept for this
                 * header label. */}
                <span className="text-[11px] leading-[14px] tracking-[0.04em] text-[var(--color-ink-2)]">playing from</span>
                <span title={from} className="max-w-full truncate text-[13px] leading-[18px] font-medium text-[var(--color-ink)]">
                  {from}
                </span>
              </>
            ) : (
              <span className="text-[13px] leading-[18px] font-medium text-[var(--color-ink)]">now playing</span>
            )}
          </div>
          <MoreMenu track={track} onOpenNode={onOpenNode} />
        </header>

        <div
          className="shrink-0 self-center"
          style={{
            marginTop: gap,
            width: `min(100%, calc(100cqh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - ${COLUMN_CHROME + gap}px))`,
            aspectRatio: '1 / 1',
            // Square whatever's in it: an aspect-ratio box otherwise grows
            // to fit long lyrics.
            minHeight: 0,
          }}
        >
          {lyrics && track.nodeId != null ? (
            <div
              data-selectable
              className="size-full touch-pan-y overflow-y-auto overscroll-contain pb-[24px] [mask-image:linear-gradient(transparent,black_20px,black_calc(100%-32px),transparent)]"
            >
              <Lyrics nodeId={track.nodeId} positionMs={status.positionMs} />
            </div>
          ) : (
            <div className="size-full rounded-[12px] shadow-[var(--shadow-panel)]">
              <CoverArt
                nodeId={track.nodeId}
                size="full"
                alt={currentTitle ? `Cover art for ${currentTitle}` : ''}
                radius="none"
                className="size-full rounded-[12px]"
              />
            </div>
          )}
        </div>

        <div className="mt-[28px] flex shrink-0 items-center gap-[12px]">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 title={currentTitle ?? undefined} className="truncate text-[22px] leading-[28px] font-medium text-[var(--color-ink)]">
              {currentTitle}
            </h2>
            {problem ? (
              <span
                role="alert"
                title={`${problem.headline}. ${problem.detail}`}
                className="truncate text-[16px] leading-[22px] text-[var(--color-ink-2)]"
              >
                {problem.headline}
              </span>
            ) : (
              <span title={track.artist ?? undefined} className="truncate text-[16px] leading-[22px] text-[var(--color-ink-2)]">
                {track.artist}
              </span>
            )}
          </div>
          <FavouriteButton detail={track.detail} round />
        </div>

        <Scrubber
          className="mt-[20px] shrink-0"
          positionMs={status.positionMs}
          durationMs={status.currentDurationMs}
          onSeek={playback.seek}
          middle={currentTitle != null ? quality.label : null}
        />
        <Transport className="mt-[14px] shrink-0" size="full" playback={playback} repeatMode={repeatMode} onCycleRepeat={onCycleRepeat} />

        <div className="mt-auto flex shrink-0 items-center justify-between pt-[12px]">
          <Chip pressed={lyrics} onClick={() => setLyrics((on) => !on)}>
            lyrics
          </Chip>
          <Chip icon="target" disabled={track.nodeId == null} onClick={() => track.nodeId != null && onShowOnMap(track.nodeId)}>
            show on map
          </Chip>
          <Chip onClick={onOpenUpNext}>up next</Chip>
        </div>
      </div>
    </section>
  )
}

/* The bottom chips: 40px on --color-wash-2, 14/500, each in a 44px target.
 * Lyrics, a toggle, inverts to ink while it's on, as an active chip does. */
function Chip({
  children,
  icon,
  pressed,
  disabled,
  onClick,
}: {
  children: ReactNode
  icon?: IconName
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`touch-target inline-flex h-[40px] items-center gap-[8px] rounded-full px-[14px] text-[14px] font-medium disabled:opacity-40 ${
        pressed ? 'bg-[var(--color-ink)] text-[var(--color-canvas)]' : 'bg-[var(--color-wash-2)] text-[var(--color-ink)]'
      }`}
    >
      {icon && (
        <span className="inline-flex text-[var(--color-accent)]">
          <Icon name={icon} size={18} />
        </span>
      )}
      {children}
    </button>
  )
}

/* The header's more menu: add to playlist, go to album, go to artist, in
 * node detail's menu rows. Add to playlist swaps the menu for the playlist
 * picker in place, as node detail's does. */
function MoreMenu({ track, onOpenNode }: { track: PlayingTrack; onOpenNode: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const go = (id: number | null, close: () => void) => {
    if (id == null) return
    close()
    onOpenNode(id)
  }
  return (
    <Popover
      label={picking ? 'Add to playlist' : 'More'}
      placement="bottom"
      align="end"
      className="w-[240px] p-[6px]"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPicking(false)
      }}
      trigger={({ open: _open, ...props }) => (
        <button
          type="button"
          aria-label="More"
          {...props}
          className="grid size-[44px] place-items-center rounded-full text-[var(--color-ink)]"
        >
          <Icon name="more" size={22} />
        </button>
      )}
    >
      {(close) =>
        picking && track.nodeId != null ? (
          <PlaylistPicker nodeId={track.nodeId} onDone={close} sheet />
        ) : (
          <ul className="flex flex-col">
            <MenuItem disabled={track.nodeId == null} onClick={() => setPicking(true)}>
              add to playlist
            </MenuItem>
            <MenuItem disabled={track.albumId == null} onClick={() => go(track.albumId, close)}>
              go to album
            </MenuItem>
            <MenuItem disabled={track.artistId == null} onClick={() => go(track.artistId, close)}>
              go to artist
            </MenuItem>
          </ul>
        )
      }
    </Popover>
  )
}
