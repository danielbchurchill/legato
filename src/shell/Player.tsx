import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { PlayCircle } from '../ui/PlayCircle'
import { Popover } from '../ui/Popover'
import { Slider } from '../ui/Slider'
import { Tooltip } from '../ui/Tooltip'
import { formatDuration } from '../ui/format'
import { useCoverColor, withAlpha } from '../ui/coverColor'
import type { PlaybackStatus, RepeatMode } from '../playback/usePlayback'
import type { PlaybackProblem } from '../playback/playbackError'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import { Surface } from './Surface'
import { useShellLayout } from './layout'
import {
  IDLE_GAP,
  IDLE_HEIGHT,
  IDLE_PADDING,
  IDLE_PADDING_TEXT,
  PLAYER_BAR_GAP,
  PLAYER_BAR_MIN_WIDTH,
  PLAYER_COLUMN_GAP,
  PLAYER_COVER_SIZE,
  PLAYER_PADDING_LEFT,
  PLAYER_PADDING_RIGHT,
  PLAYER_PLAY_SIZE,
  PLAYER_QUEUE_SIZE,
  PLAYER_QUEUE_VOLUME_GAP,
  PLAYER_REPEAT_SIZE,
  PLAYER_SCRUBBER_GAP,
  PLAYER_SHUFFLE_SIZE,
  PLAYER_SKIP_SIZE,
  PLAYER_TIME_WIDTH,
  PLAYER_TRANSPORT_GAP,
  PLAYER_VOLUME_SIZE,
} from './playerGeometry'

/* The player: a 72px glass bar floating above the bottom edge, centred on
 * the free space. It replaces the 514×121 transport dock.
 *
 * Left to right: the cover, title over artist, the transport over its
 * scrubber, then the queue and volume buttons. The bar picks up the cover's
 * colour as a wash from its left edge, so what's playing tints the chrome
 * that controls it. As the bar narrows, the parts give way in the order
 * layout.ts sets out, down to previous, play/pause and next (#293).
 *
 * With nothing loaded, the bar gives way to a small idle pill with one way
 * back in (Shuffle library). It never shows every control disabled — that
 * read as broken chrome (#50). The pill sits where the bar would, inside
 * its width, and gives way in its own order (#308). */

const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat all tracks',
  one: 'Repeat current track',
}

/* ---- Waveform ------------------------------------------------------------ */

// The server's loudness envelope is 2000 buckets; the player shows 56 bars,
// or 24 in a narrower bar. Each bar takes the loudest bucket it covers, so a
// transient isn't averaged away.
function downsample(peaks: number[], barCount: number): number[] {
  const bars = new Array<number>(barCount).fill(0)
  const perBar = peaks.length / barCount
  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * perBar)
    const end = Math.max(start + 1, Math.floor((i + 1) * perBar))
    let peak = 0
    for (let j = start; j < end && j < peaks.length; j++) if (peaks[j] > peak) peak = peaks[j]
    bars[i] = peak
  }
  return bars
}

/* Until the envelope arrives (or for a file that has none), a seeded shape
 * rather than a flat line: a flat line reads as silence. Seeded by file, so
 * it doesn't reshuffle on every render. */
function seededBars(seed: number, barCount: number): number[] {
  let s = (seed * 9301 + 49297) % 233280
  const next = () => (s = (s * 9301 + 49297) % 233280) / 233280
  return Array.from({ length: barCount }, (_, k) => 0.3 + 0.7 * Math.abs(Math.sin((k * 0.37 * 56) / barCount)) * (0.5 + 0.5 * next()))
}

function usePeaks(fileId: number | null): number[] {
  const [peaks, setPeaks] = useState<{ fileId: number; peaks: number[] } | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    if (fileId == null) return
    let cancelled = false
    fetch(`${API}/files/${fileId}/peaks`)
      .then((r) => r.json())
      .then((d: { peaks: number[] }) => {
        if (!cancelled) setPeaks({ fileId, peaks: d.peaks ?? [] })
      })
      .catch(() => {
        if (!cancelled) setPeaks({ fileId, peaks: [] })
      })
    return () => {
      cancelled = true
    }
  }, [fileId, reconnects])
  return peaks != null && peaks.fileId === fileId ? peaks.peaks : []
}

