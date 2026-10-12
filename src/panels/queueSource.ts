import { useEffect, useState } from 'react'
import { useReconnectEpoch } from '../connect/reconnect'
import type { QueueSource } from '../playback/usePlayback'
import { API } from './useNodeDetail'

/* "Playing from …": where the queue came from, in words. The desktop's up
 * next says it, and so do the phone's up next and Now playing. */

/** An album's title, a playlist's name or the shuffled library, or null
 * when the queue came from nowhere in particular. */
export function sourceLabel(source: QueueSource | null, albumTitle: string | null, playlistNames: Map<number, string>): string | null {
  if (source == null) return null
  if (source.kind === 'library') return 'your library, shuffled'
  if (source.kind === 'playlist') return playlistNames.get(source.playlistId) ?? 'a playlist'
  return albumTitle
}

/** The playlists' names, fetched once a queue comes from one. */
export function usePlaylistName(source: QueueSource | null): Map<number, string> {
  const [names, setNames] = useState(new Map<number, string>())
  const playlistId = source?.kind === 'playlist' ? source.playlistId : null
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    if (playlistId == null || names.has(playlistId)) return
    let cancelled = false
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then((list: { id: number; name: string }[]) => {
        if (!cancelled) setNames(new Map(list.map((p) => [p.id, p.name])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [playlistId, names, reconnects])
  return names
}
