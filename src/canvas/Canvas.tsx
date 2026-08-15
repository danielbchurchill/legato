import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { createNormalizationFunction } from 'sigma/utils'
import { createNodeImageProgram } from '@sigma/node-image'
import { patchNodePosition, useGraphData, type GraphEdge, type GraphNode } from './useGraphData'
import type { Granularity } from '../shell/granularity'
import { useScanStatus } from '../hooks/useScanStatus'

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
 * lightness at every hue. Mirrors --color-edge-* in tokens.css; sigma needs
 * concrete values because it renders to WebGL and never sees our CSS. Grouped
 * by which graph a type actually renders in (they never render together), not
 * spaced as one flat 10-color wheel — see DESIGN.md "Edge palette". */
const EDGE_COLOR: Record<string, string> = {
  performed_by: '#bf68eb',
  appears_on: '#68b6eb',
  released_in: '#68eb79',
  featured_artist: '#66eabc',
  released_on: '#ea66a6',
  produced_by: '#ea9066',
  engineered_by: '#dbea66',
  same_artist: '#7166ea',
  same_label: '#ea667c',
  collaborated_with: '#ea8766',
}
const EDGE_COLOR_FALLBACK = 'rgba(255,255,255,0.12)'

/* Hover/neighbor highlighting dims everything else instead of brightening the
 * hovered set — matches the selection ring's own "addition, not substitution"
 * rule (DESIGN.md "Nodes"): the graph's base palette never changes meaning,
 * uninvolved elements just recede.
 *
 * Mirrors --color-node-dim / --color-edge-dim in tokens.css — sigma needs
 * concrete values because it renders to WebGL and never sees our CSS (same
 * reasoning as EDGE_COLOR above). These MUST be opaque: sigma's WebGL path
 * does not composite a translucent rgba() the way CSS would, so the
 * previous rgba(255,255,255,0.06) rendered as solid white — hovering blew
 * the whole graph out to a bright flash instead of dimming it. Confirmed
 * live: swapping to an opaque dark hex fixes it outright. */
const DIMMED_NODE_COLOR = '#20262a'
const DIMMED_EDGE_COLOR = '#1b2023'

/* LOD: only bind real cover textures once the camera is zoomed in enough that
 * they'd actually be legible — at the whole-library view, thumbnails would be
 * a few pixels across and every one is still a unique texture in sigma's
 * atlas for effectively no visual benefit. Below the threshold, art-eligible
 * nodes render as the same flat colored dot as everything else. Sigma's own
 * camera ratio is inverse-zoom: smaller ratio = more zoomed in. */
const ART_ZOOM_RATIO_THRESHOLD = 1.4

/* Camera ratio flyToNode animates to — comfortably past
 * ART_ZOOM_RATIO_THRESHOLD so the destination node's art is already bound
 * and visible by the time the animation lands, not one more zoom step away. */
const FLY_TO_RATIO = 0.3
const FLY_TO_DURATION_MS = 500

/* Selection ring — mirrors --color-node-ring in tokens.css (sigma's hover
 * canvas is plain 2D context, same reasoning as EDGE_COLOR/DIMMED_*_COLOR
 * above: it never sees our CSS). 15px of clearance around the node's own
 * rendered radius, per DESIGN.md "Nodes". */
const NODE_RING_COLOR = '#ffffff'
const NODE_RING_CLEARANCE = 15

/* Default NodeImageProgram sizes its atlas cell off the source image's own
 * resolution ('auto' mode) — a 128px cover thumb squeezed into a ~44px node
 * (ART_SIZE 22) then gets minified across the atlas's 1px inter-image
 * margin, which bleeds in as a white fringe around every cover. Forcing a
 * cell size close to the actual render size removes the mismatch outright
 * (confirmed live: raising node size to 80, which sidesteps the same
 * minification, also removed the fringe). */
const NodeImageProgram = createNodeImageProgram({ size: { mode: 'force', value: 64 } })

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

/* Art is only ever bound to release nodes — every recording resolves to its
 * album's cover through the endpoint, but binding thousands of recordings
 * would put thousands of unique textures in sigma's atlas for images that are
 * mostly duplicates of each other. artEnabled is the LOD gate above. */
