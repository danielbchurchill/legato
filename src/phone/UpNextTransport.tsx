import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { useFavourite } from '../panels/useFavourite'
import type { NodeDetail } from '../panels/useNodeDetail'
import type { RepeatMode, usePlayback } from '../playback/usePlayback'
import { Scrubber } from './Scrubber'
import { Transport } from './Transport'
import type { PlayingTrack } from './usePlayingTrack'

/* Up next's full controls (#389, Legato Mobile v2 screen 6): the sheet's
 * header in place of the mini player while the up next tab is open above
 * peek. A 64px cover with the title (17/500) over the artist (14) and the
 * heart, then the scrubber, then the transport at 44 / 52 / 64 / 52 / 44.
 *
 * The cover opens Now playing, as the mini player's does. The sheet behind
 * picks up the cover's colour (PhoneShell), as the handoff's frame does. */

type Playback = ReturnType<typeof usePlayback>

type UpNextTransportProps = {
  playback: Playback
  track: PlayingTrack
  repeatMode: RepeatMode
  onCycleRepeat: () => void
  onOpenNowPlaying: () => void
}

export function UpNextTransport({ playback, track, repeatMode, onCycleRepeat, onOpenNowPlaying }: UpNextTransportProps) {
  const { status, currentTitle, problem } = playback
  return (
    <div role="region" aria-label="Player" className="px-[20px] pt-[2px]">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_44px] items-center gap-[14px]">
        <button
          type="button"
          aria-label="Open now playing"
          onClick={onOpenNowPlaying}
          className="flex rounded-[8px] shadow-[var(--shadow-sm)]"
        >
          <CoverArt nodeId={track.nodeId} size="thumb" alt="" radius="none" className="size-[64px] rounded-[8px]" />
        </button>
        <div className="flex min-w-0 flex-col">
          <span title={currentTitle ?? undefined} className="truncate text-[17px] leading-[22px] font-medium text-[var(--color-ink)]">
            {currentTitle}
          </span>
          {problem ? (
            // Why the last start didn't play (#184), where the artist was,
            // as the mini player says it.
            <span role="alert" title={`${problem.headline}. ${problem.detail}`} className="truncate text-body text-[var(--color-ink-2)]">
              {problem.headline}
            </span>
          ) : (
            <span title={track.artist ?? undefined} className="truncate text-body text-[var(--color-ink-2)]">
              {track.artist}
            </span>
          )}
        </div>
        <FavouriteButton detail={track.detail} />
      </div>
      <Scrubber className="mt-[18px]" positionMs={status.positionMs} durationMs={status.currentDurationMs} onSeek={playback.seek} />
      <Transport className="mt-[6px] px-[4px]" size="sheet" playback={playback} repeatMode={repeatMode} onCycleRepeat={onCycleRepeat} />
    </div>
  )
}

/** The heart for the track playing, 44px. Up next draws it as a ghost and
 * Now playing on a round wash. Until the track's details arrive there's
 * nothing to favourite, so it holds the place, disabled. */
export function FavouriteButton({ detail, round = false }: { detail: NodeDetail | null; round?: boolean }) {
  if (detail == null) {
    return (
      <IconButton
        icon="heart"
        label="Add to favourites"
        size={44}
        iconSize={21}
        tone="ink"
        round={round}
        tooltip={false}
        className={round ? 'bg-[var(--color-wash-2)]' : ''}
        disabled
      />
    )
  }
  return <Heart key={detail.id} detail={detail} round={round} />
}

function Heart({ detail, round }: { detail: NodeDetail; round: boolean }) {
  const [isFavourite, toggle] = useFavourite(detail.id, detail.is_favourite)
  return (
    <IconButton
      icon="heart"
      filled={isFavourite}
      label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
      aria-pressed={isFavourite}
      size={44}
      iconSize={21}
      tone="ink"
      round={round}
      tooltip={false}
      className={round ? 'bg-[var(--color-wash-2)]' : ''}
      onClick={toggle}
    />
  )
}
