import type { GraphEdge, GraphNode } from './useGraphData'

/* #274: the map keeps its layout between visits. The physics runs here, so
 * each time it settles the client sends the server where nodes came to rest,
 * and the next visit opens on those spots instead of re-settling from seeds.
 * This module decides where a node joining the map starts, and which nodes
 * have moved since they were last saved. */

export type Point = { x: number; y: number }
export type StartingPosition = Point & { atRest: boolean }

/* How far from the middle of its placed neighbours a new node starts:
 * roughly a track's collision diameter, so new nodes landing beside the same
 * neighbours start apart rather than on top of each other. */
const BESIDE_OFFSET = 6
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** The spot a node was saved at, if any. A drag's user_x/user_y comes first,
 * then where the map last came to rest; the server keeps the two equal once
 * a dragged node has settled (server/src/layout/settled.ts). */
export function savedSpot(node: GraphNode): Point | null {
  if (node.user_x != null && node.user_y != null) return { x: node.user_x, y: node.user_y }
  if (node.settled_x != null && node.settled_y != null) return { x: node.settled_x, y: node.settled_y }
  return null
}

/** Where each node new to the map starts. A saved spot first, and a node at
 * its saved resting spot is at rest. A node with no saved spot starts beside
 * the neighbours it already has on the map, so a few tracks added by a scan
 * join their cluster instead of crossing the map from a seed computed for a
 * layout that has since settled elsewhere. A node with no placed neighbour
 * (the whole map on a first visit, a new artist) starts at its seed.
 *
 * `placedAt` answers for nodes already on the map. Deterministic: the same
 * nodes, edges and placements always give the same answer. */
export function startingPositions(
  fresh: GraphNode[],
  edges: GraphEdge[],
  placedAt: (id: number) => Point | null,
): Map<number, StartingPosition> {
  const result = new Map<number, StartingPosition>()
  const freshIds = new Set(fresh.map((node) => node.id))
  let unplaced: GraphNode[] = []

  for (const node of fresh) {
    const spot = savedSpot(node)
    if (spot) result.set(node.id, { ...spot, atRest: node.settled_x != null && node.settled_y != null })
    else unplaced.push(node)
  }
  if (unplaced.length === 0) return result

  const neighbours = new Map<number, number[]>()
  const link = (from: number, to: number) => {
    if (!freshIds.has(from)) return
    const list = neighbours.get(from)
    if (list) list.push(to)
    else neighbours.set(from, [to])
  }
  for (const edge of edges) {
    link(edge.from_node, edge.to_node)
    link(edge.to_node, edge.from_node)
  }
  const positionOf = (id: number): Point | null => result.get(id) ?? (freshIds.has(id) ? null : placedAt(id))

  // Repeated until a pass places nothing, so a new record whose new tracks
  // were placed beside their artist this pass is placed beside them next.
  while (unplaced.length > 0) {
    const stillUnplaced: GraphNode[] = []
    for (const node of unplaced) {
      let sumX = 0
      let sumY = 0
      let count = 0
      for (const id of neighbours.get(node.id) ?? []) {
        const p = positionOf(id)
        if (!p) continue
        sumX += p.x
        sumY += p.y
        count++
      }
      if (count === 0) {
        stillUnplaced.push(node)
        continue
      }
      const angle = node.id * GOLDEN_ANGLE
      result.set(node.id, {
        x: sumX / count + Math.cos(angle) * BESIDE_OFFSET,
        y: sumY / count + Math.sin(angle) * BESIDE_OFFSET,
        atRest: false,
      })
    }
    if (stillUnplaced.length === unplaced.length) break
    unplaced = stillUnplaced
  }

  for (const node of unplaced) {
    if (node.seed_x != null && node.seed_y != null) result.set(node.id, { x: node.seed_x, y: node.seed_y, atRest: false })
  }
  return result
}

/** The nodes whose position differs from the one last saved for them,
 * including any never saved at all: what one settle has to send. */
export function movedSince(
  saved: Map<string, Point>,
  current: Iterable<[string, { x?: number; y?: number }]>,
): { id: number; x: number; y: number }[] {
  const moved: { id: number; x: number; y: number }[] = []
  for (const [key, node] of current) {
    if (node.x == null || node.y == null) continue
    const last = saved.get(key)
    if (last && last.x === node.x && last.y === node.y) continue
    moved.push({ id: Number(key), x: node.x, y: node.y })
  }
  return moved
}
