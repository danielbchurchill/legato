import { useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { API_BASE as API } from '../config/serverHost'

export { API }

/* Everything the node-detail surfaces are made of: the payload shape, and the
 * one fetch that produces it.
 *
 * Two surfaces render this now — the now-playing panel and the inspector
 * modal the canvas card opens — so the fetch lives here rather than inside
 * either of them. They ask for the same node in different places and must
 * never disagree about it.
 */

export type Fact = { text: string; targetNodeId?: number; groupType?: string }
export type Edge = {
  id: number
  type: string
  source: string
  label: string | null
  note: string | null
  direction: 'in' | 'out'
  other_id: number
  other_title: string
  other_type: string
}
export type FileRow = {
  id: number
  file_path: string
  format: string | null
  bitrate: number | null
  track_no: number | null
  bpm: number | null
  label: string | null
  release_date: string | null
  release_type: string | null
}
export type NodeDetail = {
  id: number
  type: string
  title: string
  mbid: string | null
  /** When the node first appeared in the library (nodes.created_at, UTC). */
  created_at?: string
  recording: { canonical_duration_ms: number | null } | null
  files: FileRow[]
  edges: Edge[]
  facts: Fact[]
  article: { body_md: string } | null
  /** Fetched prose about the artist or album (not about this collection) —
   * null when nothing was found or nothing has been looked up yet. */
  description: { body: string; source: string; source_url: string | null; license: string | null } | null
  /** Real listen count from the plays table (migration 0013) — recording
   * nodes only, null for everything else. */
  playCount: number | null
  /** Presence in the favourites table (migration 0020) — the manual
   * bookmark toggle NodeTitleBlock.tsx renders as a heart. */
  is_favourite: boolean
  /** This artist's discography — empty for every non-artist node. */
  releases: Release[]
}
/** A real release entity (server/src/entities/aggregate.ts's albums table),
 * scoped to releases this artist is the primary credit on — populated only
 * on artist nodes, always an empty array otherwise. */
export type Release = {
  id: number
  title: string
  trackCount: number
  totalDurationMs: number
  yearMin: number | null
  yearMax: number | null
}
export type FieldDiff = { field: string; oldValue: string | number; newValue: string | number }
export type TagWriteRow = { id: number; status: string; diff_json: string }
export type LyricsData = { plainLyrics: string | null; syncedLyrics: string | null; instrumental: boolean; found: boolean }
export type EditableFields = { bpm?: number; label?: string; releaseType?: string; releaseDate?: string }
export type SearchResult = { id: number; type: string; title: string }

// Mirrors server/src/facts.ts's EDGE_VERB — same duplication pattern as
// CollectionPanel.tsx's TYPE_LABEL for worklist items. Only needed for the
// collapsed-group header (P-6); the singular case already has the verb
export type NodeDetailState = {
  node: NodeDetail | null
  /** Refetch after a write — approving a tag write, adding or deleting an
   * edge — so the surface shows what is now on disk rather than what it
   * asked for. */
  reload: () => void
}

export function useNodeDetail(nodeId: number | null): NodeDetailState {
  const [node, setNode] = useState<NodeDetail | null>(null)

  const load = () => {
    if (nodeId == null) return
    fetch(`${API}/nodes/${nodeId}`)
      .then((r) => r.json())
      .then(setNode)
      .catch(() => setNode(null))
  }

  useEffect(() => {
    if (nodeId == null) {
      setNode(null)
      return
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  // Enrichment lands minutes after a scan, over a rate-limited queue, while
  // the surface is already open — so a description arriving has to reload the
  // node being looked at rather than waiting for the next selection. Filtered
  // on the payload's own node id: a queue draining a hundred artists must not
  // refetch this a hundred times.
  //
  // favourites:changed rides the same listener — NodeTitleBlock.tsx already
  // flips its heart optimistically on click, so this exists purely as a
  // self-correction path (a failed request, or the same node favourited
  // from a second surface) rather than something the toggle depends on to
  // feel instant.
  useWsEvent(['enrich:applied', 'favourites:changed'], (payload) => {
    if (nodeId != null && (payload as { nodeId?: number } | undefined)?.nodeId === nodeId) load()
  })

  return { node, reload: load }
}
