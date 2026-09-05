import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { createNormalizationFunction } from 'sigma/utils'
import { createNodeImageProgram } from '@sigma/node-image'
import { patchNodePosition, useGraphData, type GraphEdge, type GraphNode } from './useGraphData'
import { EDGE_COLOR } from './edgeTypes'
import { createForceSimulation, type ForceSimulationHandle, type SimNodeInput } from './forceSimulation'
import { useScanStatus } from '../hooks/useScanStatus'
import { Button } from '../ui/Button'
import { NodeCard, NODE_CARD_COVER_CENTER_X, NODE_CARD_WIDTH_PX } from './NodeCard'
import { NodeHoverPlate } from './NodeHoverPlate'
import { SERVER_HOST } from '../config/serverHost'
import type { usePlayback } from '../playback/usePlayback'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* Node sizing. Sigma sizes are in its own units, not pixels — 22 renders at
 * roughly the mockup's 44px cover at the default camera. Nodes without art
 * stay small colored dots so the artwork carries the eye. */
const ART_SIZE = 22

/* Which shape a node's cover is cut to, by node type. Releases are squares —
 * an album cover is a square object, and in the albums graph the square *is*
 * the release. Everything else that carries art (a track inheriting its
 * album's cover, an artist showing a photo) stays a circle, so the two are
 * never ambiguous at a glance in the mixed tracks graph. See DESIGN.md
 * "Nodes". */
const SQUARE_COVER_TYPES = new Set(['release'])

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

const EDGE_COLOR_FALLBACK = 'rgba(255,255,255,0.12)'

/* G-6: 26 albums carry 103 same_artist edges (21 of those albums are one
 * of two artists), so each artist's catalogue forms a near-complete
 * subgraph — every album wired to every sibling, rendering as a solid mesh
 * rather than the sparse, legible strands the mockup shows. Daniel's call:
 * keep the edges (same_artist stays a real, followable relationship,
 * unlike collapsing it to spatial-grouping-only) but mute them so density
 * reads as proximity — a soft purple region where an artist's albums
 * cluster — rather than noise. same_label is left at full strength: far
 * sparser (not quadratic in the same way), so it stays legible on its own
 * and doesn't need the same treatment. Mixed toward the dim tone once, at
 * rest, via the same opaque-mixing helper G-2's hover-dim already uses —
 * not a hover state, just a permanently quieter resting color. */
const SAME_ARTIST_QUIET_MIX = 0.55

/* Edges carry graph-space size 0.5 (syncGraph), but sigma scales rendered
 * edge thickness by its default zoomToSizeRatioFunction (Math.sqrt of the
 * camera ratio) — so as the camera ratio shrinks while zooming in, edges
 * render visibly thicker, becoming wide saturated ribbons well before
 * FLY_TO_RATIO. DESIGN.md says edges are 1px, full stop, with no exception
 * for zoom level. Recomputed live in the edgeReducer below (reading the
 * camera's current ratio, not cached) so the on-screen width stays
 * constant at every zoom, calibrated to match the original literal at
 * camera ratio 1. */
const EDGE_WIDTH_AT_RATIO_1 = 0.5

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

/* How wide a node should render once the camera has flown to it.
 *
 * Stated as a size rather than as a camera ratio because the size is the
 * thing the design actually cares about — the artwork has to be big enough
 * to read as artwork, and 0.7 (the old literal) left it at 53px, barely
 * larger than the 44px it sits at when the whole graph is in frame. Selecting
 * a node was navigation that didn't visibly go anywhere.
 *
 * Sigma's item sizes are screen-referenced (itemSizesReference defaults to
 * "screen") and scale by 1/sqrt(ratio), so ART_SIZE 22 is a 44px node at
 * ratio 1 and this inverts that relationship.
 *
 * 130 rather than the 255 the Figma card draws its cover at: the deeper zoom
 * that would make a node literally 255px puts the camera at ratio 0.03, where
 * cluster-mates sit far enough apart that a selected node has no visible
 * neighbourhood left. The card's cover is deliberately about twice the size of
 * the nodes around it — see DESIGN.md "Nodes". */
const SELECT_NODE_PX = 130
const FLY_TO_RATIO = (2 * ART_SIZE / SELECT_NODE_PX) ** 2 // ~0.115

/* MO-7: a flat fly duration makes a forty-pixel hop crawl and a jump across
 * the whole library feel abrupt. Sub-linear (sqrt) so a merely-far target
 * doesn't take proportionally forever, clamped to the range the punch list
 * measured against the live app — DESIGN.md's original 120-200ms estimate
 * for this behavior only really covers the short end. Distance is measured
 * in on-screen pixels at the moment the fly starts (see flyToNode), not
 * graph units, so it means the same thing at every zoom level. */
const FLY_TO_DURATION_MIN_MS = 180
const FLY_TO_DURATION_MAX_MS = 420
const FLY_TO_DISTANCE_REFERENCE_PX = 2000 // distance at which duration reaches the max

function flyToDurationForDistance(distancePx: number): number {
  const t = Math.min(1, distancePx / FLY_TO_DISTANCE_REFERENCE_PX)
  return FLY_TO_DURATION_MIN_MS + (FLY_TO_DURATION_MAX_MS - FLY_TO_DURATION_MIN_MS) * Math.sqrt(t)
}

/* Hover dwell + dim crossfade (MO-6). Engaging the dim only after a short
 * dwell keeps a cursor merely passing over a dense cluster from strobing
 * enterNode/leaveNode dozens of times; crossfading it in and out keeps
 * leaving a node from snapping the whole canvas back at once. */
/* How far the pointer has to travel between mousedown and mouseup for the
 * gesture to be a drag rather than a click. Four pixels is below the smallest
 * deliberate drag and above the jitter a hand produces holding still on a
 * button. */
const DRAG_THRESHOLD_PX = 4

const HOVER_DWELL_MS = 90 // --motion-instant — used here as a debounce threshold, not a transition
const DIM_CROSSFADE_MS = 120 // --motion-exit

function osPrefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/* The only two things in this file that can't be CSS — WebGL has no
 * transitions of its own. One scalar, one rAF loop, terminates on reaching
 * its target: not an ongoing animation, so it doesn't fall foul of "nothing
 * animates on a loop". Snaps straight to the target when reduced motion
 * applies — the OS preference, or the app's own force-on override (see the
 * Settings "reduced motion" toggle). Returns a cancel function so a new
 * animation can interrupt one in flight without it fighting over the same
 * value. */
function animateScalar(
  from: number,
  to: number,
  durationMs: number,
  onFrame: (value: number) => void,
  reducedMotion: boolean,
  onDone?: () => void,
): () => void {
  if (reducedMotion) {
    onFrame(to)
    onDone?.()
    return () => {}
  }
  const start = performance.now()
  let raf = requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / durationMs)
    // Approximates --ease-out (cubic-bezier(0.2, 0, 0, 1)) closely enough for
    // a canvas scalar: starts fast, decelerates into place.
    const eased = 1 - (1 - t) ** 3
    onFrame(from + (to - from) * eased)
    if (t < 1) {
      raf = requestAnimationFrame(step)
    } else {
      onDone?.()
    }
  })
  return () => cancelAnimationFrame(raf)
}