function nodeAttributes(node: GraphNode, artEnabled: boolean): Record<string, unknown> {
  const x = node.user_x ?? node.seed_x
  const y = node.user_y ?? node.seed_y
  const hasArt = artEnabled && node.type === 'release' && node.has_cover === 1

  if (hasArt) {
    return {
      label: node.title,
      x,
      y,
      size: ART_SIZE,
      type: 'image',
      image: `${API}/nodes/${node.id}/cover?size=thumb`,
      color: '#ffffff',
      origSize: ART_SIZE,
    }
  }

  const size = NODE_SIZE[node.type] ?? 3
  const color = NODE_COLOR[node.type] ?? '#999'
  return { label: node.title, x, y, size, color, type: 'circle', origSize: size }
}

/* Updates the existing graphology instance in place to match the latest
 * fetched data — add/update/remove, never drop-and-rebuild — so the Sigma
 * renderer subscribed to this graph never needs to be torn down for a plain
 * data refresh. This is the actual fix for the bug that used to reset the
 * camera on every refetch: the renderer effect below now only depends on
 * `granularity`, not on `nodes`/`edges`. */
function syncGraph(graph: Graph, nodes: GraphNode[], edges: GraphEdge[], artEnabled: boolean): void {
  const wantedNodes = new Map<string, GraphNode>()
  for (const node of nodes) {
    const x = node.user_x ?? node.seed_x
    const y = node.user_y ?? node.seed_y
    if (x == null || y == null) continue // no position yet — nothing to plot
    wantedNodes.set(nodeKey(node.id), node)
  }

  graph.forEachNode((key) => {
    if (!wantedNodes.has(key)) graph.dropNode(key)
  })
  for (const [key, node] of wantedNodes) {
    const attrs = nodeAttributes(node, artEnabled)
    if (graph.hasNode(key)) graph.mergeNodeAttributes(key, attrs)
    else graph.addNode(key, attrs)
  }

  // Keyed by (from, to, type) rather than just (from, to) — two albums can
  // share both a same_artist and a same_label relation at once (confirmed on
  // the real library: 19 of 109 album pairs do), and a plain Graph only
  // allows one edge between a given pair. graph is constructed as a
  // multigraph below specifically so both survive as visually distinct
  // edges instead of one silently overwriting the other.
  const wantedEdgeKeys = new Set<string>()
  for (const edge of edges) {
    const from = nodeKey(edge.from_node)
    const to = nodeKey(edge.to_node)
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue
    const edgeKey = `${from}->${to}::${edge.type}`
    wantedEdgeKeys.add(edgeKey)
    if (graph.hasEdge(edgeKey)) continue
    graph.addEdgeWithKey(edgeKey, from, to, { size: 0.5, color: EDGE_COLOR[edge.type] ?? EDGE_COLOR_FALLBACK })
  }

  graph.forEachEdge((edgeKey) => {
    if (!wantedEdgeKeys.has(edgeKey)) graph.dropEdge(edgeKey)
  })
}

// Re-attributes every art-eligible node when the LOD threshold is crossed —
// an event-driven bulk update on camera 'updated', not a per-frame reducer:
// NodeImageProgram needs a real 'image' attribute and a real 'image' node
// type on the graph, which a render-time reducer can override for color/size
// but not reliably swap the rendering program for.
function applyArtLOD(graph: Graph, nodes: GraphNode[], artEnabled: boolean): void {
  for (const node of nodes) {
    const key = nodeKey(node.id)
    if (!graph.hasNode(key)) continue
    const shouldHaveArt = artEnabled && node.type === 'release' && node.has_cover === 1
    const currentlyHasArt = graph.getNodeAttribute(key, 'type') === 'image'
    if (shouldHaveArt === currentlyHasArt) continue
    graph.mergeNodeAttributes(key, nodeAttributes(node, artEnabled))
  }
}

type Props = {
  granularity: Granularity
  selectedNodeId: number | null
  onSelectNode: (id: number | null) => void
  onStats?: (stats: { nodes: number; edges: number }) => void
}

export type CanvasHandle = {
  /** Animates the camera to center on and zoom into a node — search results,
   * fact links, and hygiene worklist items all resolve to this so "select a
   * node" always means "go look at it," matching the canvas-first navigation
   * Legato.md calls out as the actual point of a spatial layout. No-op for a
   * node not in the currently active granularity's graph. */
  flyToNode: (nodeId: number) => void
}

