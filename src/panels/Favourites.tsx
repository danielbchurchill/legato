import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { Tooltip } from '../ui/Tooltip'
import { SERVER_HOST } from '../config/serverHost'
import { PlayNodeButton } from './PlayNodeButton'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import type { usePlayback } from '../playback/usePlayback'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* The Favourites rail destination: a flat, recency-ordered list of every
 * node the heart in NodeTitleBlock.tsx has been clicked on. Deliberately not
 * grouped by type — grouping would bury "I just favourited this" under a
 * type heading, defeating the one thing recency ordering is for. See
 * Legato-Stage-Four-Rail-Gaps.md "1. Favourites" for why this is neither a
 * playlist nor a "top played" view. */

type FavouriteItem = { id: number; type: string; title: string }

// The API's node.type values, mapped to the short tag the row shows —
// same distinction DESIGN.md's card-row table makes for these three types.
const TYPE_LABEL: Record<string, string> = {
  recording: 'track',
  release: 'album',
  artist: 'artist',
}

type Playback = Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum'>

function FavouriteRow({
  item,
  onSelectNode,
  onRemove,
  playback,
}: {
  item: FavouriteItem
  onSelectNode: (id: number) => void
  onRemove: (id: number) => void
  playback: Playback
}) {
  return (
    <div className="flex items-center gap-[12px] border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
      <div className="h-[75px] w-[75px] shrink-0">
        <CoverArt nodeId={item.id} size="thumb" alt={item.title} className="aspect-square w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onSelectNode(item.id)}
          className="block w-full truncate text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          {item.title}
        </button>
        <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          {TYPE_LABEL[item.type] ?? item.type}
        </span>
      </div>
      <PlayNodeButton id={item.id} type={item.type} title={item.title} playback={playback} />
      {item.type === 'recording' && <AddToPlaylistButton nodeId={item.id} />}
      <Tooltip label="Remove from favourites">
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label="Remove from favourites"
          className="shrink-0 text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          <Icon name="heart" size={24} filled />
        </button>
      </Tooltip>
    </div>
  )
}

export function Favourites({ onSelectNode, playback }: { onSelectNode: (id: number) => void; playback: Playback }) {
  const [items, setItems] = useState<FavouriteItem[] | null>(null)

  const load = useCallback(() => {
    fetch(`${API}/favourites`)
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(load, [load])
  useWsEvent(['favourites:changed'], load)

  // Removes without navigating away and without waiting on the refetch —
  // same "act without leaving the list" pattern HygieneView's worklist rows
  // use for merge/keep-separate.
  const remove = async (id: number) => {
    setItems((prev) => (prev ?? []).filter((item) => item.id !== id))
    await fetch(`${API}/favourites/${id}`, { method: 'DELETE' })
  }

  if (items === null) {
    return <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
  }

  if (items.length === 0) {
    return (
      <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">
        Nothing favourited yet — click the heart on any track, album, or artist to add it here.
      </p>
    )
  }

  return (
    <div>
      {items.map((item) => (
        <FavouriteRow key={item.id} item={item} onSelectNode={onSelectNode} onRemove={remove} playback={playback} />
      ))}
    </div>
  )
}
