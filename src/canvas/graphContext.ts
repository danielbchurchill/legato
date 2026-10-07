import { createContext, useContext } from 'react'
import type { GraphEdge, GraphNode } from './useGraphData'

/* One fetch of the library's graph, shared. The map draws it, but the
 * legend counts it, the search palette fills in subtitles and covers from
 * it, the player names the artist from it and "Shuffle library" picks from
 * it. They must agree, and none of them should pay for a second /nodes.
 * GraphDataProvider (graphData.tsx) fills this in. */

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  loading: boolean
  refetch: () => Promise<void>
  byId: Map<number, GraphNode>
}

export const GraphDataContext = createContext<GraphData | null>(null)

export function useGraph(): GraphData {
  const value = useContext(GraphDataContext)
  if (!value) throw new Error('useGraph needs a GraphDataProvider above it')
  return value
}
