import { useCallback, useEffect, useState } from 'react'

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

export function useGraphData() {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    const [nodesRes, edgesRes] = await Promise.all([fetch(`${API}/nodes`), fetch(`${API}/edges`)])
    setNodes(await nodesRes.json())
    setEdges(await edgesRes.json())
    setLoading(false)
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { nodes, edges, loading, refetch }
}

export async function patchNodePosition(nodeId: number, x: number, y: number): Promise<void> {
  await fetch(`${API}/nodes/${nodeId}/position`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  })
}