export default forwardRef<CanvasHandle, Props>(function Canvas(
  { granularity, selectedNodeId, onSelectNode, onStats },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const rendererRef = useRef<Sigma | null>(null)
  const { nodes, edges, loading } = useGraphData(granularity)
  const scanStatus = useScanStatus()

  useImperativeHandle(
    ref,
    () => ({
      flyToNode(nodeId: number) {
        const graph = graphRef.current
        const renderer = rendererRef.current
        const key = nodeKey(nodeId)
        if (!graph || !renderer || !graph.hasNode(key)) return

        const attrs = graph.getNodeAttributes(key)
        const bbox = renderer.getCustomBBox() ?? renderer.getBBox()
        const normalize = createNormalizationFunction(bbox)
        const { x, y } = normalize({ x: attrs.x as number, y: attrs.y as number })
        void renderer.getCamera().animate({ x, y, ratio: FLY_TO_RATIO }, { duration: FLY_TO_DURATION_MS })
      },
    }),
    [],
  )

  // Held in refs so effects below don't list them as dependencies — a parent
  // re-render must never tear down the renderer or reset the camera.
  const onSelectNodeRef = useRef(onSelectNode)
  const onStatsRef = useRef(onStats)
  const nodesRef = useRef(nodes)
  const artEnabledRef = useRef(true)
  const lastCameraRatioRef = useRef<number | null>(null)
  useEffect(() => {
    onSelectNodeRef.current = onSelectNode
    onStatsRef.current = onStats
    nodesRef.current = nodes
  })

  // Renderer lifecycle — created once per granularity (a genuinely different
  // graph: different node set, different edges, different layout), NOT on
  // every data refresh. The zoom ratio (not pan/x/y, which have no shared
  // meaning across two different node sets) carries over from whichever
  // graph was active before, so switching artists -> albums -> tracks doesn't
  // suddenly zoom back out to fit-all every time.
  useEffect(() => {
    if (!containerRef.current) return

    // multi: true — two nodes can hold more than one edge between them (a
    // same_artist and a same_label relation between the same two albums,
    // for real on the current library). See syncGraph's edge-keying comment.
    const graph = new Graph({ multi: true })
    graphRef.current = graph

    const renderer = new Sigma(graph, containerRef.current, {
      // No labels on the canvas: the mockup identifies a node by its artwork
      // and nothing else, and hundreds of overlapping titles bury the art
      // they are supposed to describe. Hover labelling is handled by the
      // reducers below instead of sigma's built-in label rendering.
      renderLabels: false,
      renderEdgeLabels: false,
      defaultEdgeType: 'line',
      nodeProgramClasses: { image: NodeImageProgram },
      // Covers are clipped to circles on the canvas, and only here — the same
      // artwork stays square inside a panel. DESIGN.md "Radius".
      defaultNodeType: 'circle',
      // sigma routes both `highlighted:true` nodes AND the live mouse-hovered
      // node through this same drawer — there is no way to tell them apart
      // from inside it except by attribute. Only nodes we explicitly flag
      // `ring: true` (the selection effect below) get the ring; a node the
      // pointer merely happens to be over draws nothing, in favour of the
      // dim/neighbor-highlight reducers and the panel already doing that
      // job. Without this override sigma falls back to its stock
      // black-on-white label-box hover renderer.
      defaultDrawNodeHover: (context, data) => {
        if (!data.ring) return
        context.beginPath()
        context.arc(data.x, data.y, data.size + NODE_RING_CLEARANCE, 0, Math.PI * 2)
        context.lineWidth = 1
        context.strokeStyle = NODE_RING_COLOR
        context.stroke()
      },
    })
    rendererRef.current = renderer

    if (lastCameraRatioRef.current != null) {
      renderer.getCamera().setState({ ratio: lastCameraRatioRef.current })
    }
    renderer.getCamera().on('updated', (state) => {
      lastCameraRatioRef.current = state.ratio
      const shouldHaveArt = state.ratio <= ART_ZOOM_RATIO_THRESHOLD
      if (shouldHaveArt !== artEnabledRef.current) {
        artEnabledRef.current = shouldHaveArt
        applyArtLOD(graph, nodesRef.current, shouldHaveArt)
      }
    })

    // Hover/neighbor highlighting — dims everything not connected to the
    // hovered node, via sigma's render-time reducers rather than mutating
    // graph attributes, so it costs nothing to undo on leaveNode.
    let hoveredNode: string | null = null
    let hoveredNeighbors: Set<string> | null = null

    renderer.setSetting('nodeReducer', (node, data) => {
      if (!hoveredNode || node === hoveredNode || hoveredNeighbors?.has(node)) return data
      // Forced to 'circle' rather than left as 'image' with no image — an
      // art-bound node dimmed mid-hover must reliably fall back to a plain
      // dimmed dot, not depend on NodeImageProgram handling a missing image
      // gracefully.
      return { ...data, type: 'circle', color: DIMMED_NODE_COLOR, zIndex: 0 }
    })
    renderer.setSetting('edgeReducer', (edge, data) => {
      if (!hoveredNode) return data
      const [source, target] = graph.extremities(edge)
      if (source === hoveredNode || target === hoveredNode) return data
      return { ...data, color: DIMMED_EDGE_COLOR }
    })

    renderer.on('enterNode', ({ node }) => {
      hoveredNode = node
      hoveredNeighbors = new Set(graph.neighbors(node))
      renderer.refresh()
    })
    renderer.on('leaveNode', () => {
      hoveredNode = null
      hoveredNeighbors = null
      renderer.refresh()
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
        void patchNodePosition(id, x, y, granularity)
      }
      isDragging = false
      draggedNode = null
    }

    // Pins the projection while dragging so the graph does not reflow under
    // the cursor.
    const handleMouseDown = () => {
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
    }

    mouseCaptor.on('mouseup', handleMouseUp)
    mouseCaptor.on('mousedown', handleMouseDown)

    return () => {
      renderer.kill()
      rendererRef.current = null
      graphRef.current = null
    }
    // Deliberately [granularity] only, not [nodes, edges] — see the comment
    // above the effect. onSelectNode/onStats/nodes are read through refs.
  }, [granularity])

  // Data sync — updates the existing graph in place whenever fetched data
  // changes, without touching the renderer (which would reset the camera).
  useEffect(() => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    if (!graph || !renderer || loading) return

    const hadNoNodes = graph.order === 0
    syncGraph(graph, nodes, edges, artEnabledRef.current)
    onStatsRef.current?.({ nodes: graph.order, edges: graph.size })

    // Only fit the camera to the data on the graph's first population for
    // this renderer (a fresh mount or a granularity switch) — a background
    // refresh of the same graph must never move the viewport out from under
    // whatever the user is currently looking at.
    if (hadNoNodes) {
      const bbox = robustBBox(graph)
      if (bbox) renderer.setCustomBBox(bbox)
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
      graph.removeNodeAttribute(prev, 'ring')
    }

    if (selectedNodeId != null) {
      const key = nodeKey(selectedNodeId)
      if (graph.hasNode(key)) {
        // `highlighted` lifts the node onto sigma's hover layer, drawn above
        // edges; `ring` is our own flag telling defaultDrawNodeHover (set on
        // the Sigma constructor above) to actually draw the ring rather than
        // sigma's stock hover box — see the comment there for why both are
        // needed. Neither touches the node's own fill, size or image.
        graph.setNodeAttribute(key, 'highlighted', true)
        graph.setNodeAttribute(key, 'ring', true)
        previousSelectionRef.current = key
        return
      }
    }
    previousSelectionRef.current = null
  }, [selectedNodeId, nodes, edges, loading])

  // One sentence, muted, centered, no illustration — DESIGN.md's empty-state
  // rule. Ordered error > scanning > plain-empty: a failed scan is the most
  // specific and actionable thing to tell someone, an in-progress one at
  // least explains why the graph is still blank, and a real empty result
  // (a library that scanned clean with nothing in it) is the fallback.
  const showEmptyState = !loading && nodes.length === 0

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />
      {showEmptyState && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[12px] text-center">
          {scanStatus.error ? (
            <>
              <p className="max-w-[420px] text-[length:var(--text-base)] text-[var(--color-muted)]">
                scan failed: {scanStatus.error}
              </p>
              <button
                type="button"
                onClick={scanStatus.retry}
                className="pointer-events-auto text-[length:var(--text-base)] text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted)]"
              >
                retry
              </button>
            </>
          ) : scanStatus.scanning ? (
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">scanning your library…</p>
          ) : (
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">nothing to show yet</p>
          )}
        </div>
      )}
    </div>
  )
})
