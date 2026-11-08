import type Graph from 'graphology'

/* What the map draws, for what a focus lights and frames (#482). A node can
 * be left off the map two ways. Producers are taken out of the graph while
 * the map options hide them (Canvas.tsx's syncGraph), and a label never
 * reaches it, since the server gives labels no place on the map. The show
 * chips hide artists, albums and tracks where they stand instead: those stay
 * in the graph, and the reducers draw them as hidden. */

export type ShownKinds = { showArtists: boolean; showReleases: boolean; showTracks: boolean }

/** Whether the show chips hide a kind of node the graph keeps. */
export function hiddenByShow(type: string | undefined, show: ShownKinds): boolean {
  return (
    (type === 'artist' && !show.showArtists) || (type === 'release' && !show.showReleases) || (type === 'recording' && !show.showTracks)
  )
}

/** The keys among `keys` whose nodes the map draws, in order. */
export function drawnKeys(graph: Graph, keys: Iterable<string>, show: ShownKinds): Set<string> {
  const drawn = new Set<string>()
  for (const key of keys) {
    if (graph.hasNode(key) && !hiddenByShow(graph.getNodeAttribute(key, 'nodeType') as string | undefined, show)) drawn.add(key)
  }
  return drawn
}

export type Box = { minX: number; minY: number; maxX: number; maxY: number }

/** The box the nodes of `keys` span once `normalize` has taken them to
 * sigma's framed coordinates, or null when none of them is in the graph. */
export function boxOf(
  graph: Graph,
  keys: Iterable<string>,
  normalize: (p: { x: number; y: number }) => { x: number; y: number },
): Box | null {
  let box: Box | null = null
  for (const key of keys) {
    if (!graph.hasNode(key)) continue
    const p = normalize({ x: graph.getNodeAttribute(key, 'x') as number, y: graph.getNodeAttribute(key, 'y') as number })
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
    else {
      box.minX = Math.min(box.minX, p.x)
      box.maxX = Math.max(box.maxX, p.x)
      box.minY = Math.min(box.minY, p.y)
      box.maxY = Math.max(box.maxY, p.y)
    }
  }
  return box
}
