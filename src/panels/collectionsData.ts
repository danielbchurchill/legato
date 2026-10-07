import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { API_BASE as API } from '../config/serverHost'

/* The data behind Collections: the playlists, one playlist's tracks, and
 * the favourites — each kept live by the server's own change events, so a
 * favourite added from the map or a track added from the search palette
 * shows up here without a refresh. */

export type PlaylistSummary = { id: number; name: string; track_count: number }
export type PlaylistTrack = { id: number; title: string; canonical_duration_ms: number | null; position: number; playlist_track_id: number }
export type Favourite = { id: number; type: string; title: string }

export function usePlaylists(): { playlists: PlaylistSummary[] | null; reload: () => void } {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null)
  const reload = useCallback(() => {
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [])
  useEffect(reload, [reload])
  useWsEvent(['playlist:changed', 'playlist:tracks-changed'], reload)
  return { playlists, reload }
}

export function usePlaylistTracks(playlistId: number): { tracks: PlaylistTrack[] | null; setTracks: (tracks: PlaylistTrack[]) => void } {
  const [state, setState] = useState<{ playlistId: number; tracks: PlaylistTrack[] } | null>(null)
  const load = useCallback(() => {
    fetch(`${API}/playlists/${playlistId}/tracks`)
      .then((r) => r.json())
      .then((tracks: PlaylistTrack[]) => setState({ playlistId, tracks }))
      .catch(() => setState({ playlistId, tracks: [] }))
  }, [playlistId])
  useEffect(load, [load])
  useWsEvent(['playlist:tracks-changed'], (payload) => {
    if ((payload as { playlistId?: number } | undefined)?.playlistId === playlistId) load()
  })
  return {
    tracks: state?.playlistId === playlistId ? state.tracks : null,
    setTracks: (tracks) => setState({ playlistId, tracks }),
  }
}

export function useFavourites(): Favourite[] | null {
  const [favourites, setFavourites] = useState<Favourite[] | null>(null)
  const load = useCallback(() => {
    fetch(`${API}/favourites`)
      .then((r) => r.json())
      .then(setFavourites)
      .catch(() => setFavourites([]))
  }, [])
  useEffect(load, [load])
  useWsEvent(['favourites:changed'], load)
  return favourites
}

export function totalDuration(tracks: PlaylistTrack[]): number {
  return tracks.reduce((sum, t) => sum + (t.canonical_duration_ms ?? 0), 0)
}

export async function createPlaylist(name: string): Promise<PlaylistSummary> {
  const res = await fetch(`${API}/playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json()
}
