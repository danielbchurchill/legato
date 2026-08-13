import { useEffect, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { patchNodePosition, useGraphData, type GraphNode } from './useGraphData'

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

function nodeKey(id: number): string {
  return String(id)
}

function buildGraph(nodes: GraphNode[], edges: { from_node: number; to_node: number; type: string }[]): Graph {
  const graph = new Graph()

  for (const node of nodes) {
    const x = node.user_x ?? node.seed_x
    const y = node.user_y ?? node.seed_y
    if (x == null || y == null) continue // no position yet — nothing to plot
    const size = NODE_SIZE[node.type] ?? 3
    const color = NODE_COLOR[node.type] ?? '#999'
    // origSize/origColor let the selection effect below restore a node's
    // normal look after highlighting it, without needing to rebuild the
    // whole graph just to clear a selection.
    graph.addNode(nodeKey(node.id), { label: node.title, x, y, size, color, origSize: size, origColor: color })
  }

  for (const edge of edges) {
    const from = nodeKey(edge.from_node)
    const to = nodeKey(edge.to_node)
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue
    if (graph.hasEdge(from, to)) continue
    graph.addEdge(from, to, { size: 0.5, color: 'rgba(255,255,255,0.12)' })
  }

  return graph
}

type Props = {
  selectedNodeId: number | null
  onSelectNode: (id: number | null) => void
}

export default function Canvas({ selectedNodeId, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const { nodes, edges, loading, refetch } = useGraphData()
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })

  useEffect(() => {
    if (!containerRef.current || loading) return

    const graph = buildGraph(nodes, edges)
    graphRef.current = graph
    setStats({ nodes: graph.order, edges: graph.size })

    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      defaultEdgeType: 'line',
    })

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
      onSelectNode(Number(e.node))
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

    const handleMouseDown = () => {
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
    }

    mouseCaptor.on('mouseup', handleMouseUp)
    mouseCaptor.on('mousedown', handleMouseDown)

    return () => {
      renderer.kill()
      graphRef.current = null
    }
  }, [nodes, edges, loading, onSelectNode])

  // Selection can arrive from a direct canvas click OR an inline link
  // click in ArticlePanel — either way the canvas highlights the same
  // node, which is the actual mechanism behind "canvas and panel both
  // update" (navigation by association, not just decoration).
  const previousSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return

    const prev = previousSelectionRef.current
    if (prev && graph.hasNode(prev)) {
      graph.setNodeAttribute(prev, 'size', graph.getNodeAttribute(prev, 'origSize'))
      graph.setNodeAttribute(prev, 'color', graph.getNodeAttribute(prev, 'origColor'))
    }

    if (selectedNodeId != null) {
      const key = nodeKey(selectedNodeId)
      if (graph.hasNode(key)) {
        graph.setNodeAttribute(key, 'size', (graph.getNodeAttribute(key, 'origSize') as number) * 2)
        graph.setNodeAttribute(key, 'color', '#ffffff')
        previousSelectionRef.current = key
      } else {
        previousSelectionRef.current = null
      }
    } else {
      previousSelectionRef.current = null
    }
  }, [selectedNodeId, nodes, edges, loading])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          color: '#fff',
          fontFamily: 'monospace',
          fontSize: 13,
          background: 'rgba(0,0,0,0.65)',
          padding: '8px 12px',
          borderRadius: 4,
          lineHeight: 1.5,
        }}
      >
        {loading ? (
          <div>loading library graph…</div>
        ) : (
          <>
            <div>nodes: {stats.nodes}</div>
            <div>edges: {stats.edges}</div>
            {selectedNodeId != null && <div>selected: #{selectedNodeId}</div>}
            <button
              onClick={() => void refetch()}
              style={{
                marginTop: 6,
                padding: '3px 8px',
                fontFamily: 'monospace',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              refresh
            </button>
          </>
        )}
      </div>
    </div>
  )
}
