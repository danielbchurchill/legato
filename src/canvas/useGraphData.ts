import { useCallback, useEffect, useRef, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import type { Granularity } from '../shell/granularity'

const API = 'http://127.0.0.1:8899/api/v1'

/* How long to wait for a burst of enrichment events to stop before refetching
 * the graph. Longer than the enrichment queue's own ~1/sec spacing, so a
 * drain of many nodes collapses into one refetch at the end rather than one
 * per node. */
const REFETCH_COALESCE_MS = 1500

export type GraphNode = {
  id: number
  type: string
  title: string
  mbid: string | null
  canonical_duration_ms: number | null
  seed_x: number | null
  seed_y: number | null
  user_x: number | null
  user_y: number | null
  /** sha1 of the art this node displays — its own, or whatever it inherits
   * (a track's album, an artist's most-represented album). Null when there
   * is no art anywhere in that chain. Names the image rather than just
   * promising one exists, so every node sharing a cover shares one URL and
   * therefore one texture in sigma's atlas — see server/src/routes/cover.ts. */
  cover_hash: string | null
  /** Second line of the hover plate and the selected card: a release's
   * primary artist, a recording's first credited artist, null for an artist
   * (who is already named on the first line). Carried with the graph rather
   * than fetched per node — the plate appears 90ms after the pointer lands
   * and cannot also wait on a round trip. */
  subtitle: string | null
}

export type GraphEdge = {
  id: number
  from_node: number
  to_node: number
  type: string
  source: string
  label: string | null
  note: string | null
}

// Refetches whenever granularity changes — server/src/routes/nodes.ts
// returns a completely different node/edge set per granularity (artists,
// albums, or the full tracks graph), not a filter over one shared dataset.
export function useGraphData(granularity: Granularity) {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    setLoading(true)
    const [nodesRes, edgesRes] = await Promise.all([
      fetch(`${API}/nodes?granularity=${granularity}`),
      fetch(`${API}/edges?granularity=${granularity}`),
    ])
    setNodes(await nodesRes.json())
    setEdges(await edgesRes.json())
    setLoading(false)
  }, [granularity])

  useEffect(() => {
    refetch()
  }, [refetch])

  // An artist photo arriving replaces the album cover that node was borrowing,
  // and a scan changes the node set outright — both while the canvas is on
  // screen. Refetching is safe here specifically because Canvas.tsx syncs the
  // graph in place and only fits the camera on a *first* population, so the
  // view the user is looking at doesn't move.
  //
  // Coalesced, because these arrive one per finished job: a queue draining
  // twenty artists at roughly one per second would otherwise mean twenty full
  // graph refetches. One, shortly after the burst stops, is enough.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useWsEvent(['enrich:applied', 'scan:done'], () => {
    if (refetchTimerRef.current != null) clearTimeout(refetchTimerRef.current)
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null
      void refetch()
    }, REFETCH_COALESCE_MS)
  })
  useEffect(() => () => {
    if (refetchTimerRef.current != null) clearTimeout(refetchTimerRef.current)
  }, [])

  return { nodes, edges, loading, refetch }
}

// granularity is required, not inferred — the same node can hold an
// independent drag position in up to three graphs (positions.granularity,
// migration 0015), and only the caller — mid-drag, in one specific graph —
// knows which one changed.
export async function patchNodePosition(nodeId: number, x: number, y: number, granularity: Granularity): Promise<void> {
  await fetch(`${API}/nodes/${nodeId}/position`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, granularity }),
  })
}
