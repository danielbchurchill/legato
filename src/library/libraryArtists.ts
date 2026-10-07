import { computeClusters } from '../canvas/clusters'
import type { GraphEdge, GraphNode } from '../canvas/useGraphData'

/* The artists the library lists: the graph's artist nodes that have records
 * of their own, counted by the same cluster logic the map uses. Featured-only
 * artists are left out; they'd fill the grid with names that lead nowhere.
 *
 * One function for the Artists tab and the Library header's count, so the
 * two can't disagree again. The header used to count every artist node
 * (26 on the Pi) while the tab listed 14. */

export type LibraryArtist = { id: number; name: string; releases: number }

export function libraryArtists(nodes: GraphNode[], edges: GraphEdge[]): LibraryArtist[] {
  const { releasesOf } = computeClusters(nodes, edges)
  return nodes
    .filter((n) => n.type === 'artist' && (releasesOf.get(n.id)?.length ?? 0) > 0)
    .map((n) => ({ id: n.id, name: n.title, releases: releasesOf.get(n.id)?.length ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
