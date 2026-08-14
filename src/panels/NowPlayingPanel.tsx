import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { DataRow, SectionHeader } from '../ui/DataRow'
import type { PlaybackStatus } from '../playback/usePlayback'

/* The right-hand panel's now-playing mode.
 *
 * Only the fields with a real source are rendered. bpm, record label, release
 * date and release type all live in the file tags and are simply not read yet
 * (session 3); the Tidal rows the mockup shows were cut. Showing them as empty
 * placeholders would make the panel look broken rather than unfinished, so
 * they are absent until they have data behind them.
 *
 * Pagination — lyrics and article pages, the three dots — is session 7. */

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export type NowPlayingTrack = {
  nodeId: number
  title: string
  durationMs: number | null
}

type NowPlayingPanelProps = {
  track: NowPlayingTrack | null
  status: PlaybackStatus
}

export function NowPlayingPanel({ track, status }: NowPlayingPanelProps) {
  if (!track) {
    return (
      <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
        nothing playing
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <CoverArt
        nodeId={track.nodeId}
        size="full"
        alt={`Cover art for ${track.title}`}
        className="aspect-square w-full"
      />

      <p className="mt-[12px] truncate text-center font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
        {track.title}
      </p>

      <SectionHeader
        title="metadata"
        action={
          <button
            type="button"
            aria-label="Edit metadata"
            title="Edit metadata"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
          >
            <Icon name="pencil" size={24} />
          </button>
        }
      />

      <div className="mt-[8px]">
        <DataRow label="length" value={formatDuration(track.durationMs)} />
        <DataRow label="elapsed" value={formatDuration(status.positionMs)} />
      </div>
    </div>
  )
}
