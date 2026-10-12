import { useEffect, useMemo, useState } from 'react'
import { useGraph, type GraphData } from '../canvas/graphContext'
import { computeClusters } from '../canvas/clusters'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import type { usePlayback } from '../playback/usePlayback'

/* What a search finds, for both of its surfaces: the desktop's palette and
 * the phone's search (#389). Both ask /search's full-text index for the
 * matches, rank them the same way and take the same top result, so a query
 * finds the same things on either. How each lays the results out, and what
 * it says under a title, is its own.
 *
 * Everything shown about a match beyond its title (covers, artists, albums,
 * durations, counts) comes from the graph the client already holds. Only a
 * record's year needs asking for, and only for the few rows on screen. */

type Hit = { id: number; type: string; title: string }
export type Filter = 'all' | 'artist' | 'release' | 'recording' | 'playlist'
export type Playlist = { id: number; name: string; track_count: number }

/* One row anything in a search can be: a graph node, or a playlist. */
export type Item = { key: string; kind: 'artist' | 'release' | 'recording' | 'credit' | 'playlist'; id: number; title: string }

export type Group = { type: Exclude<Filter, 'all'>; rows: Item[] }

const DEBOUNCE_MS = 120
const SEARCH_LIMIT = 100
export const GROUP_LIMIT: Record<Exclude<Filter, 'all'>, number> = { artist: 3, release: 4, recording: 6, playlist: 3 }
const FILTERED_LIMIT = 40

// Producers and engineers are people too: they search with the artists.
export const filterOf = (kind: Item['kind']): Exclude<Filter, 'all'> => (kind === 'credit' ? 'artist' : kind)

/* The full-text search, debounced, with stale responses dropped. Asked
 * again after an outage (#119), when an answer that failed came back empty. */
function useSearch(query: string): { hits: Hit[] | null; pending: boolean } {
  const [state, setState] = useState<{ query: string; hits: Hit[] } | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(`${API}/search?${new URLSearchParams({ q, limit: String(SEARCH_LIMIT) })}`)
        .then((r) => r.json())
        .then((hits: Hit[]) => !cancelled && setState({ query, hits }))
        .catch(() => !cancelled && setState({ query, hits: [] }))
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, reconnects])
  if (!query.trim()) return { hits: null, pending: false }
  return { hits: state?.hits ?? null, pending: state?.query !== query }
}

function usePlaylists(enabled: boolean): Playlist[] {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    if (!enabled) return
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => undefined)
  }, [reconnects, enabled])
  return playlists
}

export type SearchResults = {
  /** Null until there's a query and an answer to it. */
  hits: Hit[] | null
  /** A newer query than the answer showing is on its way. */
  pending: boolean
  /** Every match, best first: graph nodes, then playlists by name. */
  items: Item[]
  playlists: Playlist[]
}

/** `enabled` false asks for nothing: the phone's search keeps this mounted
 * while it's closed. Opening it again lists the playlists afresh. */
export function useSearchResults(query: string, enabled = true): SearchResults {
  const { hits, pending } = useSearch(enabled ? query : '')
  const playlists = usePlaylists(enabled)
  const items = useMemo(() => {
    if (!hits) return []
    const q = query.trim().toLowerCase()
    const nodeItems: Item[] = hits
      .filter((h) => h.type === 'artist' || h.type === 'release' || h.type === 'recording' || h.type === 'credit')
      .map((h) => ({ key: `n${h.id}`, kind: h.type as Item['kind'], id: h.id, title: h.title }))
    const playlistItems: Item[] = playlists
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ key: `p${p.id}`, kind: 'playlist', id: p.id, title: p.name }))
    return [...nodeItems, ...playlistItems]
  }, [hits, playlists, query])
  return { hits, pending, items, playlists }
}

/** The top result is the best match in view; the groups list the rest, in
 * the order given, each up to its limit. */
