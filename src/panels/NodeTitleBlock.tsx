import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { SERVER_HOST } from '../config/serverHost'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import type { NodeDetail } from './useNodeDetail'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* P-7: the mockup's title block is three centred lines — title, album,
 * artist — not two left-aligned lines joined by an em dash. Non-recording
 * nodes have no album/artist edges, so they fall back to a centred type
 * label.
 *
 * Shared by the now-playing panel and the inspector modal: the same node has
 * to be named the same way whichever surface is showing it. Also the one
 * insertion point for the Favourites heart (see Legato-Stage-Four-Rail-Gaps.md
 * "1. Favourites") — the only component rendered identically for all three
 * favouritable node types across both surfaces a node is actually looked at. */
export function NodeTitleBlock({ node }: { node: NodeDetail }) {
  const artist = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const album = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')

  // Optimistic — flips the instant the heart is clicked rather than waiting
  // on the POST/DELETE round trip (DESIGN.md "Acknowledge under 100ms").
  // Resyncs from server truth whenever a fresh node arrives: a new
  // selection, or useNodeDetail's own favourites:changed listener
  // correcting a request that failed silently.
  const [isFavourite, setIsFavourite] = useState(node.is_favourite)
  useEffect(() => setIsFavourite(node.is_favourite), [node.id, node.is_favourite])

  const toggleFavourite = () => {
    const next = !isFavourite
    setIsFavourite(next)
    fetch(`${API}/favourites/${node.id}`, { method: next ? 'POST' : 'DELETE' }).catch(() => setIsFavourite(!next))
  }

  const favouriteLabel = isFavourite ? 'Remove from favourites' : 'Add to favourites'

  return (
    <div className="mt-[12px] flex flex-col items-center gap-[2px] text-center">
      <div className="flex w-full items-center justify-center gap-[8px]">
        {/* Balances the button(s) on the other side so the title stays
         * visually centred rather than skewing toward the empty edge — a
         * recording node gets a second (add-to-playlist) button next to the
         * heart, so its spacer is wider than every other node type's. */}
        <span aria-hidden className={`shrink-0 ${node.type === 'recording' ? 'w-[56px]' : 'w-[24px]'}`} />
        <ScrollingText
          text={node.title}
          className="min-w-0 flex-1 font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]"
        />
        <Tooltip label={favouriteLabel}>
          <button
            type="button"
            onClick={toggleFavourite}
            aria-label={favouriteLabel}
            className={`shrink-0 transition-colors duration-[var(--motion-fast)] ${
              isFavourite ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            <Icon name="heart" size={24} filled={isFavourite} />
          </button>
        </Tooltip>
        {node.type === 'recording' && <AddToPlaylistButton nodeId={node.id} />}
      </div>
      {node.type === 'recording' ? (
        <>
          {album && (
            <ScrollingText
              text={album.other_title}
              className="w-full font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]"
            />
          )}
          {artist && (
            <ScrollingText
              text={artist.other_title}
              className="w-full font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]"
            />
          )}
        </>
      ) : (
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{node.type}</p>
      )}
    </div>
  )
}