function Waveform({
  fileId,
  positionMs,
  durationMs,
  barCount,
  onSeek,
}: {
  fileId: number | null
  positionMs: number
  durationMs: number | null
  barCount: number
  onSeek: (ms: number) => void
}) {
  const peaks = usePeaks(fileId)
  const ref = useRef<HTMLDivElement>(null)
  // While dragging, the played edge follows the pointer and the seek lands
  // on release — seeking on every move would restart decode dozens of times.
  const [dragMs, setDragMs] = useState<number | null>(null)

  const bars = peaks.length > 0 ? downsample(peaks, barCount) : seededBars(fileId ?? 0, barCount)
  const shownMs = dragMs ?? positionMs
  const progress = durationMs && durationMs > 0 ? Math.min(1, shownMs / durationMs) : 0
  // Live data steps, never eases (DESIGN.md Motion): a bar is played or not.
  const playedBars = Math.round(progress * barCount)

  const msAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(fraction * (durationMs ?? 0))
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!durationMs) return
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
    <div className="flex w-full min-w-0 items-center" style={{ gap: PLAYER_SCRUBBER_GAP }}>
      <span className="mono shrink-0 text-right text-[11px] text-[var(--color-ink-2)]" style={{ width: PLAYER_TIME_WIDTH }}>
        {formatDuration(shownMs)}
      </span>
      <div
        ref={ref}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={durationMs ?? 0}
        aria-valuenow={positionMs}
        aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(durationMs)}`}
        tabIndex={durationMs ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragMs(null)}
        onKeyDown={(e) => {
          if (!durationMs) return
          if (e.key === 'ArrowRight') onSeek(Math.min(durationMs, positionMs + 5000))
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, positionMs - 5000))
        }}
        className={`flex h-[14px] min-w-0 flex-1 touch-none items-center ${durationMs ? 'cursor-pointer' : ''}`}
        style={{ gap: PLAYER_BAR_GAP }}
      >
        {bars.map((peak, i) => (
          <span
            key={i}
            className={`flex-1 rounded-[2px] ${i < playedBars ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-wash-2)]'}`}
            style={{ minWidth: PLAYER_BAR_MIN_WIDTH, height: `${Math.round(Math.max(0.14, peak) * 100)}%` }}
          />
        ))}
      </div>
      <span className="mono shrink-0 text-[11px] text-[var(--color-ink-2)]" style={{ width: PLAYER_TIME_WIDTH }}>
        {formatDuration(durationMs)}
      </span>
    </div>
  )
}

/* ---- Player -------------------------------------------------------------- */

type PlayerProps = {
  title: string
  artist: string | null
  status: PlaybackStatus
  shuffled: boolean
  queueBusy: boolean
  repeatMode: RepeatMode
  problem: PlaybackProblem | null
  queueOpen: boolean
  onToggleQueue: () => void
  onResolveProblem: () => void
  onPause: () => void
  onResume: () => void
  onSeek: (ms: number) => void
  onSetVolume: (value: number) => void
  onNext: () => void
  onPrevious: () => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
}

