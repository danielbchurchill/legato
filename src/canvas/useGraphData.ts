import { useCallback, useEffect, useState } from 'react'
import type { Granularity } from '../shell/granularity'

const API = 'http://127.0.0.1:8899/api/v1'

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
  /** SQLite EXISTS, so 0 or 1 rather than a boolean. */
  has_cover: number
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
