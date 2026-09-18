import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import type { usePlayback } from '../playback/usePlayback'

/* Click-to-play, in one place rather than three: Favourites.tsx rows,
 * CollectionPanel.tsx search results, and NodeCard.tsx (the canvas selection
 * card) all need the exact same decision — a recording plays itself, a
 * release plays as an album, anything else (artist, label, work, credit)
 * has no single audio stream to start, so the button doesn't render at all
 * rather than being shown disabled. */

type Playback = Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum' | 'queueBusy'>

export function PlayNodeButton({
  id,
  type,
  title,
  playback,
  size = 24,
  className = '',
}: {
  id: number
  type: string
  title: string
  playback: Playback
  size?: number
  className?: string
}) {
  if (type !== 'recording' && type !== 'release') return null

  const play = () => (type === 'release' ? playback.playAlbum(id) : playback.playNode(id, title))

  return (
    <Tooltip label="Play">
      <button
        type="button"
        onClick={play}
        // #81: playNode/playAlbum both funnel into usePlayback's serialized
        // playTracks — disabling here mirrors TransportDock's own play/pause
        // guard so a click while another queue operation is mid-flight reads
        // as "queued, wait a beat" rather than inviting a redundant second
        // click that just queues another full rebuild behind the first.
        disabled={playback.queueBusy}
        aria-label="Play"
        className={`shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-40 ${className}`}
      >
        <Icon name="play" size={size} />
      </button>
    </Tooltip>
  )
}
