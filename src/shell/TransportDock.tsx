import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { PlaybackStatus } from '../playback/usePlayback'
import { Surface } from './Surface'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

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
  // True while a previous/next/shuffle click (or a reorder/remove/add
  // elsewhere, e.g. NowPlayingPanel's up-next list) is still resolving —
  // usePlayback.ts serializes all of them behind one shared lock, so a
  // click on any of these while another is in flight gets queued rather
  // than lost. Disabling here just makes that visible instead of leaving
  // the dock looking inert for however long the in-flight one takes.
  queueBusy: boolean
  onPause: () => void
  onResume: () => void
  onSeek: (ms: number) => void
  onSetVolume: (value: number) => void
  onNext: () => void
  onPrevious: () => void
  onToggleShuffle: () => void
}

export function TransportDock({
  status,
  shuffled,
  queueBusy,
  onPause,
  onResume,
  onSeek,
  onSetVolume,
  onNext,
  onPrevious,
  onToggleShuffle,
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
             * context (Toggle.tsx's knob-and-track is built for the denser
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
          </div>

          <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {formatTime(status.positionMs)}
            {status.currentDurationMs != null && (
              <span className="text-[var(--color-muted)]"> / {formatTime(status.currentDurationMs)}</span>
            )}
          </span>

          <div className="flex items-center gap-[8px]">
            <Icon name="volume" size={24} className="text-[var(--color-signal)]" />
            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.01}
              value={status.volume}
              onChange={(e) => onSetVolume(Number(e.target.value))}
              className="h-[4px] w-[64px] accent-[var(--color-signal)]"
            />
          </div>
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
