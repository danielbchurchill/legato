import { useEffect, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { NodeImageProgram } from '@sigma/node-image'
import { patchNodePosition, useGraphData, type GraphEdge, type GraphNode } from './useGraphData'

const API = 'http://127.0.0.1:8899/api/v1'

/* Node sizing. Sigma sizes are in its own units, not pixels — 22 renders at
 * roughly the mockup's 44px cover at the default camera. Nodes without art
 * stay small colored dots so the artwork carries the eye. */
const ART_SIZE = 22

const NODE_COLOR: Record<string, string> = {
  recording: '#e8e8e8',
  artist: '#ff8a3d',
  release: '#4da3ff',
  label: '#c77dff',
  year: '#5a5a5a',
  work: '#ffd23f',
  credit: '#4dd0a3',
}

const NODE_SIZE: Record<string, number> = {
  recording: 3,
  artist: 6,
  release: 5,
  label: 5,
  year: 2,
  work: 4,
  credit: 4,
}

/* Edge color encodes relationship type — one family, identical saturation and
 * lightness, hue rotated per step. Mirrors --color-edge-* in tokens.css; sigma
 * needs concrete values because it renders to WebGL and never sees our CSS.
 * See DESIGN.md "Edge palette". */
const EDGE_COLOR: Record<string, string> = {
  performed_by: '#bf68eb',
  appears_on: '#68b6eb',
  released_in: '#68eb79',
}
const EDGE_COLOR_FALLBACK = 'rgba(255,255,255,0.12)'

function nodeKey(id: number): string {
  return String(id)
}

function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

/* The viewport sigma normalises against.
 *
 * Sigma fits the graph's full extent by default, which makes the whole canvas
 * hostage to a single far-flung node: drag one album to the far left and every
 * other node collapses into an unreadable clump. That is not hypothetical —
 * it was the state of the real library, where one dragged node sat ~78,000
 * units from the other 397 and squeezed them into ~6% of the viewport.
 *
 * Dragged positions are the user's and are never moved (Legato.md: "the user
 * layer always wins"), so the fix belongs here: frame the bulk of the graph
 * and let outliers sit off-screen until the user pans to them. */
function robustBBox(graph: Graph): { x: [number, number]; y: [number, number] } | null {
  if (graph.order === 0) return null

  const xs: number[] = []
  const ys: number[] = []
  graph.forEachNode((_key, attrs) => {
    xs.push(attrs.x as number)
    ys.push(attrs.y as number)
  })
  xs.sort((a, b) => a - b)
  ys.sort((a, b) => a - b)

  // Too few nodes for percentiles to mean anything — show everything.
  const [lo, hi] = graph.order < 20 ? [0, 1] : [0.01, 0.99]

  const pad = (min: number, max: number): [number, number] => {
    const span = max - min
    const margin = span === 0 ? 1 : span * 0.08
    return [min - margin, max + margin]
  }

  return {
    x: pad(quantile(xs, lo), quantile(xs, hi)),
    y: pad(quantile(ys, lo), quantile(ys, hi)),
  }
}

function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const graph = new Graph()

  for (const node of nodes) {
    const x = node.user_x ?? node.seed_x
    const y = node.user_y ?? node.seed_y
    if (x == null || y == null) continue // no position yet — nothing to plot

    // Artwork is bound to release nodes only. Every recording resolves to its
    // album's cover through the endpoint, but binding thousands of recordings
    // would put thousands of unique textures in sigma's atlas for images that
    // are mostly duplicates of each other. Session 4 revisits this when the
    // graph splits by granularity.
    const hasArt = node.type === 'release' && node.has_cover === 1

    if (hasArt) {
      graph.addNode(nodeKey(node.id), {
        label: node.title,
        x,
        y,
        size: ART_SIZE,
        type: 'image',
        image: `${API}/nodes/${node.id}/cover?size=thumb`,
        color: '#ffffff',
        origSize: ART_SIZE,
      })
      continue
    }

    const size = NODE_SIZE[node.type] ?? 3
    const color = NODE_COLOR[node.type] ?? '#999'
    graph.addNode(nodeKey(node.id), { label: node.title, x, y, size, color, origSize: size })
  }

  for (const edge of edges) {
    const from = nodeKey(edge.from_node)
    const to = nodeKey(edge.to_node)
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue
    if (graph.hasEdge(from, to)) continue
    graph.addEdge(from, to, { size: 0.5, color: EDGE_COLOR[edge.type] ?? EDGE_COLOR_FALLBACK })
  }

  return graph
}

