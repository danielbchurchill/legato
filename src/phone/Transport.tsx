import { IconButton } from '../ui/IconButton'
import { PlayCircle } from '../ui/PlayCircle'
import type { RepeatMode, usePlayback } from '../playback/usePlayback'

/* The phone's full transport (#389, Legato Mobile v2): shuffle, previous,
 * play/pause on the accent gradient, next, repeat, spread across the width.
 * Up next draws it at 44 / 52 / 64 / 52 / 44 and Now playing at 48 / 56 /
 * 76 / 56 / 48, with the handoff's glyph sizes in each.
 *
 * Shuffle and repeat sit in ink-2 and turn the accent while they're on.
 * Repeat-one adds a "1" to the glyph, as the desktop player's does: on or
 * off is the colour, but all and one need a mark of their own. The same
 * playback state as every other player, so it drives the stream in a
 * browser and the native player alike. */

type Playback = ReturnType<typeof usePlayback>

const SIZES = {
  sheet: { side: 44, sideIcon: 20, skip: 52, skipIcon: 26, play: 64, playIcon: 26 },
  full: { side: 48, sideIcon: 22, skip: 56, skipIcon: 30, play: 76, playIcon: 30 },
} as const

const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat all tracks',
  one: 'Repeat current track',
}

type TransportProps = {
  playback: Playback
  repeatMode: RepeatMode
  onCycleRepeat: () => void
  size: keyof typeof SIZES
  className?: string
}

export function Transport({ playback, repeatMode, onCycleRepeat, size, className = '' }: TransportProps) {
  const s = SIZES[size]
  const { status, problem, queueBusy, shuffled } = playback
  const playing = status.playing
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <IconButton
        icon="arrow-swap"
        label={shuffled ? 'Shuffle on' : 'Shuffle off'}
        aria-pressed={shuffled}
        size={s.side}
        iconSize={s.sideIcon}
        tone={shuffled ? 'accent' : 'ink-2'}
        tooltip={false}
        disabled={queueBusy}
        onClick={() => void playback.toggleShuffle()}
      />
      <IconButton
        icon="reverse"
        label="Previous track"
        size={s.skip}
        iconSize={s.skipIcon}
        tone="ink"
        tooltip={false}
        disabled={queueBusy}
        onClick={() => void playback.previous()}
      />
      <PlayCircle
        size={s.play}
        iconSize={s.playIcon}
        playing={playing}
        label={problem ? (problem.action === 'retry' ? 'Try again' : 'Skip track') : playing ? 'Pause' : 'Play'}
        disabled={queueBusy}
        onClick={problem ? () => void playback.resolveProblem() : playing ? playback.pause : playback.resume}
      />
      <IconButton
        icon="fast-forward"
        label="Next track"
        size={s.skip}
        iconSize={s.skipIcon}
        tone="ink"
        tooltip={false}
        disabled={queueBusy}
        onClick={() => void playback.next()}
      />
      <span className="relative inline-flex">
        <IconButton
          icon="repeat"
          label={REPEAT_LABEL[repeatMode]}
          size={s.side}
          iconSize={s.sideIcon}
          tone={repeatMode === 'off' ? 'ink-2' : 'accent'}
          tooltip={false}
          disabled={queueBusy}
          onClick={onCycleRepeat}
        />
        {repeatMode === 'one' && (
          <span
            aria-hidden="true"
            className="mono pointer-events-none absolute right-[8px] bottom-[6px] text-[11px] leading-none text-[var(--color-accent)]"
          >
            1
          </span>
        )}
      </span>
    </div>
  )
}
