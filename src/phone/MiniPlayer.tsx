import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { PlayCircle } from '../ui/PlayCircle'
import { formatDuration } from '../ui/format'
import type { usePlayback } from '../playback/usePlayback'
import { usePlayingTrack } from './usePlayingTrack'

/* The mini player (#389, Legato Mobile v2 "Mini player row"): the sheet's
 * header at peek. The cover, the title over "artist · album" on one line,
 * play/pause on the accent gradient, next, and a 3px progress bar under it.
 * At large it compresses to a 40px cover, the title over the artist, and
 * pause alone, as the handoff's library frame draws it.
 *
 * It reads the same playback state the desktop's player does, so it drives
 * the native player in the desktop app and the stream in a browser alike.
 * With nothing loaded it says what the desktop's idle pill says, "Nothing
 * playing" and Shuffle library, in the same row.
 *
 * Tapping the cover opens Now playing (screen 7); dragging the row up opens
 * up next (PhoneShell). */

type Playback = ReturnType<typeof usePlayback>

type MiniPlayerProps = {
  playback: Playback
  /** The artist the map's graph names, until the track's details arrive. */
  artist: string | null
  compact: boolean
  /** Whether there's anything to shuffle: hidden on the desktop while the
   * map is empty or the server can't be reached. */
  canShuffle: boolean
  onShuffleLibrary: () => void
  onOpenNowPlaying: () => void
}

export function MiniPlayer({ playback, artist, compact, canShuffle, onShuffleLibrary, onOpenNowPlaying }: MiniPlayerProps) {
  const { status, currentTitle, problem, queueBusy } = playback
  const { nodeId, artist: artistName, album } = usePlayingTrack(playback, artist)

  if (currentTitle == null) {
    return (
      <div role="region" aria-label="Player">
        <Row columns={compact ? 'grid-cols-[40px_minmax(0,1fr)_auto]' : 'grid-cols-[48px_minmax(0,1fr)_auto]'}>
          <span aria-hidden="true" className="aspect-square w-full rounded-[var(--radius-art)] bg-[var(--color-wash-2)]" />
          <span className={`truncate text-[var(--color-ink-2)] ${compact ? 'text-body font-medium' : 'text-heading'}`}>
            Nothing playing
          </span>
          {/* 36px, as the idle pill's own button, inside a 44px target. */}
          <Button
            variant="primary"
            icon="arrow-swap"
            size="lg"
            onClick={onShuffleLibrary}
            disabled={queueBusy || !canShuffle}
            className="relative before:absolute before:inset-x-0 before:-inset-y-[4px] before:content-['']"
          >
            Shuffle library
          </Button>
        </Row>
        {!compact && <Progress positionMs={0} durationMs={null} />}
      </div>
    )
  }

  const subtitle = compact ? artistName : [artistName, album].filter(Boolean).join(' · ')
  const playing = status.playing

  return (
    <div role="region" aria-label="Player">
      <Row columns={compact ? 'grid-cols-[40px_minmax(0,1fr)_44px]' : 'grid-cols-[48px_minmax(0,1fr)_44px_44px]'}>
        {/* The 40px cover takes taps across 44px. */}
        <button
          type="button"
          aria-label="Open now playing"
          onClick={onOpenNowPlaying}
          className={`flex ${compact ? 'touch-target rounded-[5px]' : 'rounded-[var(--radius-art)]'}`}
        >
          <CoverArt
            nodeId={nodeId}
            size="thumb"
            alt=""
            radius={compact ? 'none' : 'art'}
            className={compact ? 'rounded-[5px]' : ''}
            style={{ width: compact ? 40 : 48, height: compact ? 40 : 48 }}
          />
        </button>
        <div className="flex min-w-0 flex-col">
          <span title={currentTitle} className={`truncate text-[var(--color-ink)] ${compact ? 'text-body font-medium' : 'text-heading'}`}>
            {currentTitle}
          </span>
          {problem ? (
            // Why the last start didn't play (#184), where the artist was:
            // the play button below is the one action that fixes it.
            <span role="alert" title={`${problem.headline}. ${problem.detail}`} className="truncate text-small text-[var(--color-ink-2)]">
              {problem.headline}
            </span>
          ) : (
            <span
              title={subtitle || undefined}
              className={`truncate text-[var(--color-ink-2)] ${compact ? 'text-small' : 'text-secondary'}`}
            >
              {subtitle}
            </span>
          )}
        </div>
        {compact ? (
          <IconButton
            icon={playing ? 'pause' : 'play'}
            filled
            label={playing ? 'Pause' : 'Play'}
            size={44}
            iconSize={20}
            tone="ink"
            tooltip={false}
            disabled={queueBusy}
            onClick={playing ? playback.pause : playback.resume}
          />
        ) : (
          <>
            <PlayCircle
              size={44}
              playing={playing}
              label={problem ? (problem.action === 'retry' ? 'Try again' : 'Skip track') : playing ? 'Pause' : 'Play'}
              disabled={queueBusy}
              onClick={problem ? () => void playback.resolveProblem() : playing ? playback.pause : playback.resume}
            />
            <IconButton
              icon="fast-forward"
              filled
              label="Next track"
              size={44}
              iconSize={22}
              tone="ink"
              tooltip={false}
              disabled={queueBusy}
              onClick={playback.next}
            />
          </>
        )}
      </Row>
      {!compact && <Progress positionMs={status.positionMs} durationMs={status.currentDurationMs} />}
    </div>
  )
}

/* The row's grid: the cover, the words, then the controls. The handoff
 * pads it 16px on the left and 12px on the right, so the 44px buttons'
 * glyphs sit level with the progress bar's 16px inset. */
function Row({ columns, children }: { columns: string; children: ReactNode }) {
  return <div className={`grid items-center gap-[12px] pr-[12px] pl-[16px] ${columns}`}>{children}</div>
}

/* Where the track is, 3px tall. Live data, so it steps rather than eases
 * (DESIGN.md Motion), which is why it isn't the ui Progress bar. Seeking is
 * up next's transport, not this. */
function Progress({ positionMs, durationMs }: { positionMs: number; durationMs: number | null }) {
  const fraction = durationMs != null && durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0
  return (
    <div
      role="progressbar"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={durationMs ?? 0}
      aria-valuenow={positionMs}
      aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(durationMs)}`}
      className="mx-[16px] mt-[12px] h-[3px] overflow-hidden rounded-full bg-[var(--color-wash-2)]"
    >
      <div className="h-full bg-[image:var(--accent-fill)]" style={{ width: `${fraction * 100}%` }} />
    </div>
  )
}
