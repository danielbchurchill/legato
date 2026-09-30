import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { Slider } from '../ui/Slider'
import type { PlaybackStatus, RepeatMode } from '../playback/usePlayback'
import { Surface } from './Surface'
import { API_BASE as API } from '../config/serverHost'

// D12 (docs/plans/05-listening-and-map.md): "Dock shows current mode; aria-
// label states it in words" — spelled out here rather than left to the icon
// alone, since off/all/one is a genuine tri-state a sighted user reads off
// the badge/color but a screen reader has no equivalent shorthand for.
const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat all tracks',
  one: 'Repeat current track',
}

/* The transport, docked to the window's bottom edge.
 *
 * #50: App.tsx only mounts this once something is actually queued
 * (playback.currentTitle != null) — it used to render unconditionally,
 * structural chrome present even with nothing loaded and every control
 * disabled, but that read as a broken dock rather than an empty one. Every
 * control below can assume a track is live; there's no more "nothing loaded"
 * case to render inert. */

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Downsampled from the server's 2000-bucket envelope to however many bars
// actually fit the dock — rendering 2000 DOM elements in a 462px-wide strip
// would be both pointless (most buckets would share a pixel) and slow.
const BAR_COUNT = 72

function downsample(peaks: number[], barCount: number): number[] {
  if (peaks.length === 0) return new Array(barCount).fill(0)
  const bars = new Array(barCount).fill(0)
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

function WaveformScrubber({
  fileId,
  positionMs,
  durationMs,
  onSeek,
}: {
  fileId: number | null
  positionMs: number
  durationMs: number | null
  onSeek: (ms: number) => void
}) {
  const [peaks, setPeaks] = useState<number[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (fileId == null) {
      setPeaks([])
      return
    }
    let cancelled = false
    fetch(`${API}/files/${fileId}/peaks`)
      .then((r) => r.json())
      .then((d: { peaks: number[] }) => {
        if (!cancelled) setPeaks(d.peaks)
      })
      .catch(() => {
        if (!cancelled) setPeaks([])
      })
    return () => {
      cancelled = true
    }
  }, [fileId])

  const bars = downsample(peaks, BAR_COUNT)
  const progress = durationMs && durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0
  const playedBars = Math.round(progress * BAR_COUNT)

  const seekToClientX = (clientX: number) => {
    if (!containerRef.current || !durationMs) return
    const rect = containerRef.current.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onSeek(Math.round(fraction * durationMs))
  }

  return (
    <div
      ref={containerRef}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={durationMs ?? 0}
      aria-valuenow={positionMs}
      tabIndex={durationMs ? 0 : -1}
      onClick={(e) => seekToClientX(e.clientX)}
      onKeyDown={(e) => {
        if (!durationMs) return
        if (e.key === 'ArrowRight') onSeek(Math.min(durationMs, positionMs + 5000))
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, positionMs - 5000))
      }}
      className={`flex h-[24px] w-full items-center gap-[2px] ${durationMs ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {bars.map((peak, i) => (
        <div
          key={i}
          className="flex-1 rounded-full bg-[var(--color-signal)]"
          style={{ height: `${Math.max(8, peak * 100)}%`, opacity: i < playedBars ? 1 : 0.25 }}
        />
      ))}
    </div>
  )
}

type TransportDockProps = {
  status: PlaybackStatus
  shuffled: boolean
  // True while a previous/next/shuffle/play/pause click (or a reorder/
  // remove/add elsewhere, e.g. NowPlayingPanel's up-next list) is still
  // resolving — usePlayback.ts serializes all of them behind one shared
  // lock, so a click on any of these while another is in flight gets
  // queued rather than lost. Disabling here just makes that visible
  // instead of leaving the dock looking inert for however long the
  // in-flight one takes.
  queueBusy: boolean
  // Off/all/one — a persisted player setting (unlike `shuffled` above,
  // which is per-queue), so it lives in App.tsx's settings-backed state
  // rather than usePlayback's own return value. See RepeatMode in
  // usePlayback.ts.
  repeatMode: RepeatMode
  onPause: () => void
  onResume: () => void
  onSeek: (ms: number) => void
  onSetVolume: (value: number) => void
  onNext: () => void
  onPrevious: () => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
}

export function TransportDock({
  status,
  shuffled,
  queueBusy,
  repeatMode,
  onPause,
  onResume,
  onSeek,
  onSetVolume,
  onNext,
  onPrevious,
  onToggleShuffle,
  onCycleRepeat,
}: TransportDockProps) {
  return (
    <Surface
      edges="top-dock"
      className="absolute bottom-0 left-1/2 h-[121px] w-[514px] -translate-x-1/2"
      style={{ zIndex: 10 }}
    >
      <div className="flex h-full flex-col justify-center gap-[14px] px-[26px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[14px]">
            {/* No established toggle language for this glass/signal-color
             * context (Switch.tsx's track-and-thumb is built for the denser
             * settings-panel register, not this dock) — shuffle reads its
             * on/off state the same way the app already marks active vs.
             * inactive elsewhere: signal when on, muted when off. */}
            <button
              type="button"
              disabled={queueBusy}
              onClick={onToggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffled}
              className={`transition-opacity duration-150 hover:opacity-80 disabled:opacity-30 ${
                shuffled ? 'text-[var(--color-signal)]' : 'text-[var(--color-muted)]'
              }`}
            >
              <Icon name="arrow-swap" size={24} />
            </button>

            <button
              type="button"
              disabled={queueBusy}
              onClick={onPrevious}
              aria-label="Previous track"
              className="text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80 disabled:opacity-30"
            >
              <Icon name="reverse" size={24} />
            </button>

            <button
              type="button"
              disabled={queueBusy}
              onClick={status.playing ? onPause : onResume}
              aria-label={status.playing ? 'Pause' : 'Play'}
              className="text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80 disabled:opacity-30"
            >
              <Icon name={status.playing ? 'pause' : 'play'} size={24} />
            </button>

            <button
              type="button"
              disabled={queueBusy}
              onClick={onNext}
              aria-label="Next track"
              className="text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80 disabled:opacity-30"
            >
              <Icon name="fast-forward" size={24} />
            </button>

            {/* Same signal/muted on/off language as shuffle above; repeat-
             * one additionally gets a small "1" badge, since color alone
             * can't distinguish "repeat all" from "repeat one" the way it
             * distinguishes "on" from "off" — see Icon.tsx's `repeat` note. */}
            <button
              type="button"
              disabled={queueBusy}
              onClick={onCycleRepeat}
              aria-label={REPEAT_LABEL[repeatMode]}
              className={`relative transition-opacity duration-150 hover:opacity-80 disabled:opacity-30 ${
                repeatMode === 'off' ? 'text-[var(--color-muted)]' : 'text-[var(--color-signal)]'
              }`}
            >
              <Icon name="repeat" size={24} />
              {repeatMode === 'one' && (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-[4px] -right-[4px] font-[family-name:var(--font-mono)] text-[length:9px] leading-none text-[var(--color-signal)]"
                >
                  1
                </span>
              )}
            </button>
          </div>

          <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {formatTime(status.positionMs)}
            {status.currentDurationMs != null && (
              <span className="text-[var(--color-muted)]"> / {formatTime(status.currentDurationMs)}</span>
            )}
          </span>

          {/* The volume glyph opens a popover holding a vertical Slider —
           * v2's bare-glyph dock (DESIGN.md "v2: the transport dock, not
           * reconciled") answered the gpui-kit way, and the first piece of
           * that redesign to land. The dock itself is still v1's shape.
           * The glyph swaps to volume-mute at zero so the state reads
           * without opening anything. */}
          <Popover
            label="Volume"
            placement="top"
            align="center"
            className="px-[10px] py-[14px]"
            trigger={({ open: _open, ...props }) => (
              <button
                type="button"
                aria-label={`Volume, ${Math.round(status.volume * 100)}%`}
                {...props}
                className="text-[var(--color-signal)] transition-opacity duration-[var(--motion-fast)] hover:opacity-80"
              >
                <Icon name={status.volume === 0 ? 'volume-mute' : 'volume'} size={24} />
              </button>
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

        <WaveformScrubber
          fileId={status.currentFileId}
          positionMs={status.positionMs}
          durationMs={status.currentDurationMs}
          onSeek={onSeek}
        />
      </div>
    </Surface>
  )
}