export function groupResults(
  items: readonly Item[],
  filter: Filter,
  order: readonly Exclude<Filter, 'all'>[],
): { visible: Item[]; top: Item | null; groups: Group[] } {
  const visible = filter === 'all' ? [...items] : items.filter((item) => filterOf(item.kind) === filter)
  const top = visible[0] ?? null
  const groups = (filter === 'all' ? order : [filter]).map((type) => ({
    type,
    rows: visible
      .filter((item) => item !== top && filterOf(item.kind) === type)
      .slice(0, filter === 'all' ? GROUP_LIMIT[type] : FILTERED_LIMIT),
  }))
  return { visible, top, groups }
}

const NO_YEARS = new Map<number, string | null>()

/* A record's year, from its summary — fetched once per record, cached for
 * the search's life, or until an outage ends (#119): a summary that failed
 * while the server was gone is cached as no year. */
export function useReleaseYears(ids: number[]): Map<number, string | null> {
  const reconnects = useReconnectEpoch()
  const [cache, setCache] = useState({ epoch: reconnects, years: new Map<number, string | null>() })
  const years = cache.epoch === reconnects ? cache.years : NO_YEARS
  const wanted = ids.filter((id) => !years.has(id)).join(',')
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    const list = wanted.split(',').map(Number)
    void Promise.all(
      list.map((id) =>
        fetch(`${API}/nodes/${id}/summary`)
          .then((r) => (r.ok ? r.json() : null))
          .then((s: { releaseDate?: string | null } | null) => [id, s?.releaseDate?.slice(0, 4) ?? null] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return
      setCache((prev) => {
        const next = new Map(prev.epoch === reconnects ? prev.years : NO_YEARS)
        for (const [id, year] of entries) next.set(id, year)
        return { epoch: reconnects, years: next }
      })
    })
    return () => {
      cancelled = true
    }
  }, [wanted, reconnects])
  return years
}

export type SearchRelations = {
  /** A track's record: its first appears_on. */
  releaseOf: Map<number, number>
  /** A record's track count. */
  trackCount: Map<number, number>
  /** An artist's records, by the map's cluster rule. */
  releasesOf: Map<number, number[]>
  /** Each node's artist, by the same rule. */
  clusterOf: Map<number, number>
}

/** What the graph knows that /search doesn't: each record's track count
 * and each track's record, from the edges; each artist's records, from the
 * same cluster logic the map uses. */
export function useSearchRelations(): SearchRelations {
  const graph = useGraph()
  return useMemo(() => {
    const releaseOf = new Map<number, number>()
    const trackCount = new Map<number, number>()
    for (const edge of graph.edges) {
      if (edge.type !== 'appears_on') continue
      if (!releaseOf.has(edge.from_node)) releaseOf.set(edge.from_node, edge.to_node)
      trackCount.set(edge.to_node, (trackCount.get(edge.to_node) ?? 0) + 1)
    }
    const { releasesOf, clusterOf } = computeClusters(graph.nodes, graph.edges)
    return { releaseOf, trackCount, releasesOf, clusterOf }
  }, [graph.nodes, graph.edges])
}

type Playback = ReturnType<typeof usePlayback>

/** Plays a result: a track, a record, a playlist, or an artist's tracks
 * (those the map files under them). A producer has no one thing to play. */
export function playItem(item: Item, playback: Playback, graph: GraphData, relations: SearchRelations) {
  if (item.kind === 'recording') void playback.playNode(item.id, item.title)
  else if (item.kind === 'release') void playback.playAlbum(item.id)
  else if (item.kind === 'playlist') void playback.playPlaylist(item.id)
  else if (item.kind === 'artist') {
    const tracks = graph.nodes.filter((n) => n.type === 'recording' && relations.clusterOf.get(n.id) === item.id).map((n) => n.id)
    if (tracks.length) void playback.playTracks(tracks, 0, '')
  }
}

/** Adds the track, or each of a record's tracks in order, after whatever is
 * already queued. Anything else has no single thing to queue. */
export async function enqueueItem(item: Pick<Item, 'kind' | 'id'>, playback: Playback) {
  if (item.kind === 'recording') await playback.addToQueue(item.id)
  else if (item.kind === 'release') {
    const tracks = (await fetch(`${API}/nodes/${item.id}/tracklist`).then((r) => r.json())) as { id: number }[]
    for (const track of tracks) await playback.addToQueue(track.id)
  }
}