type Props = {
  selectedNodeId: number | null
  onSelectNode: (id: number | null) => void
  onStats?: (stats: { nodes: number; edges: number }) => void
}

export default function Canvas({ selectedNodeId, onSelectNode, onStats }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const { nodes, edges, loading } = useGraphData()

  // Held in refs so the sigma effect below does not list them as dependencies.
  // It used to depend on onSelectNode, which meant every parent re-render tore
  // down the whole renderer and reset the camera mid-interaction.
  const onSelectNodeRef = useRef(onSelectNode)
  const onStatsRef = useRef(onStats)
  useEffect(() => {
    onSelectNodeRef.current = onSelectNode
    onStatsRef.current = onStats
  })

  useEffect(() => {
    if (!containerRef.current || loading) return

    const graph = buildGraph(nodes, edges)
    graphRef.current = graph
    onStatsRef.current?.({ nodes: graph.order, edges: graph.size })

    const renderer = new Sigma(graph, containerRef.current, {
      // No labels on the canvas: the mockup identifies a node by its artwork
      // and nothing else, and 398 overlapping titles bury the art they are
      // supposed to describe. Hover and selection labelling is session 4's,
      // alongside neighbour highlighting.
      renderLabels: false,
      renderEdgeLabels: false,
      defaultEdgeType: 'line',
      nodeProgramClasses: { image: NodeImageProgram },
      // Covers are clipped to circles on the canvas, and only here — the same
      // artwork stays square inside a panel. DESIGN.md "Radius".
      defaultNodeType: 'circle',
    })

    const bbox = robustBBox(graph)
    if (bbox) renderer.setCustomBBox(bbox)

    // Standard sigma.js drag-node recipe: track the dragged node across
    // downNode -> mousemovebody -> mouseup, reposition it live, and PATCH
    // the server only once the drag actually ends — not on every frame.
    let draggedNode: string | null = null
    let isDragging = false

    renderer.on('downNode', (e) => {
      isDragging = true
      draggedNode = e.node
      graph.setNodeAttribute(draggedNode, 'highlighted', true)
    })

    renderer.on('clickNode', (e) => {
      onSelectNodeRef.current(Number(e.node))
    })

    const mouseCaptor = renderer.getMouseCaptor()

    mouseCaptor.on('mousemovebody', (e) => {
      if (!isDragging || !draggedNode) return
      const pos = renderer.viewportToGraph(e)
      graph.setNodeAttribute(draggedNode, 'x', pos.x)
      graph.setNodeAttribute(draggedNode, 'y', pos.y)
      e.preventSigmaDefault()
    })

    const handleMouseUp = () => {
      if (draggedNode) {
        const id = Number(draggedNode)
        const x = graph.getNodeAttribute(draggedNode, 'x') as number
        const y = graph.getNodeAttribute(draggedNode, 'y') as number
        graph.removeNodeAttribute(draggedNode, 'highlighted')
        void patchNodePosition(id, x, y)
      }
      isDragging = false
      draggedNode = null
    }

    // Pins the projection while dragging so the graph does not reflow under
    // the cursor. Already a no-op when robustBBox set one above, kept for the
    // empty-graph case.
    const handleMouseDown = () => {
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
    }

    mouseCaptor.on('mouseup', handleMouseUp)
    mouseCaptor.on('mousedown', handleMouseDown)

    return () => {
      renderer.kill()
      graphRef.current = null
    }
  }, [nodes, edges, loading])

  // Selection can arrive from a canvas click, a search result, or an inline
  // link — either way the canvas marks the same node.
  //
  // Selection is an addition, never a substitution: the node grows a ring
  // rather than changing color, so a cover stays readable as artwork.
  // DESIGN.md "Nodes".
  const previousSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return

    const prev = previousSelectionRef.current
    if (prev && graph.hasNode(prev)) {
      graph.removeNodeAttribute(prev, 'highlighted')
      graph.setNodeAttribute(prev, 'size', graph.getNodeAttribute(prev, 'origSize'))
    }

    if (selectedNodeId != null) {
      const key = nodeKey(selectedNodeId)
      if (graph.hasNode(key)) {
        // sigma's `highlighted` draws a ring around the node without touching
        // its fill or its image — exactly the ringed-cover treatment.
        graph.setNodeAttribute(key, 'highlighted', true)
        previousSelectionRef.current = key
        return
      }
    }
    previousSelectionRef.current = null
  }, [selectedNodeId, nodes, edges, loading])

  return <div ref={containerRef} className="absolute inset-0" />
}
