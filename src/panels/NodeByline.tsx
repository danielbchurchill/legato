/* The line under a node's title in its article header: who it's by, and
 * for a track the album it's on, "Artist · Album" (#451). Each name is a link
 * that opens its node, as the now playing panel's line is: the artist in ink,
 * underlined on hover, the album in ink-2, stepping to ink. The desktop's
 * details panel and the phone's node detail share it.
 *
 * It stays one line, and each name truncates on its own rather than the line
 * ending in one ellipsis that could hide the album whole. The album gives way
 * first: the artist keeps its whole name up to 70% of the line, and the
 * album, usually the longer of the two, truncates in what's left. An artist
 * long enough to reach 70% truncates too, so the album always keeps a start
 * to read and click. In the phone's sheet each link takes taps across
 * 44px (`touch-target`), and a button that clipped its own overflow would clip
 * that box too, so the names truncate inside their buttons. */

type NodeBylineProps = {
  artistName: string | null
  artistId: number | null
  albumName?: string | null
  albumId?: number | null
  onOpenNode: (id: number) => void
  /** Drawn in the phone's sheet: 44px targets, and no hover. */
  sheet?: boolean
}

export function NodeByline({ artistName, artistId, albumName = null, albumId = null, onOpenNode, sheet = false }: NodeBylineProps) {
  if (!artistName && !albumName) return null
  return (
    <p className="flex min-w-0 text-[length:var(--text-body)] leading-[20px]">
      {artistName && (
        <BylineLink
          name={artistName}
          id={artistId}
          onOpenNode={onOpenNode}
          sheet={sheet}
          className={`shrink-0 font-medium text-[var(--color-ink)] ${albumName ? 'max-w-[70%]' : 'max-w-full'}`}
          hover="hover:underline"
        />
      )}
      {artistName && albumName && (
        <span aria-hidden="true" className="shrink-0 whitespace-pre text-[var(--color-ink-2)]">
          {' · '}
        </span>
      )}
      {albumName && (
        <BylineLink
          name={albumName}
          id={albumId}
          onOpenNode={onOpenNode}
          sheet={sheet}
          className="text-[var(--color-ink-2)]"
          hover="hover:text-[var(--color-ink)]"
        />
      )}
    </p>
  )
}

function BylineLink({
  name,
  id,
  onOpenNode,
  sheet,
  className,
  hover,
}: {
  name: string
  id: number | null
  onOpenNode: (id: number) => void
  sheet: boolean
  className: string
  hover: string
}) {
  const text = <span className="block truncate">{name}</span>
  // A name with no node behind it (an artist only the graph's subtitle
  // knows) stays text.
  if (id == null) {
    return (
      <span title={name} className={`min-w-0 ${className}`}>
        {text}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={name}
      onClick={() => onOpenNode(id)}
      className={`min-w-0 text-left ${sheet ? 'touch-target' : hover} ${className}`}
    >
      {text}
    </button>
  )
}
