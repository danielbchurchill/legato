import { useMemo, type ReactNode } from 'react'
import { useGraphData } from './useGraphData'
import { GraphDataContext } from './graphContext'

/* Fetches the library's graph once and shares it through GraphDataContext;
 * see graphContext.ts for who reads it and why it's shared. */
export function GraphDataProvider({ children }: { children: ReactNode }) {
  const { nodes, edges, loading, refetch } = useGraphData()
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const value = useMemo(() => ({ nodes, edges, loading, refetch, byId }), [nodes, edges, loading, refetch, byId])
  return <GraphDataContext.Provider value={value}>{children}</GraphDataContext.Provider>
}
