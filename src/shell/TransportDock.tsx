import { Icon } from '../ui/Icon'
import type { PlaybackStatus } from '../playback/usePlayback'
import { Surface } from './Surface'

/* The transport, docked to the window's bottom edge.
 *
 * Session 6 replaces the middle of this with the real waveform scrubber — that
 * needs a precomputed peak envelope per track, cached by file hash, which does
 * not exist yet. Until then the same space carries an honest progress line, so
 * the dock is correctly placed and sized rather than absent.
 *
 * Note the transport is present whether or not anything is playing: it is
 * structural chrome, not a notification. With no track it simply reads 00:00
 * and its controls are inert. */

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

type TransportDockProps = {
  status: PlaybackStatus
  hasTrack: boolean
  onPause: () => void
  onResume: () => void
}

export function TransportDock({ status, hasTrack, onPause, onResume }: TransportDockProps) {
  return (
    <Surface
      edges="top-dock"
      className="absolute bottom-0 left-1/2 h-[121px] w-[514px] -translate-x-1/2"
      style={{ zIndex: 10 }}
    >
      <div className="flex h-full flex-col justify-center gap-[14px] px-[26px]">
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={!hasTrack}
            onClick={status.playing ? onPause : onResume}
            aria-label={status.playing ? 'Pause' : 'Play'}
            className="text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80 disabled:opacity-30"
          >
            <Icon name={status.playing ? 'pause' : 'play'} size={24} />
          </button>

          <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {formatTime(status.positionMs)}
          </span>

          <button
            type="button"
            aria-label="Volume"
            className="text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80"
          >
            <Icon name="volume" size={24} />
          </button>
        </div>

        {/* Placeholder for the waveform. Deliberately a flat line rather than a
         * fake waveform: a decorative one would look finished and quietly
         * misreport the audio. */}
        <div className="h-[2px] w-full rounded-full bg-[var(--color-signal)] opacity-25" />
      </div>
    </Surface>
  )
}