function parseColorChannels(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    const n = Number.parseInt(color.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = color.match(/\d+/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [255, 255, 255]
}

/* Mixes toward the dim color as `t` goes 0 -> 1. Always resolves to an
 * opaque rgb() — G-2's fix depends on these values staying opaque, since
 * sigma's WebGL path renders a translucent color as solid white rather than
 * compositing it. */
function mixTowardDim(color: string, dim: string, t: number): string {
  if (t <= 0) return color
  if (t >= 1) return dim
  const [ar, ag, ab] = parseColorChannels(color)
  const [br, bg, bb] = parseColorChannels(dim)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const b = Math.round(ab + (bb - ab) * t)
  return `rgb(${r},${g},${b})`
}

/* The color an edge of this type should render at, folding in both the
 * Music Map settings panel's per-type override (src/panels/MusicMapSettings.tsx,
 * settings key `edgeColor:${type}`) and the same_artist quiet-mix above —
 * shared by syncGraph's creation-time paint and the edgeReducer's live
 * recompute below, so a color change made while looking at the canvas and a
 * freshly created edge never disagree about what "current" means. */
function edgeBaseColor(type: string, overrides: Record<string, string>): string {
  const raw = overrides[type] ?? EDGE_COLOR[type] ?? EDGE_COLOR_FALLBACK
  return type === 'same_artist' ? mixTowardDim(raw, DIMMED_EDGE_COLOR, SAME_ARTIST_QUIET_MIX) : raw
}

/* Atlas cell size, in texels, for one cover.
 *
 * Default NodeImageProgram sizes its cell off the source image's own
 * resolution ('auto' mode) — a cover squeezed into a much smaller cell then
 * gets minified across the atlas's 1px inter-image margin, which bleeds in as
 * a white fringe around every node. Forcing the cell removes that mismatch.
 *
 * The forced value was 64, which is where the low-resolution artwork came
 * from: a 44px node is 88 device pixels on a 2x display and grows further as
 * the camera zooms in, so 64 texels were being stretched over two to four
 * times their own size. 256 matches the cover cache's small derived size
 * exactly (server/src/cover/store.ts), so a cover is resampled once on the
 * server and copied 1:1 into the atlas here.
 *
 * Cost is real and worth naming: sigma keeps this atlas in GPU memory, at
 * 4 bytes per texel — 256KB per distinct cover. The by-hash image URL is what
 * makes that affordable, since a 12-track album is one texture rather than
 * twelve identical ones. */
const COVER_ATLAS_PX = 256

/* Two programs, same atlas configuration, differing only in the shape the
 * cover is cut to. keepWithinCircle is baked into each program's fragment
 * shader — it cannot be swapped per node by a render-time reducer, which is
 * why this is two programs rather than one attribute. */
const NodeCoverProgram = createNodeImageProgram({ size: { mode: 'force', value: COVER_ATLAS_PX } })
const NodeCoverSquareProgram = createNodeImageProgram({
  size: { mode: 'force', value: COVER_ATLAS_PX },
  keepWithinCircle: false,
})

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
 * A node dropped far from the pack doesn't necessarily drift back on its
 * own — forceLink's spring is deliberately weak (Legato.md), so a single
 * far-flung node can sit there for a while, or indefinitely if nothing pulls
 * on it. The fix belongs here rather than in the physics: frame the bulk of
 * the graph and let outliers sit off-screen until the user pans to them. */
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

/* G-8: the camera fits the given bbox to the FULL viewport, edge to edge —
 * sigma has no notion of the screen space the shell's chrome actually
 * covers. At every granularity, several nodes ended up placed permanently
 * underneath it: visible through the blur, unreachable by a click.
 *
 * v2 shell geometry (see DESIGN.md's shell section): a rail + Inspector
 * Panel on the left, a now-playing panel on the right, both docked flush to
 * their own window edge — no floating 51px inset any more, and the two
 * sides no longer reserve equal widths (350px left, 300px right). There is
 * also no continuous titlebar across the top any more — LeftPanelHeader and
 * RightPanelHeader only cover their own column, each stacked directly above
 * the rail/panel it belongs to — so nothing is reserved along the top
 * between the two side columns, and the top inset drops to 0.
 *
 * This always reserves each side's *expanded* footprint, even while that
 * side is actually collapsed — conservative in the same direction as the
 * rest of this comment already argues for: a node still ending up hidden is
 * the failure mode to avoid, a little unused canvas while collapsed is not.
 * Tracking live collapse state here to reclaim that space is a reasonable
 * follow-up, not done in this pass.
 *
 * A conservative rectangular inset rather than the true reserved shape,
 * since sigma's bbox fit only understands a rectangle anyway; erring toward
 * extra clearance is the safe direction, a node still ending up hidden is
 * not. TransportDock.tsx (121px tall, docked to the bottom) is unaffected
 * by any of this and keeps its own reservation as before.
 *
 * P-8: panel width is not a fixed pixel (tokens.css's --panel-width scales
 * with the window above 1440px) — the ratio/floor below duplicates that
 * same formula rather than reading it back from a live DOM element, the
 * same "sigma needs a concrete number, kept in sync by hand" tradeoff this
 * file already makes for EDGE_COLOR. The rail itself never scales — it is a
 * fixed 50px icon strip, not content, so widening the window has no reason
 * to widen it. */
const RAIL_WIDTH_PX = 50
const PANEL_WIDTH_MIN_PX = 300
const PANEL_REFERENCE_WIDTH_PX = 1440
const DOCK_HEIGHT_PX = 121

/* The rectangle of canvas the shell leaves uncovered, in viewport pixels.
 * Both the initial bbox fit and the fly target need the same answer. */
function shellFreeArea(renderer: Sigma): { left: number; right: number; top: number; bottom: number } {
  const dims = renderer.getDimensions()
  const panelWidthPx = Math.max(PANEL_WIDTH_MIN_PX, (dims.width * PANEL_WIDTH_MIN_PX) / PANEL_REFERENCE_WIDTH_PX)
  return {
    left: RAIL_WIDTH_PX + panelWidthPx,
    right: dims.width - panelWidthPx,
    top: 0,
    bottom: dims.height - DOCK_HEIGHT_PX,
  }
}

/* Where on screen a node should land when the camera flies to it.
 *
 * Not the viewport's centre, which is what this used to be. A selected node
 * grows the 665px card whose cover slot *is* that node, and the card reaches
 * ~511px to the node's right — so centring the node parked the card's entire
 * metadata column under the right-hand panel on every single selection, with
 * the edit control unreachable and the artist's name cut in half. Aiming the
 * card at the middle of the free canvas instead, and letting the node land
 * wherever that puts it, is the same fix G-8 already makes for the initial
 * bbox: sigma has no idea the panels are there, so this file has to.
 *
 * The card stays rigidly anchored to its node either way — this only chooses
 * where the node ends up. When the free strip is narrower than the card the
 * target clamps left rather than centring, which keeps the cover and the
 * start of every row on screen and lets only the far edge slide under. */
function flyTargetViewportPoint(renderer: Sigma): { x: number; y: number } {
  const area = shellFreeArea(renderer)
  const freeWidth = area.right - area.left
  const cardLeft =
    freeWidth >= NODE_CARD_WIDTH_PX ? area.left + (freeWidth - NODE_CARD_WIDTH_PX) / 2 : area.left
  return { x: cardLeft + NODE_CARD_COVER_CENTER_X, y: (area.top + area.bottom) / 2 }
}

function insetForShell(
  renderer: Sigma,
  bbox: { x: [number, number]; y: [number, number] },
): { x: [number, number]; y: [number, number] } {
  const dims = renderer.getDimensions()
  const area = shellFreeArea(renderer)
  const innerW = area.right - area.left
  const innerH = area.bottom - area.top
  if (innerW <= 0 || innerH <= 0) return bbox // window too small to inset meaningfully

  const bw = bbox.x[1] - bbox.x[0]
  const bh = bbox.y[1] - bbox.y[0]
  // v2's two side columns reserve different widths (rail + panel on the
  // left, panel alone on the right) — no longer the same footprint mirrored
  // on both sides, so each edge of the bbox needs its own padding.
  const padXLeft = (area.left / innerW) * bw
  const padXRight = ((dims.width - area.right) / innerW) * bw
  const padForScreenTop = (area.top / innerH) * bh
  const padForScreenBottom = (DOCK_HEIGHT_PX / innerH) * bh

  // Whether increasing graph-space y maps to the top or bottom of the
  // screen is an orientation baked into sigma's rendering matrix, not
  // something to assume — asked directly rather than guessed, using
  // whatever camera state already happens to be active.
  const yAtScreenTop = renderer.viewportToGraph({ x: dims.width / 2, y: 0 }).y
  const yAtScreenBottom = renderer.viewportToGraph({ x: dims.width / 2, y: dims.height }).y
  const [padAtYMin, padAtYMax] =
    yAtScreenTop > yAtScreenBottom ? [padForScreenBottom, padForScreenTop] : [padForScreenTop, padForScreenBottom]

  return {
    x: [bbox.x[0] - padXLeft, bbox.x[1] + padXRight],
    y: [bbox.y[0] - padAtYMin, bbox.y[1] + padAtYMax],
  }
}

/* Every node that resolves to art renders as that art, at every zoom level
 * and whatever its type — a track shows its album's cover exactly the way
 * that album does, rather than a colored dot standing in for one.
 *
 * This used to be gated by zoom (art bound only past a camera threshold) for
 * one reason: art was requested per node id, so a 12-track album was 12
 * identical textures in sigma's atlas and a library's worth of tracks was
 * thousands. The by-hash cover URL removes that — the atlas now holds one
 * texture per distinct cover, no matter how many nodes display it, so there
 * is nothing left for a level-of-detail gate to protect.
 *
 * `showArt` is this node's Music Map settings "images" toggle
 * (src/panels/MusicMapSettings.tsx, one flag per node type since 2026-08-29's
 * combined graph) — off falls back to the same colored-dot treatment a node
 * with no art at all already gets.
 *
 * Deliberately no `x`/`y` here — position is syncGraph's job below, and only
 * for a node's *first* appearance. An existing node's position belongs to
 * the live force simulation (src/canvas/forceSimulation.ts) from then on;
 * folding x/y into this object would let every resync stomp the
 * simulation's own live position back to stale server truth. */
function nodeAttributes(node: GraphNode, showArt: boolean): Record<string, unknown> {
  // Carried as its own attribute rather than re-derived from sigma's own
  // display `type` ('cover'/'coverSquare'/'circle') — nodeReducer needs the
  // *domain* type (src/canvas/nodeTypes.ts) to look up this node's own
  // per-type size multiplier (Music Map settings "nodes > size", #29), and
  // display type alone can't answer that (a colored-dot fallback is 'circle'
  // whatever its domain type is).
  if (node.cover_hash && showArt) {
    const square = SQUARE_COVER_TYPES.has(node.type)
    return {
      label: node.title,
      size: ART_SIZE,
      type: square ? 'coverSquare' : 'cover',
      // `square` is carried as its own attribute rather than re-derived from
      // `type` inside defaultDrawNodeHover: the hover layer only sees display
      // data, and the ring has to match the shape it's drawn around.
      square,
      image: `${API}/covers/${node.cover_hash}?size=thumb`,
      color: '#ffffff',
      origSize: ART_SIZE,
      nodeType: node.type,
    }
  }

  const size = NODE_SIZE[node.type] ?? 3
  const color = NODE_COLOR[node.type] ?? '#999'
  return { label: node.title, size, color, type: 'circle', square: false, origSize: size, nodeType: node.type }
}

// A node's starting position — server seed, or wherever the user last
// dropped it (persisted user_x/user_y). Only that: #46 changed dragging so
// a drop is a starting point, not a standing pin — see the mousemovebody
// drag recipe below for the part that used to make this permanent. Only
// ever consulted for a node's *first* appearance in the graph; see
// nodeAttributes above.
function initialPosition(node: GraphNode): { x: number; y: number } | null {
  const x = node.user_x ?? node.seed_x
  const y = node.user_y ?? node.seed_y
  if (x == null || y == null) return null
  return { x, y }
}

/* Updates the existing graphology instance in place to match the latest
 * fetched data — add/update/remove, never drop-and-rebuild — so the Sigma
 * renderer subscribed to this graph never needs to be torn down for a plain
 * data refresh. This is the actual fix for the bug that used to reset the
 * camera on every refetch: the renderer effect below only runs once per
 * mount, not on every `nodes`/`edges` change. */
function syncGraph(
  graph: Graph,
  nodes: GraphNode[],
  edges: GraphEdge[],
  showArt: (type: string) => boolean,
  showCreditNodes: boolean,
): void {
  const wantedNodes = new Map<string, GraphNode>()
  for (const node of nodes) {
    if (initialPosition(node) == null) continue // no position yet — nothing to plot
    // Music Map settings "nodes > producers" (#24) — 'credit' nodes
    // (producer/engineer credits) are seeded and served like any other type
    // now, but are new to an already-tuned graph, so they're opt-in rather
    // than appearing unannounced the moment this ships. Excluding them here
    // (rather than server-side) also drops their produced_by/engineered_by
    // edges for free, below: an edge is only kept when both its endpoints
    // are in this graph.
    if (node.type === 'credit' && !showCreditNodes) continue
    wantedNodes.set(nodeKey(node.id), node)
  }

  graph.forEachNode((key) => {
    if (!wantedNodes.has(key)) graph.dropNode(key)
  })
  for (const [key, node] of wantedNodes) {
    const attrs = nodeAttributes(node, showArt(node.type))
    if (graph.hasNode(key)) {
      graph.mergeNodeAttributes(key, attrs) // never x/y — see nodeAttributes above
    } else {
      const pos = initialPosition(node)!
      graph.addNode(key, { ...attrs, x: pos.x, y: pos.y })
    }
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
    // `color` here is only the pre-first-paint placeholder — the edgeReducer
    // below is what's actually authoritative on every draw, recomputed live
    // from `relType` so a color changed in the settings panel while looking
    // at the canvas doesn't need this edge re-created to show up.
    graph.addEdgeWithKey(edgeKey, from, to, { size: 0.5, color: EDGE_COLOR[edge.type] ?? EDGE_COLOR_FALLBACK, relType: edge.type })
  }

  graph.forEachEdge((edgeKey) => {
    if (!wantedEdgeKeys.has(edgeKey)) graph.dropEdge(edgeKey)
  })
}

type Props = {
  selectedNodeId: number | null
  onSelectNode: (id: number | null) => void
  /** Opens the full node inspector for whatever is selected — the card is a
   * summary, and everything deeper (facts, edges, lyrics, tag write-back)
   * lives behind this. */
  onOpenInspector: () => void
  /** Threaded straight through to NodeCard's own play button — the
   * selection card is the one canvas surface that needs it. */
  playback: Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum'>
  onStats?: (stats: { nodes: number; edges: number }) => void
  /** Settings "hover-dim" toggle. Gates only the neighbor-dim effect —
   * NodeHoverPlate still shows regardless, since naming the node under the
   * pointer is wayfinding, not the more aggressive dim-everything-else cue. */
  dimOnHoverEnabled?: boolean
  /** Settings "reduced motion" toggle — force-on only, layered on top of the
   * OS's own prefers-reduced-motion rather than a way to override it off. */
  reducedMotionForced?: boolean
  /** Music Map settings "nodes > images", one flag per node type in the
   * combined graph (2026-08-29 — previously one flag per granularity tab). */
  showArtistArt: boolean
  showReleaseArt: boolean
  showTrackArt: boolean
  /** Music Map settings "nodes > producers" (#24) — whether 'credit' nodes
   * (producer/engineer credits) are included in the graph at all. Unlike
   * the art toggles above, this gates node *existence*, not just how a node
   * renders — handled in syncGraph rather than a reducer. */
  showCreditNodes: boolean
  /** Music Map settings "nodes > size" (#29) — one multiplier per node type
   * (src/canvas/nodeTypes.ts), keyed by the domain type nodeAttributes
   * stashes on each node as `nodeType`. Multiplies that node's base size
   * (ART_SIZE or NODE_SIZE[type]) live, via nodeReducer. 1 is unchanged. */
  nodeSizeMultipliers: Record<string, number>
  /** Music Map settings "links > thickness" — multiplies EDGE_WIDTH_AT_RATIO_1
   * live, via edgeReducer. 1 is unchanged. */
  edgeThicknessMultiplier: number
  /** Music Map settings "links > colours" — type -> hex, for whichever types
   * have a user override; unlisted types render at their EDGE_COLOR default.
   * See edgeBaseColor above. */
  edgeColorOverrides: Record<string, string>
  /** Music Map settings "nodes > lock" — freezes the live force simulation
   * (src/canvas/forceSimulation.ts) without disabling drag; see
   * forceSimulation.ts's setLocked. */
  nodesLocked: boolean
  /** Music Map settings "forces" + "links > distance" — live inputs to the
   * force simulation. See forceSimulation.ts's ForceParams. */
  forceCenterStrength: number
  forceRepelStrength: number
  forceLinkStrength: number
  linkDistance: number
}

export type CanvasHandle = {
  /** Animates the camera to center on and zoom into a node — search results,
   * fact links, and hygiene worklist items all resolve to this so "select a
   * node" always means "go look at it," matching the canvas-first navigation
   * Legato.md calls out as the actual point of a spatial layout. No-op for a
   * node not currently in the graph. */
  flyToNode: (nodeId: number) => void
}

export default forwardRef<CanvasHandle, Props>(function Canvas(
  {
    selectedNodeId,
    onSelectNode,
    onOpenInspector,
    playback,
    onStats,
    dimOnHoverEnabled = true,
    reducedMotionForced = false,
    showArtistArt,
    showReleaseArt,
    showTrackArt,
    showCreditNodes,
    nodeSizeMultipliers,
    edgeThicknessMultiplier,
    edgeColorOverrides,
    nodesLocked,
    forceCenterStrength,
    forceRepelStrength,
    forceLinkStrength,
    linkDistance,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const rendererRef = useRef<Sigma | null>(null)
  const simulationRef = useRef<ForceSimulationHandle | null>(null)
  const { nodes, edges, loading } = useGraphData()
  const scanStatus = useScanStatus()

  // Shared by the imperative handle and by clicking a node on the canvas —
  // both mean "go look at this", and they must land in the same place at the
  // same zoom or the graph would move differently depending on whether you
  // arrived from search or from the canvas itself.
  const flyTo = useCallback((nodeId: number) => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    const key = nodeKey(nodeId)
    if (!graph || !renderer || !graph.hasNode(key)) return

    const attrs = graph.getNodeAttributes(key)
    const bbox = renderer.getCustomBBox() ?? renderer.getBBox()
    const normalize = createNormalizationFunction(bbox)
    const { x, y } = normalize({ x: attrs.x as number, y: attrs.y as number })

    // Distance the camera is actually about to travel, in the same
    // on-screen pixels the user perceives — where the target already
    // sits on screen right now, relative to where it is about to sit.
    // Graph-unit distance wouldn't mean the same thing at every zoom
    // level; this does.
    const landing = flyTargetViewportPoint(renderer)
    const currentViewport = renderer.graphToViewport({ x: attrs.x as number, y: attrs.y as number })
    const distancePx = Math.hypot(currentViewport.x - landing.x, currentViewport.y - landing.y)
    const duration =
      osPrefersReducedMotion() || reducedMotionForcedRef.current ? 0 : flyToDurationForDistance(distancePx)

    // The camera centres whatever it points at, and the node is not going to
    // the centre. Ask sigma which framed-graph point *would* sit at the
    // landing point if the camera were centred on the node, then reflect the
    // camera through the node by that much: a point twice as far from the
    // offending direction puts the node exactly where it is wanted. Done
    // through viewportToFramedGraph rather than by hand so it stays correct
    // through sigma's own padding and dimension handling.
    const camera = renderer.getCamera()
    const atLanding = renderer.viewportToFramedGraph(landing, {
      cameraState: { x, y, ratio: FLY_TO_RATIO, angle: camera.angle },
    })
    void camera.animate({ x: 2 * x - atLanding.x, y: 2 * y - atLanding.y, ratio: FLY_TO_RATIO }, { duration })
  }, [])

  useImperativeHandle(ref, () => ({ flyToNode: flyTo }), [flyTo])

  // Held in refs so effects below don't list them as dependencies — a parent
  // re-render must never tear down the renderer or reset the camera.
  const onSelectNodeRef = useRef(onSelectNode)
  const onStatsRef = useRef(onStats)
  const flyToRef = useRef(flyTo)
  // Read inside the renderer effect's click handler to decide whether a
  // click is a new selection or a toggle-off of the current one. A ref, not
  // the prop, because that effect deliberately runs once per mount —
  // depending on selectedNodeId would tear the renderer down and reset the
  // camera on every click.
  const selectedNodeIdRef = useRef(selectedNodeId)
  // Read by the renderer effect's dim/fly logic below, which runs once per
  // mount — same "ref, not the prop" reasoning as selectedNodeIdRef, so a
  // Settings toggle change doesn't tear the renderer down.
  const dimOnHoverEnabledRef = useRef(dimOnHoverEnabled)
  const reducedMotionForcedRef = useRef(reducedMotionForced)

  // Read live, every frame, by the reducers below — a slider drag fires
  // onChange continuously, and re-running syncGraph's full node/edge diff on
  // every intermediate value would be real cost on a library-sized graph.
  // Refs instead of state: changing them must never re-run the renderer
  // lifecycle effect below (which now runs once per mount, not per prop
  // change).
  const nodeSizeMultipliersRef = useRef(nodeSizeMultipliers)
  const edgeThicknessMultiplierRef = useRef(edgeThicknessMultiplier)
  const edgeColorOverridesRef = useRef(edgeColorOverrides)
  useEffect(() => {
    nodeSizeMultipliersRef.current = nodeSizeMultipliers
    edgeThicknessMultiplierRef.current = edgeThicknessMultiplier
    edgeColorOverridesRef.current = edgeColorOverrides
    rendererRef.current?.refresh()
  }, [nodeSizeMultipliers, edgeThicknessMultiplier, edgeColorOverrides])

  // Read by the drag handlers below, which are set up once inside the
  // renderer-lifecycle effect — a ref, not the prop, for the same reason as
  // dimOnHoverEnabledRef.
  const nodesLockedRef = useRef(nodesLocked)
  useEffect(() => {
    nodesLockedRef.current = nodesLocked
    simulationRef.current?.setLocked(nodesLocked)
  }, [nodesLocked])

  // Music Map settings "forces" + "links > distance" — pushed into the live
  // simulation on every change, same "real settings, not a re-mount" shape
  // as the multiplier effect above.
  useEffect(() => {
    simulationRef.current?.setParams({
      centerStrength: forceCenterStrength,
      repelStrength: forceRepelStrength,
      linkStrength: forceLinkStrength,
      linkDistance,
    })
  }, [forceCenterStrength, forceRepelStrength, forceLinkStrength, linkDistance])

  // Which node the hover plate is currently describing. Distinct from
  // sigma's own hover tracking below: that fires on every enterNode, this
  // only flips once the dwell has been held, so the plate and the dim
  // arrive as one event rather than two.
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null)

  // The same instance rendererRef holds, exposed as state purely so the
  // overlays below re-subscribe once the renderer-lifecycle effect below has
  // actually built one — a ref's identity never changes, so an effect keyed
  // on it would keep listening to a dead one.
  const [activeRenderer, setActiveRenderer] = useState<Sigma | null>(null)

  // #23: shift+drag rectangle multiselect. The ref is what the renderer
  // effect's gesture handlers below actually read/write (mount-once effect,
  // same "ref not prop" reasoning as everything else in this file) — the
  // state exists purely to drive the outline overlay's re-subscription
  // effect just below, mirroring activeRenderer's own reason for existing.
  // Both are written together by setMultiSelected, defined inside the
  // renderer-lifecycle effect.
  const multiSelectedRef = useRef<string[]>([])
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<string[]>([])
  const marqueeRef = useRef<HTMLDivElement>(null)
  const multiSelectOutlineRef = useRef<HTMLDivElement>(null)

  // Tracks the live screen-space bounding box of the current multiselect —
  // the one visual sign a group of nodes is selected (DESIGN.md: a node's
  // own rendering never changes to indicate state, so this is a surface next
  // to the nodes, the same idea as the hover plate and selection card, just
  // sized to a group instead of anchored to one node). Direct style writes
  // on 'afterRender', not React state, for the same per-frame-cost reason
  // useNodeAnchor already gives.
  useEffect(() => {
    const renderer = activeRenderer
    const element = multiSelectOutlineRef.current
    if (!renderer || !element || multiSelectedKeys.length < 2) {
      if (element) element.style.visibility = 'hidden'
      return
    }

    const PAD_PX = 12
    const update = () => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const key of multiSelectedKeys) {
        const display = renderer.getNodeDisplayData(key)
        if (!display) continue
        const { x, y } = renderer.framedGraphToViewport(display)
        const r = renderer.scaleSize(display.size)
        minX = Math.min(minX, x - r)
        maxX = Math.max(maxX, x + r)
        minY = Math.min(minY, y - r)
        maxY = Math.max(maxY, y + r)
      }
      if (!Number.isFinite(minX)) {
        element.style.visibility = 'hidden'
        return
      }
      element.style.visibility = ''
      element.style.transform = `translate(${minX - PAD_PX}px, ${minY - PAD_PX}px)`
      element.style.width = `${maxX - minX + PAD_PX * 2}px`
      element.style.height = `${maxY - minY + PAD_PX * 2}px`
    }

    update()
    renderer.on('afterRender', update)
    return () => {
      renderer.off('afterRender', update)
    }
  }, [activeRenderer, multiSelectedKeys])

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode
    onStatsRef.current = onStats
    flyToRef.current = flyTo
    selectedNodeIdRef.current = selectedNodeId
    dimOnHoverEnabledRef.current = dimOnHoverEnabled
    reducedMotionForcedRef.current = reducedMotionForced
  })

  // Renderer lifecycle — created once per mount (2026-08-29: used to be
  // once per granularity, back when switching artists/albums/tracks meant a
  // genuinely different graph; there's one combined graph now, see
  // Legato.md), NOT on every data refresh or settings change.
  useEffect(() => {
    if (!containerRef.current) return

    // multi: true — two nodes can hold more than one edge between them (a
    // produced_by and an engineered_by credit to the same person, say). See
    // syncGraph's edge-keying comment.
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
      nodeProgramClasses: { cover: NodeCoverProgram, coverSquare: NodeCoverSquareProgram },
      // Nodes with no art at all — a colored dot, and the only thing sigma's
      // own built-in program ever draws here.
      defaultNodeType: 'circle',
      // Kept as a no-op on purpose, and it has to stay here. Sigma routes
      // both `highlighted:true` nodes and the live mouse-hovered node
      // through this drawer, and without an override it falls back to a
      // stock black-on-white label box — so deleting this function does not
      // remove drawing from the hover layer, it restores sigma's own.
      //
      // Nothing is drawn on the hover canvas any more. Selection used to
      // grow a 74px ring here; it is now the glass card in NodeCard.tsx,
      // whose 255px cover completely covers a node and any ring around it
      // at every zoom the app can reach. Hover is the dim reducers below
      // plus NodeHoverPlate.tsx. Drag still sets `highlighted` (see the
      // drag recipe further down), which is what would otherwise surface
      // that stock label box mid-drag.
      defaultDrawNodeHover: () => {},
    })
    rendererRef.current = renderer
    setActiveRenderer(renderer)

    // Obsidian-style live physics (2026-08-29 — see Legato.md). The tick
    // callback is the one place simulation state becomes graph state: copy
    // every simulated node's current x/y into graphology, then ask sigma to
    // repaint. Node identity is d3-force's own (forceSimulation.ts), so this
    // stays correct across drags, resyncs, and lock/unlock without this
    // effect ever re-running.
    const sim = createForceSimulation(() => {
      for (const [key, simNode] of sim.nodesByKey) {
        if (!graph.hasNode(key)) continue
        graph.setNodeAttribute(key, 'x', simNode.x)
        graph.setNodeAttribute(key, 'y', simNode.y)
      }
      renderer.refresh()
    })
    simulationRef.current = sim
    sim.setLocked(nodesLockedRef.current)
    sim.setParams({
      centerStrength: forceCenterStrength,
      repelStrength: forceRepelStrength,
      linkStrength: forceLinkStrength,
      linkDistance,
    })

    // The data-sync effect below does an immediate bbox fit the moment data
    // first arrives, framed to the server's static seed layout — but real
    // physics visibly settles into a much more compact equilibrium than
    // that seed spread (center gravity + repulsion, not a permanent grid),
    // so that first fit is stale within seconds. This refits exactly once
    // more, to wherever the graph actually lands, the first time the
    // simulation genuinely settles (alpha decays below its threshold) —
    // graph.order gates out the empty-simulation 'end' this fires
    // immediately on creation, before any node has arrived. Never fires
    // again after that: a later reheat (a drag, a slider, a resync) must
    // not yank the camera out from under whatever the user is looking at.
    let hasFitAfterSettle = false
    sim.simulation.on('end.initialFit', () => {
      if (hasFitAfterSettle || graph.order === 0) return
      hasFitAfterSettle = true
      const bbox = robustBBox(graph)
      if (bbox) renderer.setCustomBBox(insetForShell(renderer, bbox))
    })

    // Hover/neighbor highlighting — dims everything not connected to the
    // hovered node, via sigma's render-time reducers rather than mutating
    // graph attributes, so it costs nothing to undo on leaveNode.
    //
    // dimProgress (0-1, MO-6) gates and crossfades the effect: it only
    // starts rising after HOVER_DWELL_MS of continuous hover, so dragging
    // the cursor across a dense cluster doesn't strobe the whole graph on
    // every enterNode/leaveNode, and it's mixed into the reducers' colors
    // frame by frame rather than cut, so leaving a node doesn't snap
    // everything back at once. hoveredNode/hoveredNeighbors are read by the
    // reducers below but only matter while dimProgress > 0 — safe to leave
    // pointing at a stale node between hovers, since a zero progress makes
    // every reducer below a no-op regardless of what they reference.
    let hoveredNode: string | null = null
    let hoveredNeighbors: Set<string> | null = null
    let dimProgress = 0
    let dwellTimeout: ReturnType<typeof setTimeout> | null = null
    let cancelDimAnim: (() => void) | null = null

    const setDimTarget = (target: number) => {
      cancelDimAnim?.()
      cancelDimAnim = animateScalar(
        dimProgress,
        target,
        DIM_CROSSFADE_MS,
        (v) => {
          dimProgress = v
          rendererRef.current?.refresh()
        },
        osPrefersReducedMotion() || reducedMotionForcedRef.current,
      )
    }

    renderer.setSetting('nodeReducer', (node, data) => {
      // Music Map settings "nodes > size" — applied before anything below,
      // to every node regardless of dim/hover state: a persistent size
      // preference isn't a per-frame state signal, so it doesn't run into
      // the art-preservation rule just below. One multiplier per node's own
      // domain type (nodeAttributes' `nodeType`), #29 — a type with no
      // override of its own reads 1 (unchanged) via
      // resolveNodeSizeMultipliers' fallback.
      const multiplier = nodeSizeMultipliersRef.current[data.nodeType as string] ?? 1
      const scaled = multiplier === 1 ? data : { ...data, size: (data.size as number) * multiplier }
      if (dimProgress <= 0 || node === hoveredNode || hoveredNeighbors?.has(node)) return scaled
      // #13: every de-emphasized node recedes, art-bound or not — this used
      // to leave cover/coverSquare nodes untouched here (just a `zIndex: 0`
      // that never took effect, since sigma's `zIndex` setting defaults off
      // and this file never turns it on), so hovering read as "everything is
      // highlighted" rather than as a dim: an artist or release node's
      // brightness genuinely never changed.
      //
      // @sigma/node-image can neither multiply-darken an opaque texture
      // (drawingMode "background" is a no-op once texel.a is 1) nor tint one
      // without fully replacing it (drawingMode "color" discards the image
      // outright) — there is no continuous crossfade available for a texture
      // the way mixTowardDim gives every flat-colored node below. So an art
      // node's dim is a hard cut straight to DIMMED_NODE_COLOR the instant
      // dimProgress engages, not an interpolation from its own color — that
      // attribute is only ever the inert `#ffffff` placeholder nodeAttributes
      // sets and NodeImageProgram never reads at rest, so crossfading from it
      // (the earlier attempt here) read as a bright white flash before
      // settling dark, on top of losing the release/track shape distinction.
      if (data.type === 'cover' || data.type === 'coverSquare') {
        return { ...scaled, type: 'circle', square: false, color: DIMMED_NODE_COLOR }
      }
      // Every other type has no art to protect, so its color crossfades
      // toward the dim tone continuously. `square` is cleared alongside
      // `type`: nothing downstream should be told a node is still a square
      // cover while it is being drawn as a plain dot.
      return {
        ...scaled,
        type: 'circle',
        square: false,
        color: mixTowardDim(scaled.color, DIMMED_NODE_COLOR, dimProgress),
      }
    })
    renderer.setSetting('edgeReducer', (edge, data) => {
      const size = EDGE_WIDTH_AT_RATIO_1 * edgeThicknessMultiplierRef.current * Math.sqrt(renderer.getCamera().ratio)
      const relType = data.relType as string | undefined
      const baseColor = relType ? edgeBaseColor(relType, edgeColorOverridesRef.current) : (data.color as string)
      if (dimProgress <= 0) return { ...data, size, color: baseColor }
      const [source, target] = graph.extremities(edge)
      if (source === hoveredNode || target === hoveredNode) return { ...data, size, color: baseColor }
      return { ...data, size, color: mixTowardDim(baseColor, DIMMED_EDGE_COLOR, dimProgress) }
    })

    renderer.on('enterNode', ({ node }) => {
      if (dwellTimeout != null) clearTimeout(dwellTimeout)
      hoveredNode = node
      hoveredNeighbors = new Set(graph.neighbors(node))
      dwellTimeout = setTimeout(() => {
        dwellTimeout = null
        // The Settings hover-dim toggle gates only this — the plate below
        // still names the node regardless, since that's wayfinding, not the
        // more aggressive "recede everything else" effect being toggled.
        if (dimOnHoverEnabledRef.current) setDimTarget(1)
        // The plate rides the same dwell as the dim rather than getting its
        // own threshold: they are one response to one gesture, and staggering
        // them would read as two things happening.
        setHoveredNodeId(Number(node))
      }, HOVER_DWELL_MS)
    })
    renderer.on('leaveNode', () => {
      // Unconditional, unlike the dim below — a plate that was never shown
      // costs nothing to hide, and this is also the path out of a hover that
      // ended because the node was dragged or the graph resynced.
      setHoveredNodeId(null)
      if (dwellTimeout != null) {
        // Dwell never engaged — nothing was ever dimmed, so there is
        // nothing to reverse. This is what stops a cursor sweeping across
        // a cluster from strobing it.
        clearTimeout(dwellTimeout)
        dwellTimeout = null
        return
      }
      if (dimOnHoverEnabledRef.current) setDimTarget(0)
    })

    // Standard sigma.js drag-node recipe: track the dragged node across
    // downNode -> mousemovebody -> mouseup, reposition it live, and PATCH
    // the server only once the drag actually ends — not on every frame.
    // 2026-08-29: also feeds the live simulation now, see mousemovebody
    // below — a drag no longer just repositions its own node, it reheats
    // the whole graph so neighbors visibly react (repel + collide pushing
    // out of the way), matching Obsidian's live-physics drag feel.
    let draggedNode: string | null = null
    let downAt: { x: number; y: number } | null = null
    // Whether the pointer has moved far enough since mousedown for this to be
    // a drag rather than a click.
    //
    // This was a bare boolean set by the first mousemove, which is not the
    // same question: sigma fires mousemovebody on sub-pixel jitter, so every
    // ordinary click on a node counted as a drag. It cost nothing while the
    // consequence was rewriting a node's position to where it already was,
    // and became load-bearing the moment a click also had to select and fly —
    // a click that registers as a drag now silently does nothing at all.
    let didDrag = false

    // #23: set once downNode fires on a node that's already part of the
    // current multiselect — every member's graph position at that moment, so
    // mousemovebody below can move each one by the same delta the pointer
    // travels rather than snapping every node in the group to the cursor
    // (which is what the single-node branch does, and is fine for one node,
    // but would collapse a group onto a single point).
    let groupDragOrigins: Map<string, { x: number; y: number }> | null = null
    let groupDragStartPointer: { x: number; y: number } | null = null

    const setMultiSelected = (keys: string[]) => {
      multiSelectedRef.current = keys
      setMultiSelectedKeys(keys)
    }

    renderer.on('downNode', (e) => {
      draggedNode = e.node
      didDrag = false
      downAt = { x: e.event.x, y: e.event.y }

      const current = multiSelectedRef.current
      if (current.length >= 2 && current.includes(e.node)) {
        groupDragOrigins = new Map(
          current.map((key) => [
            key,
            { x: graph.getNodeAttribute(key, 'x') as number, y: graph.getNodeAttribute(key, 'y') as number },
          ]),
        )
      } else {
        groupDragOrigins = null
        // Starting an ordinary drag on a node outside the current selection
        // drops it, the same way clicking outside a selection would in any
        // other app — this node is what the gesture is about now.
        if (current.length > 0) setMultiSelected([])
      }
    })

    renderer.on('clickNode', (e) => {
      if (didDrag) return
      // A real marquee drag that happened to release over a node — see
      // marqueeActive below. Consumed here so the click that sigma still
      // synthesizes for it (its own drag-distance tracking never saw the
      // movement, since the marquee handler below claims every intervening
      // mousemovebody with preventSigmaDefault) doesn't also select/fly.
      if (marqueeActive) return
      if (multiSelectedRef.current.length > 0) setMultiSelected([])
      const id = Number(e.node)
      // Clicking the selected node again clears it — one of the three ways
      // out of a selection, alongside clicking empty canvas and Escape
      // (App.tsx). No fly on the way out: the camera has already arrived
      // where the user asked it to go, and moving it again on dismissal
      // would undo a deliberate framing.
      if (selectedNodeIdRef.current === id) {
        onSelectNodeRef.current(null)
        return
      }
      onSelectNodeRef.current(id)
      flyToRef.current(id)
    })

    // Clicking the canvas itself is the deselect gesture. Nothing outside a
    // node has any other meaning here — panning is a drag, and sigma reports
    // that separately (and a marquee drag is claimed before it ever reaches
    // sigma's own drag tracking — see marqueeActive below).
    renderer.on('clickStage', () => {
      if (marqueeActive) return
      if (selectedNodeIdRef.current != null) onSelectNodeRef.current(null)
      if (multiSelectedRef.current.length > 0) setMultiSelected([])
    })

    // Sigma's captor answers a double-click by animating the camera to
    // ratio/2.2 over 200ms. DESIGN.md is explicit that the graph's own
    // pan/zoom is direct manipulation and never eased, and now that a single
    // click flies, a double-click would also race two camera animations
    // against each other. Suppressed on both the node and the stage.
    renderer.on('doubleClickNode', (e) => e.preventSigmaDefault())
    renderer.on('doubleClickStage', (e) => e.preventSigmaDefault())

    const mouseCaptor = renderer.getMouseCaptor()

    // Moves one node to a graph-space position, live — the shared tail end
    // of both the single-node and group-drag branches below. Mirrors the
    // pin/write-through split the single-node drag already used: a pinned
    // sim node (unlocked) is picked up by the simulation's own tick callback
    // (see createForceSimulation above, which copies sim positions into the
    // graph and refreshes every tick while alphaTarget keeps it running), so
    // only the locked case needs to write the graph directly here.
    const moveNodeTo = (key: string, x: number, y: number) => {
      const simNode = sim.nodesByKey.get(key)
      if (simNode) {
        simNode.fx = x
        simNode.fy = y
        simNode.x = x
        simNode.y = y
      }
      if (nodesLockedRef.current) {
        graph.setNodeAttribute(key, 'x', x)
        graph.setNodeAttribute(key, 'y', y)
      }
    }

    // #23: shift+drag rectangle multiselect. marqueeDownAt is set only when
    // the press both starts on empty canvas (draggedNode is still null at
    // that point — see handleMouseDown below) and has shift held, so an
    // ordinary empty-canvas drag keeps panning exactly as before. marqueeActive
    // flips true at the same DRAG_THRESHOLD_PX this file already uses to tell
    // a click from a drag, and is deliberately left set after mouseup (reset
    // instead at the top of the next handleMouseDown) — clickNode/clickStage
    // above read it to swallow the click sigma still synthesizes for the
    // gesture, the same role didDrag plays for an ordinary node drag.
    let marqueeDownAt: { x: number; y: number } | null = null
    let marqueeCurrentAt: { x: number; y: number } | null = null
    let marqueeActive = false

    const showMarqueeVisual = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const el = marqueeRef.current
      if (!el) return
      const x0 = Math.min(a.x, b.x)
      const x1 = Math.max(a.x, b.x)
      const y0 = Math.min(a.y, b.y)
      const y1 = Math.max(a.y, b.y)
      el.style.visibility = ''
      el.style.transform = `translate(${x0}px, ${y0}px)`
      el.style.width = `${x1 - x0}px`
      el.style.height = `${y1 - y0}px`
    }
    const hideMarqueeVisual = () => {
      const el = marqueeRef.current
      if (el) el.style.visibility = 'hidden'
    }

    // Every node whose current screen position falls inside the rectangle
    // between marqueeDownAt and wherever the pointer ended up. A rectangle
    // that catches fewer than two nodes clears the selection rather than
    // keeping one — a single node has no "group" to drag together, and a
    // plain click already covers selecting one node.
    const finalizeMarqueeSelection = () => {
      if (!marqueeDownAt || !marqueeCurrentAt) return
      const x0 = Math.min(marqueeDownAt.x, marqueeCurrentAt.x)
      const x1 = Math.max(marqueeDownAt.x, marqueeCurrentAt.x)
      const y0 = Math.min(marqueeDownAt.y, marqueeCurrentAt.y)
      const y1 = Math.max(marqueeDownAt.y, marqueeCurrentAt.y)
      const inside: string[] = []
      graph.forEachNode((key) => {
        const display = renderer.getNodeDisplayData(key)
        if (!display) return
        const { x, y } = renderer.framedGraphToViewport(display)
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) inside.push(key)
      })
      if (inside.length >= 2) {
        // A multiselect and an open selection card are two different ways of
        // looking at the graph; closing the card here keeps them from
        // overlapping on screen.
        if (selectedNodeIdRef.current != null) onSelectNodeRef.current(null)
        setMultiSelected(inside)
      } else {
        setMultiSelected([])
      }
    }

    mouseCaptor.on('mousemovebody', (e) => {
      if (marqueeDownAt && !draggedNode) {
        if (!marqueeActive) {
          if (Math.hypot(e.x - marqueeDownAt.x, e.y - marqueeDownAt.y) < DRAG_THRESHOLD_PX) return
          marqueeActive = true
        }
        marqueeCurrentAt = { x: e.x, y: e.y }
        showMarqueeVisual(marqueeDownAt, marqueeCurrentAt)
        e.preventSigmaDefault()
        return
      }

      if (!draggedNode || !downAt) return
      if (!didDrag) {
        if (Math.hypot(e.x - downAt.x, e.y - downAt.y) < DRAG_THRESHOLD_PX) return
        didDrag = true
        // Flagged only once this is a real drag, so an ordinary click never
        // routes the node through the hover canvas on its way to selecting.
        if (groupDragOrigins) {
          for (const key of groupDragOrigins.keys()) graph.setNodeAttribute(key, 'highlighted', true)
          groupDragStartPointer = renderer.viewportToGraph(e)
        } else {
          graph.setNodeAttribute(draggedNode, 'highlighted', true)
        }
        // Reheats the simulation for the drag's duration — held via
        // alphaTarget rather than a one-shot alpha bump (forceSimulation.ts's
        // reheat) so neighbors keep reacting continuously while the pointer
        // moves, not just once at drag start. Skipped while locked: the
        // simulation stays stopped, and this drag only ever moves the
        // dragged node(s) directly (the branch below).
        if (!nodesLockedRef.current) sim.simulation.alphaTarget(0.3).restart()
      }

      if (groupDragOrigins && groupDragStartPointer) {
        // Every member moves by the same graph-space delta the pointer has
        // travelled since the drag started — not "snap to cursor" (what the
        // single-node branch below does), which would collapse the whole
        // group onto one point.
        const pos = renderer.viewportToGraph(e)
        const dx = pos.x - groupDragStartPointer.x
        const dy = pos.y - groupDragStartPointer.y
        for (const [key, origin] of groupDragOrigins) moveNodeTo(key, origin.x + dx, origin.y + dy)
      } else {
        // Pinned only for the duration of this drag — handleMouseUp below
        // releases it back to free physics the moment the pointer lifts (#46:
        // used to stay pinned forever, "the user layer always wins"; Daniel's
        // call on #46 was that a drop should just give a node a better
        // starting position — literal Obsidian's own behavior — not weld it
        // in place against everything connected to it).
        const pos = renderer.viewportToGraph(e)
        moveNodeTo(draggedNode, pos.x, pos.y)
      }
      if (nodesLockedRef.current) {
        // Simulation is stopped, so nothing will tick this into the graph —
        // moveNodeTo already wrote the graph directly above; just repaint.
        renderer.refresh()
      }
      e.preventSigmaDefault()
    })

    // Releases a node's transient drag pin (moveNodeTo above sets fx/fy so
    // physics doesn't fight the cursor mid-drag) back to free physics — #46:
    // the drop position persists (patchNodePosition below) as this node's new
    // starting point, but it no longer stays welded there. Left set, a locked
    // drag's fx/fy would also resurface as a surprise permanent pin the next
    // time "nodes > lock" gets turned off.
    const releasePin = (key: string) => {
      const simNode = sim.nodesByKey.get(key)
      if (simNode) {
        simNode.fx = null
        simNode.fy = null
      }
    }

    const handleMouseUp = () => {
      if (draggedNode && didDrag) {
        if (groupDragOrigins) {
          for (const key of groupDragOrigins.keys()) {
            const id = Number(key)
            const simNode = sim.nodesByKey.get(key)
            const x = simNode ? (simNode.x as number) : (graph.getNodeAttribute(key, 'x') as number)
            const y = simNode ? (simNode.y as number) : (graph.getNodeAttribute(key, 'y') as number)
            graph.removeNodeAttribute(key, 'highlighted')
            releasePin(key)
            void patchNodePosition(id, x, y)
          }
        } else {
          const id = Number(draggedNode)
          const simNode = sim.nodesByKey.get(draggedNode)
          const x = simNode ? (simNode.x as number) : (graph.getNodeAttribute(draggedNode, 'x') as number)
          const y = simNode ? (simNode.y as number) : (graph.getNodeAttribute(draggedNode, 'y') as number)
          graph.removeNodeAttribute(draggedNode, 'highlighted')
          releasePin(draggedNode)
          void patchNodePosition(id, x, y)
        }
        if (!nodesLockedRef.current) sim.simulation.alphaTarget(0)
      }
      draggedNode = null
      downAt = null
      groupDragOrigins = null
      groupDragStartPointer = null

      if (marqueeDownAt) {
        if (marqueeActive) finalizeMarqueeSelection()
        hideMarqueeVisual()
        marqueeDownAt = null
        marqueeCurrentAt = null
      }
    }

    // Pins the projection while dragging so the graph does not reflow under
    // the cursor. Also where a shift+drag starting on empty canvas commits to
    // being a marquee-select instead of the default camera pan — draggedNode
    // is reliably up to date here already: sigma's own picking (which sets it,
    // via downNode above) runs synchronously inside the same native mousedown
    // that triggers this handler, and is registered first.
    const handleMouseDown = (e: { x: number; y: number; original: MouseEvent | TouchEvent }) => {
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
      marqueeActive = false
      marqueeDownAt = draggedNode == null && e.original.shiftKey ? { x: e.x, y: e.y } : null
      marqueeCurrentAt = marqueeDownAt
    }

    mouseCaptor.on('mouseup', handleMouseUp)
    mouseCaptor.on('mousedown', handleMouseDown)

    return () => {
      if (dwellTimeout != null) clearTimeout(dwellTimeout)
      cancelDimAnim?.()
      sim.simulation.stop()
      simulationRef.current = null
      renderer.kill()
      rendererRef.current = null
      graphRef.current = null
      setActiveRenderer(null)
    }
    // Deliberately [] — runs once per mount, not on data or settings
    // changes. onSelectNode/onStats/nodes and every live setting are read
    // through refs; force params/lock have their own sync effects above
    // that push into simulationRef without re-running this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Data sync — updates the existing graph in place whenever fetched data
  // changes, without touching the renderer (which would reset the camera).
  useEffect(() => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    if (!graph || !renderer || loading) return

    const hadNoNodes = graph.order === 0
    const showArt = (type: string) =>
      type === 'artist' ? showArtistArt : type === 'release' ? showReleaseArt : type === 'recording' ? showTrackArt : true
    syncGraph(graph, nodes, edges, showArt, showCreditNodes)
    onStatsRef.current?.({ nodes: graph.order, edges: graph.size })

    // Feeds the same post-sync graph state into the live simulation —
    // existing nodes keep their live position (nodeAttributes never writes
    // x/y for one, see its own comment), only a genuinely new node or a
    // changed radius (an images toggle) causes forceSimulation.ts to reheat.
    const simNodes: SimNodeInput[] = []
    graph.forEachNode((key, attrs) => {
      simNodes.push({ key, x: attrs.x as number, y: attrs.y as number, radius: attrs.size as number })
    })
    const simLinks: { source: string; target: string }[] = []
    graph.forEachEdge((_edgeKey, _attrs, source, target) => simLinks.push({ source, target }))
    simulationRef.current?.sync(simNodes, simLinks)

    // Only fit the camera to the data on the graph's first population for
    // this renderer (a fresh mount) — a background refresh of the same
    // graph must never move the viewport out from under whatever the user
    // is currently looking at.
    if (hadNoNodes) {
      const bbox = robustBBox(graph)
      if (bbox) {
        renderer.setCustomBBox(insetForShell(renderer, bbox))
      }
    }
    // The showArt flags and showCreditNodes are plain dependencies, not refs
    // like the settings above — toggling one is a discrete click, not a
    // continuous drag, so re-running the full node diff once per toggle
    // (rather than every frame) is the cheaper and simpler of the two
    // options.
  }, [nodes, edges, loading, showArtistArt, showReleaseArt, showTrackArt, showCreditNodes])

  // One sentence, muted, centered, no illustration — DESIGN.md's empty-state
  // rule. Ordered error > scanning > plain-empty: a failed scan is the most
  // specific and actionable thing to tell someone, an in-progress one at
  // least explains why the graph is still blank, and a real empty result
  // (a library that scanned clean with nothing in it) is the fallback.
  const showEmptyState = !loading && nodes.length === 0

  // The two in-place node states. Both are DOM rather than anything sigma
  // draws, because both are glass and backdrop-filter has no equivalent
  // inside a WebGL renderer — they sit in a layer over the canvas and are
  // pinned to their node by useNodeAnchor.
  //
  // Looked up from the fetched node list rather than from graphology so the
  // card and plate read the same title/subtitle the rest of the app does; a
  // few hundred nodes makes find() the cheaper of the two anyway.
  const selectedNode = selectedNodeId != null ? nodes.find((n) => n.id === selectedNodeId) : undefined
  // A node showing its card does not also get a plate: it already says what
  // it is, in more detail, in the same place.
  const hoveredNode =
    hoveredNodeId != null && hoveredNodeId !== selectedNodeId ? nodes.find((n) => n.id === hoveredNodeId) : undefined

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* #23: the rectangle itself, live while shift-dragging on empty
         * canvas — see the mousemovebody handler in the renderer effect
         * above. Hidden by default; shown/sized via direct style writes,
         * not React state, since it has to track every pointer move. */}
        <div
          ref={marqueeRef}
          className="absolute top-0 left-0 rounded-[4px] border border-[var(--color-hairline)] bg-white/6"
          style={{ visibility: 'hidden' }}
        />
        {/* The one visual sign a group of nodes is currently multiselected —
         * see the outline-tracking effect above. Node rendering itself never
         * changes (DESIGN.md "Nodes"): this is a surface next to the group,
         * the same idea as the hover plate and selection card. */}
        <div
          ref={multiSelectOutlineRef}
          className="absolute top-0 left-0 rounded-[12px] border border-[var(--color-hairline)]"
          style={{ visibility: 'hidden' }}
        />
        {hoveredNode && (
          <NodeHoverPlate
            key={hoveredNode.id}
            renderer={activeRenderer}
            nodeKey={nodeKey(hoveredNode.id)}
            title={hoveredNode.title}
            subtitle={hoveredNode.subtitle}
          />
        )}
        {selectedNode && (
          <div className="pointer-events-auto">
            <NodeCard
              key={selectedNode.id}
              renderer={activeRenderer}
              nodeId={selectedNode.id}
              nodeKey={nodeKey(selectedNode.id)}
              type={selectedNode.type}
              title={selectedNode.title}
              subtitle={selectedNode.subtitle}
              onOpenInspector={onOpenInspector}
              playback={playback}
            />
          </div>
        )}
      </div>
      {showEmptyState && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[12px] text-center">
          {scanStatus.error ? (
            <>
              <p className="max-w-[420px] text-[length:var(--text-base)] text-[var(--color-muted)]">
                scan failed: {scanStatus.error}
              </p>
              <Button onClick={scanStatus.retry} className="pointer-events-auto">
                retry
              </Button>
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