export function Player({
  title,
  artist,
  status,
  shuffled,
  queueBusy,
  repeatMode,
  problem,
  queueOpen,
  onToggleQueue,
  onResolveProblem,
  onPause,
  onResume,
  onSeek,
  onSetVolume,
  onNext,
  onPrevious,
  onToggleShuffle,
  onCycleRepeat,
}: PlayerProps) {
  const layout = useShellLayout()
  const parts = layout.playerParts
  const color = useCoverColor(status.currentRecordingNodeId)
  const background = color
    ? `linear-gradient(90deg, ${withAlpha(color, 0.38)}, ${withAlpha(color, 0)} 42%), var(--color-surface)`
    : undefined

  return (
    <Surface
      role="region"
      aria-label="Player"
      // Clipped to its own bar. Nothing should need it: every set of parts
      // fits the width layout.ts picks it for.
      className="absolute bottom-[var(--inset)] z-20 flex h-[var(--player-height)] -translate-x-1/2 items-center overflow-hidden rounded-[var(--radius-panel)]"
      style={{
        left: layout.playerCx,
        width: layout.playerWidth,
        gap: PLAYER_COLUMN_GAP,
        paddingLeft: PLAYER_PADDING_LEFT,
        paddingRight: PLAYER_PADDING_RIGHT,
        background,
      }}
    >
      {parts.cover && (
        <CoverArt
          nodeId={status.currentRecordingNodeId}
          size="thumb"
          style={{ width: PLAYER_COVER_SIZE, height: PLAYER_COVER_SIZE }}
          alt=""
        />
      )}

      <div
        className={parts.titleWidth > 0 ? 'flex min-w-0 shrink-0 flex-col' : 'sr-only'}
        style={parts.titleWidth > 0 ? { width: parts.titleWidth } : undefined}
      >
        <span title={title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {title}
        </span>
        <span title={artist ?? undefined} className="truncate text-small text-[var(--color-ink-2)]">
          {artist ?? ''}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-center gap-[4px]">
        <div className="flex items-center" style={{ gap: PLAYER_TRANSPORT_GAP }}>
          {parts.shuffleAndRepeat && (
            <IconButton
              icon="arrow-swap"
              label={shuffled ? 'Shuffle on' : 'Shuffle off'}
              size={PLAYER_SHUFFLE_SIZE}
              active={shuffled}
              aria-pressed={shuffled}
              disabled={queueBusy}
              onClick={onToggleShuffle}
              tooltipPlacement="top"
            />
          )}
          <IconButton
            icon="reverse"
            label="Previous track"
            size={PLAYER_SKIP_SIZE}
            disabled={queueBusy}
            onClick={onPrevious}
            tooltipPlacement="top"
          />
          <PlayCircle
            variant="ink"
            size={PLAYER_PLAY_SIZE}
            playing={status.playing}
            label={status.playing ? 'Pause' : 'Play'}
            disabled={queueBusy}
            onClick={status.playing ? onPause : onResume}
          />
          <IconButton
            icon="fast-forward"
            label="Next track"
            size={PLAYER_SKIP_SIZE}
            disabled={queueBusy}
            onClick={onNext}
            tooltipPlacement="top"
          />
          {/* Repeat-one gets a "1" badge: on/off is the wash, but all vs one
           * needs a mark of its own. */}
          {parts.shuffleAndRepeat && (
            <span className="relative">
              <IconButton
                icon="repeat"
                label={REPEAT_LABEL[repeatMode]}
                size={PLAYER_REPEAT_SIZE}
                active={repeatMode !== 'off'}
                disabled={queueBusy}
                onClick={onCycleRepeat}
                tooltipPlacement="top"
              />
              {repeatMode === 'one' && (
                <span
                  aria-hidden="true"
                  className="mono pointer-events-none absolute right-[3px] bottom-[2px] text-[9px] leading-none text-[var(--color-ink)]"
                >
                  1
                </span>
              )}
            </span>
          )}
        </div>

        {problem ? (
          // What happened, why, and the one action that fixes it. role=alert
          // because the play button that was just pressed gives no other
          // sign that nothing happened (#184). It stays when the scrubber
          // has given way: the action fits under the transport at any width.
          <div role="alert" className="flex w-full min-w-0 items-center gap-[10px]">
            <p title={`${problem.headline}. ${problem.detail}`} className="min-w-0 flex-1 truncate text-small text-[var(--color-ink-2)]">
              <span className="text-[var(--color-ink)]">{problem.headline}</span> · {problem.detail}
            </p>
            <Button onClick={onResolveProblem} disabled={queueBusy}>
              {problem.action === 'retry' ? 'Try again' : 'Skip track'}
            </Button>
          </div>
        ) : (
          parts.waveformBars > 0 && (
            <Waveform
              fileId={status.currentFileId}
              positionMs={status.positionMs}
              durationMs={status.currentDurationMs}
              barCount={parts.waveformBars}
              onSeek={onSeek}
            />
          )
        )}
      </div>

      {parts.queueAndVolume && (
        <div className="flex shrink-0 items-center" style={{ gap: PLAYER_QUEUE_VOLUME_GAP }}>
          <IconButton
            icon="info"
            label={queueOpen ? 'Hide queue' : 'Show queue'}
            size={PLAYER_QUEUE_SIZE}
            active={queueOpen}
            aria-pressed={queueOpen}
            onClick={onToggleQueue}
            tooltipPlacement="top"
          />
          {/* Volume opens a vertical slider; the glyph swaps to muted at zero
           * so the state reads without opening anything. */}
          <Popover
            label="Volume"
            placement="top"
            align="center"
            className="px-[10px] py-[14px]"
            trigger={({ open: _open, ...props }) => (
              <Tooltip label={`Volume ${Math.round(status.volume * 100)}%`} placement="top">
                <button
                  type="button"
                  aria-label={`Volume, ${Math.round(status.volume * 100)}%`}
                  {...props}
                  style={{ width: PLAYER_VOLUME_SIZE, height: PLAYER_VOLUME_SIZE }}
                  className="grid place-items-center rounded-[10px] text-[var(--color-ink-2)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] hover:text-[var(--color-ink)]"
                >
                  <Icon name={status.volume === 0 ? 'volume-mute' : 'volume'} size={19} />
                </button>
              </Tooltip>
            )}
          >
            <Slider
              orientation="vertical"
              label="Volume"
              min={0}
              max={1}
              step={0.01}
              value={status.volume}
              onChange={onSetVolume}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Popover>
        </div>
      )}
    </Surface>
  )
}

/* Nothing loaded: one sentence and one way in. The space keycap says the
 * same thing the button does — space starts it from anywhere. As the bar's
 * width narrows, the keycap goes, then the sentence, then the button's label.
 * Once the keycap's gone, the button's tooltip says space instead, and once
 * its label's gone, the tooltip names it too.
 *
 * The pill is as wide as its content, on one line, and never wider than the
 * bar would be. It clips there, as the bar does, so text an engine draws
 * wider than Chromium measured it is cut off rather than spilling out. */
export function IdlePlayer({ onShuffleLibrary, busy }: { onShuffleLibrary: () => void; busy: boolean }) {
  const layout = useShellLayout()
  const parts = layout.idleParts
  return (
    <Surface
      role="region"
      aria-label="Player"
      className="absolute bottom-[var(--inset)] z-20 flex w-max -translate-x-1/2 items-center justify-center overflow-hidden rounded-full"
      style={{
        left: layout.playerCx,
        maxWidth: layout.playerWidth,
        height: IDLE_HEIGHT,
        minWidth: IDLE_HEIGHT,
        gap: IDLE_GAP,
        paddingLeft: parts.sentence ? IDLE_PADDING_TEXT : IDLE_PADDING,
        paddingRight: IDLE_PADDING,
      }}
    >
      {parts.sentence && (
        <span className="shrink-0 text-[length:var(--text-secondary)] whitespace-nowrap text-[var(--color-ink-2)]">Nothing playing</span>
      )}
      {/* One button at every width, in the same place, so a keyboard user's
       * focus stays on it as the pill narrows. */}
      <Tooltip label="Shuffle library" shortcut="space" placement="top" disabled={parts.shortcut}>
        {parts.buttonLabel ? (
          <Button variant="primary" icon="arrow-swap" onClick={onShuffleLibrary} disabled={busy}>
            Shuffle library
          </Button>
        ) : (
          <Button variant="primary" icon="arrow-swap" onClick={onShuffleLibrary} disabled={busy} aria-label="Shuffle library" />
        )}
      </Tooltip>
      {parts.shortcut && <Kbd>space</Kbd>}
    </Surface>
  )
}
