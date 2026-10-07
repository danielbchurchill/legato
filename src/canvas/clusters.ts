/* Which artist each node on the map belongs to.
 *
 * v2 draws the map as clusters — an artist, its records, their tracks —
 * each with a glow in the artist's cover colour, and a selection focuses
 * the selected node's whole cluster. The graph has no "cluster" field, so
 * it's derived from the edges the map already draws:
 *
 *  - an artist is its own cluster;
 *  - a track joins the artist on its first performed_by edge (the lowest
 *    edge id, the same credit /nodes uses for the track's subtitle);
 *  - a record has no edge to its artist, only from its tracks, so it joins
 *    whichever artist most of its tracks joined — a compilation lands with
 *    its most-represented artist rather than splitting;
 *  - a producer or engineer credit belongs to no cluster: it is the link
 *    *between* clusters.
 *
 * Pure, so the map's reducers can read it per frame from a cached result
 * and so it can be tested without a renderer. */

export type ClusterNode = { id: number; type: string }
export type ClusterEdge = { id?: number; from_node: number; to_node: number; type: string }

export type Clusters = {
  /** Node id → its artist's id. Absent for nodes in no cluster. */
  clusterOf: Map<number, number>
  /** Artist id → the records in its cluster. */
  releasesOf: Map<number, number[]>
}

export function computeClusters(nodes: readonly ClusterNode[], edges: readonly ClusterEdge[]): Clusters {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]))
  const clusterOf = new Map<number, number>()

  for (const node of nodes) if (node.type === 'artist') clusterOf.set(node.id, node.id)

  // Tracks: first performed_by by edge id. Edges without an id keep their
  // array order, which is the server's id order anyway.
  const performedBy = edges
    .filter((e) => e.type === 'performed_by' && typeOf.get(e.from_node) === 'recording' && typeOf.get(e.to_node) === 'artist')
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
  for (const edge of performedBy) {
    if (!clusterOf.has(edge.from_node)) clusterOf.set(edge.from_node, edge.to_node)
  }

  // Records: a majority vote of their tracks' artists, ties to the lower
  // artist id so the answer doesn't depend on edge order.
  const votes = new Map<number, Map<number, number>>()
  for (const edge of edges) {
    if (edge.type !== 'appears_on' || typeOf.get(edge.to_node) !== 'release') continue
    const artist = clusterOf.get(edge.from_node)
    if (artist == null) continue
    const tally = votes.get(edge.to_node) ?? new Map<number, number>()
    tally.set(artist, (tally.get(artist) ?? 0) + 1)
    votes.set(edge.to_node, tally)
  }
  const releasesOf = new Map<number, number[]>()
  for (const [releaseId, tally] of votes) {
    let best: number | null = null
    let bestCount = 0
    for (const [artist, count] of tally) {
      if (count > bestCount || (count === bestCount && best != null && artist < best)) {
        best = artist
        bestCount = count
      }
    }
    if (best == null) continue
    clusterOf.set(releaseId, best)
    const list = releasesOf.get(best) ?? []
    list.push(releaseId)
    releasesOf.set(best, list)
  }

  return { clusterOf, releasesOf }
}
