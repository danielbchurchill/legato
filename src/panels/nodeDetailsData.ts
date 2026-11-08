import { useEffect, useState } from 'react'
import { useGraph } from '../canvas/graphContext'
import { useReconnectEpoch } from '../connect/reconnect'
import type { DetailsTab } from '../shell/panels'
import type { QueueSource, usePlayback } from '../playback/usePlayback'
import { API, release, useNodeDetail, type NodeDetail } from './useNodeDetail'

/* What both node-detail surfaces read about a node: the desktop's details
 * panel (NodeDetails.tsx) and the phone's sheet (#389, phone/PhoneNode.tsx).
 * They ask the same endpoints, GET /nodes/:id and its summary, tracklist
 * and credits, and must never disagree about a node. */

type Playback = ReturnType<typeof usePlayback>

export type TracklistEntry = { id: number; title: string; track_no: number | null; canonical_duration_ms: number | null }
export type Summary =
  | { kind: 'artist'; releases: number; tracks: number }
  | { kind: 'release'; tracks: number; totalDurationMs: number; releaseDate: string | null }
  | { kind: 'recording'; trackNo: number | null; durationMs: number | null; releaseDate: string | null }
  | { kind: 'other' }

export const TYPE_WORD: Record<string, string> = { artist: 'artist', release: 'album', recording: 'track', credit: 'producer' }

// `version` refetches the same path when it changes: the Metadata tab passes
// the node, which is a new object after every reload, and the rest of the
// details a count of reloads. What the path showed stays until the new
// answer comes, so a reload, such as the one a tag write ends with (#464),
// doesn't blank it.
// Each loads again after an outage (#119), keeping what it showed until then.
export function useJson<T>(path: string | null, version?: unknown): T | null {
  const [state, setState] = useState<{ path: string; version: unknown; value: T | null } | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    if (!path) return
    let cancelled = false
    fetch(`${API}${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((value: T | null) => !cancelled && setState({ path, version, value }))
      .catch(() => !cancelled && setState({ path, version, value: null }))
    return () => {
      cancelled = true
    }
  }, [path, version, reconnects])
  return state && state.path === path ? state.value : null
}

export function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/* Who made a node and what it's made of, from GET /nodes/:id/credits
 * (server/src/nodeCredits.ts): a record's tracks, an artist's tracks, or a
 * track itself, and everyone credited on them with how many tracks each is
 * on. Names come with it. The map's graph only has nodes with a position,
 * and most performer and mixing credits have none, so looking names up
 * there showed them as "?". */
export type CreditedPerson = { id: number; title: string; type: string; role: string; count: number }
export type NodeCredits = { tracks: number[]; people: CreditedPerson[] }
const NO_CREDITS: NodeCredits = { tracks: [], people: [] }

/** One node as both node-detail surfaces show it, the desktop's panel and
 * the phone's sheet, from the same endpoints: the node, its summary, a
 * record's tracklist and everyone credited. Null until the node has
 * loaded. */
export type NodeDetailsData = {
  node: NodeDetail
  reload: () => void
  summary: Summary | null
  tracklist: TracklistEntry[] | null
  credits: NodeCredits
  /** "album · 1965": the kind of thing it is, and its year. */
  kindLine: string
  /** Who it's by, and their node, for anything but an artist. */
  artistName: string | null
  artistId: number | null
  /** The album a track is on, and its node (#451). Null for anything but a
   * track. */
  albumName: string | null
  albumId: number | null
  canPlay: boolean
  canShuffle: boolean
  play: () => void
  shuffle: () => void
  tabs: readonly { value: DetailsTab; label: string }[]
}

export function useNodeDetails(nodeId: number | null, playback: Playback): NodeDetailsData | null {
  const { node, reload } = useNodeDetail(nodeId)
  const graph = useGraph()
  // A reload, such as the one a tag write ends with (#464), fetches these
  // again too: a renamed track's title, an album's count once a file it
  // couldn't write has left it.
  const [reloads, setReloads] = useState(0)
  const summary = useJson<Summary>(nodeId != null ? `/nodes/${nodeId}/summary` : null, reloads)
  const releaseTracks = useJson<TracklistEntry[]>(nodeId != null && node?.type === 'release' ? `/nodes/${nodeId}/tracklist` : null, reloads)
  const credits = useJson<NodeCredits>(nodeId != null ? `/nodes/${nodeId}/credits` : null, reloads) ?? NO_CREDITS

  if (!node || node.id !== nodeId) return null

  // /credits names a node's tracks by id alone; their titles come from the
  // map's graph, and playTracks looks up any it doesn't have (#444).
  const creditTracks = credits.tracks.map((id) => ({ id, title: graph.byId.get(id)?.title ?? '' }))

  // A producer's or engineer's tracks are the ones credited to them, in the
  // node's own edges; /credits only says who made a node. Only the phone's
  // sheet lists them so far.
  const tracklist =
    node.type === 'credit'
      ? [
          ...new Map(
            node.edges
              .filter((e) => e.direction === 'in' && e.other_type === 'recording')
              .map((e) => [
                e.other_id,
                {
                  id: e.other_id,
                  title: e.other_title,
                  track_no: null,
                  canonical_duration_ms: graph.byId.get(e.other_id)?.canonical_duration_ms ?? null,
                },
              ]),
          ).values(),
        ]
      : releaseTracks

  // What play and shuffle name the queue: the record, or the artist whose
  // tracks they are (#357).
  const source: QueueSource | null =
    node.type === 'release'
      ? { kind: 'release', nodeId: node.id }
      : node.type === 'artist'
        ? { kind: 'artist', nodeId: node.id, name: node.title }
        : null

  const artistEdge = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const artistName = node.type === 'artist' ? null : (artistEdge?.other_title ?? graph.byId.get(node.id)?.subtitle ?? null)
  const artistId = artistEdge?.other_id ?? null
  const albumEdge = node.type === 'recording' ? release(node) : null
  const year = summary && (summary.kind === 'release' || summary.kind === 'recording') ? summary.releaseDate?.slice(0, 4) : null
  const releaseType = node.files[0]?.release_type?.toLowerCase()
  const kindLine = [node.type === 'release' ? (releaseType ?? 'album') : (TYPE_WORD[node.type] ?? node.type), year]
    .filter(Boolean)
    .join(' · ')

  return {
    node,
    reload: () => {
      reload()
      setReloads((n) => n + 1)
    },
    summary,
    tracklist,
    credits,
    kindLine,
    artistName,
    artistId,
    albumName: albumEdge?.other_title ?? null,
    albumId: albumEdge?.other_id ?? null,
    canPlay: node.type === 'release' || node.type === 'recording' || credits.tracks.length > 0,
    canShuffle: node.type !== 'recording' && credits.tracks.length > 1,
    play: () => {
      if (node.type === 'release') void playback.playAlbum(node.id)
      else if (node.type === 'recording') void playback.playNode(node.id, node.title)
      else if (creditTracks.length) void playback.playTracks(creditTracks, 0, source)
    },
    shuffle: () => {
      const tracks = node.type === 'release' && tracklist ? tracklist : creditTracks
      if (tracks.length) void playback.playTracks(shuffle(tracks), 0, source)
    },
    tabs: [
      { value: 'overview', label: 'overview' },
      { value: 'tracks', label: node.type === 'artist' ? 'albums' : 'tracks' },
      { value: 'credits', label: 'credits' },
      { value: 'metadata', label: 'metadata' },
    ],
  }
}
