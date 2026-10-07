import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { createNormalizationFunction } from 'sigma/utils'
import type { NodeLabelDrawingFunction } from 'sigma/rendering'
import { patchNodePosition, type GraphEdge, type GraphNode } from './useGraphData'
import { useGraph } from './graphContext'
import { EDGE_COLOR } from './edgeTypes'
import { computeClusters } from './clusters'
import { createForceSimulation, type ForceSimulationHandle, type SimNodeInput } from './forceSimulation'
import { useScanStatus } from '../hooks/useScanStatus'
import { NodeCard } from './NodeCard'
import { NODE_CARD_OFFSET, NODE_CARD_WIDTH_PX } from './nodeCardGeometry'
import { NodeHoverPlate } from './NodeHoverPlate'
import { NodePlayingHalo } from './NodePlayingHalo'
import { SelectionRing } from './SelectionRing'
import { MapLegend, MapToolbar } from './MapChrome'
import { MapNotice } from './MapStates'
import { averageColors, hashCoverUrl, sampleCoverColor } from '../ui/coverColor'
import { useShellLayout, type ShellLayout, INSET, CAPSULE_HEIGHT } from '../shell/layout'
import type { usePlayback } from '../playback/usePlayback'
import type { ResolvedTheme } from '../hooks/useTheme'

/* Node radii, in sigma's screen-referenced units (a size of 4 is a 4px
 * radius at camera ratio 1, growing with the square root of zoom).
 *
 * v2 draws the map as dots, not covers. Covers at node size were the main
 * reason the map was hard to read: a thousand 44px pictures is a mosaic, not
 * a graph. A dot's size and tone now say what it is — an artist is the
 * largest and brightest, its records smaller, its tracks smallest and
 * quietest — and cover colour comes back as each cluster's glow. An artist
 * grows a little with its number of records, capped so a box set doesn't
 * swallow its neighbours. */
const RELEASE_SIZE = 2.6
const RECORDING_SIZE = 1.5
const CREDIT_SIZE = 2.4
const OTHER_SIZE = 2
const ARTIST_BASE_SIZE = 3.5
const ARTIST_SIZE_PER_RELEASE = 0.6
const ARTIST_SIZE_MAX_RELEASES = 10

function artistSize(releaseCount: number): number {
  return ARTIST_BASE_SIZE + Math.min(releaseCount, ARTIST_SIZE_MAX_RELEASES) * ARTIST_SIZE_PER_RELEASE
}

/* Edges are hairlines: 0.6px unfocused, 0.8px on a focused cluster, in
 * on-screen pixels at every zoom (the reducer divides out sigma's own
 * zoom scaling). */
const EDGE_PX = 0.6
const EDGE_FOCUSED_PX = 0.8
/* While something is focused: its cluster's edges in their type colours at
 * 85%; every other edge drops to 60% of its usual (already faint) alpha.
 * Out-of-focus nodes sit at 30%, their labels at 45%. */
const FOCUSED_EDGE_ALPHA = 0.85
const UNFOCUSED_EDGE_ALPHA = 0.6
const UNFOCUSED_NODE_ALPHA = 0.3
const UNFOCUSED_LABEL_ALPHA = 0.45
const UNFOCUSED_GLOW_ALPHA = 0.35
/* "Colour edges by type" off-focus: type hue, but quiet enough that the
 * clusters still read as shapes rather than as a tangle of colour. */
const TYPED_EDGE_ALPHA = 0.35

/* Which focused edges get a type colour, and which hue: the four
 * relationships v2's map names. member_of borrows featured-artist's green. */
const FOCUS_EDGE_TOKEN: Record<string, string> = {
  performed_by: 'performed_by',
  appears_on: 'appears_on',
  produced_by: 'produced_by',
  member_of: 'featured_artist',
}

/* Every colour sigma draws, resolved once per theme from tokens.css (sigma
 * renders to WebGL and never sees CSS), cached in a ref and read by the
 * reducers and the label and glow layers every frame. */
type ThemeColors = {
  node: Record<string, string>
  edgeType: Record<string, string>
  edge: string
  edgeFallback: string
  canvas: string
  ink: string
  ink2: string
  ink3: string
  halo: string
  glowAlpha: number
}

const DEFAULT_THEME_COLORS: ThemeColors = {
  node: { artist: '#f2efe9', release: '#b8bcbe', recording: '#6c7174', credit: '#8fd3bd', label: '#74797c', year: '#74797c', work: '#74797c' },
  edgeType: EDGE_COLOR,
  edge: 'rgba(255,255,255,0.075)',
  edgeFallback: 'rgba(255,255,255,0.12)',
  canvas: '#0f1214',
  ink: '#f2efe9',
  ink2: '#a9adaf',
  ink3: '#74797c',
  halo: '#0f1214',
  glowAlpha: 0.16,
}

/* Sigma's colour parser reads hex and comma rgb()/rgba(), not CSS4's
 * space-separated rgb(r g b / a), which is how a browser serialises the
 * translucent tokens. Normalise whatever getComputedStyle hands back. */
function toSigmaColor(css: string, fallback: string): string {
  const value = css.trim()
  if (!value) return fallback
  if (value.startsWith('#')) return value
  const nums = value.match(/[\d.]+%?/g)
  if (!nums || nums.length < 3) return fallback
  const [r, g, b] = nums.slice(0, 3).map(Number)
  if (nums.length < 4) return `rgb(${r},${g},${b})`
  const a = nums[3].endsWith('%') ? Number(nums[3].slice(0, -1)) / 100 : Number(nums[3])
  return `rgba(${r},${g},${b},${a})`
}

function resolveThemeColors(): ThemeColors {
  if (typeof document === 'undefined') return DEFAULT_THEME_COLORS
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => toSigmaColor(style.getPropertyValue(name), fallback)
  const node: Record<string, string> = {}
  for (const type of Object.keys(DEFAULT_THEME_COLORS.node)) {
    node[type] = read(`--color-node-${type}`, DEFAULT_THEME_COLORS.node[type])
  }
  const edgeType: Record<string, string> = {}
  for (const type of Object.keys(EDGE_COLOR)) {
    edgeType[type] = read(`--color-edge-${type.replace(/_/g, '-')}`, EDGE_COLOR[type])
  }
  const glow = Number.parseFloat(style.getPropertyValue('--map-glow'))
  return {
    node,
    edgeType,
    edge: read('--color-edge', DEFAULT_THEME_COLORS.edge),
    edgeFallback: read('--color-edge-fallback', DEFAULT_THEME_COLORS.edgeFallback),
    canvas: read('--color-canvas', DEFAULT_THEME_COLORS.canvas),
    ink: read('--color-ink', DEFAULT_THEME_COLORS.ink),
    ink2: read('--color-ink-2', DEFAULT_THEME_COLORS.ink2),
    ink3: read('--color-ink-3', DEFAULT_THEME_COLORS.ink3),
    halo: read('--color-halo', DEFAULT_THEME_COLORS.halo),
    glowAlpha: Number.isFinite(glow) ? glow : DEFAULT_THEME_COLORS.glowAlpha,
  }
}

/* How far in a selection flies. The camera frames the selected node's whole
 * cluster — the point of selecting is to see a record among its siblings,
 * not to stare at one dot — at no more than FOCUS_FILL of the free space,
 * and never deeper than MIN_FOCUS_RATIO (a lone single would otherwise fill
 * the screen) or shallower than the overview. */
const FOCUS_FILL = 0.55
const MIN_FOCUS_RATIO = 0.04
const MAX_FOCUS_RATIO = 1

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

/* #56: duration for the one-time settle refit (`end.initialFit` below). A
 * plain constant rather than flyTo's distance-scaled range — this always
 * reframes the whole graph by roughly the same relative amount (seed spread
 * to settled equilibrium), not a variable hop to one node, so there's no
 * distance to scale against. Above DESIGN.md's headline 120-200ms: it's
 * animating every node's screen position at once (see animateBBox), not one
 * element moving, and needs a beat longer to read as a deliberate reframe
 * rather than a fast blur. */
const SETTLE_REFIT_DURATION_MS = 320

/* Hover dwell + dim crossfade (MO-6). Engaging the dim only after a short
 * dwell keeps a cursor merely passing over a dense cluster from strobing
 * enterNode/leaveNode dozens of times; crossfading it in and out keeps
 * leaving a node from snapping the whole canvas back at once. */
/* How far the pointer has to travel between mousedown and mouseup for the
 * gesture to be a drag rather than a click. Four pixels is below the smallest
 * deliberate drag and above the jitter a hand produces holding still on a
 * button. */
const DRAG_THRESHOLD_PX = 4

const HOVER_DWELL_MS = 90 // was --motion-instant's value before the gpui-kit port zeroed that token; a debounce threshold, not a transition, so it keeps its own number
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

/* #56: the settle-time camera refit (see `end.initialFit` below) used to call
 * setCustomBBox once, straight to the settled bbox. Every node's on-screen
 * position is a function of the *current* bbox — Sigma renormalizes every
 * node's coordinate against it on the next process(), not just the camera —
 * so a single hard swap moved every node on screen in the same frame. That
 * read as the whole graph jittering, not as a camera move. Interpolating the
 * bbox itself, frame by frame, keeps the same renormalization but spreads it
 * across a short ease instead of one jump, matching how flyTo above already
 * treats a programmatic reframe (DESIGN.md's Motion section: "camera moves to
 * a searched node" are eased, unlike direct-manipulation pan/zoom/drag). */
function animateBBox(
  renderer: Sigma,
  from: { x: [number, number]; y: [number, number] },
  to: { x: [number, number]; y: [number, number] },
  durationMs: number,
  reducedMotion: boolean,
): () => void {
  if (reducedMotion) {
    renderer.setCustomBBox(to)
    renderer.refresh()
    return () => {}
  }
  const start = performance.now()
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  let raf = requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / durationMs)
    // Same --ease-out approximation as animateScalar above.
    const eased = 1 - (1 - t) ** 3
    renderer.setCustomBBox({
      x: [lerp(from.x[0], to.x[0], eased), lerp(from.x[1], to.x[1], eased)],
      y: [lerp(from.y[0], to.y[0], eased), lerp(from.y[1], to.y[1], eased)],
    })
    renderer.refresh()
    if (t < 1) raf = requestAnimationFrame(step)
  })
  return () => cancelAnimationFrame(raf)
}


function parseColorChannels(color: string): [number, number, number, number] {
  if (color.startsWith('#')) {
    const n = Number.parseInt(color.slice(1, 7), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = color.match(/[\d.]+/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : 1] : [255, 255, 255, 1]
}

/* Mixes toward another colour as `t` goes 0 -> 1, always resolving to an
 * opaque rgb(). Nodes recede this way rather than by alpha: sigma's node
 * program draws a translucent fill as solid, so "30% opacity" is a mix
 * toward the canvas. */
function mixToward(color: string, toward: string, t: number): string {
  if (t <= 0) return color
  const [ar, ag, ab] = parseColorChannels(color)
  const [br, bg, bb] = parseColorChannels(toward)
  const k = Math.min(1, t)
  return `rgb(${Math.round(ar + (br - ar) * k)},${Math.round(ag + (bg - ag) * k)},${Math.round(ab + (bb - ab) * k)})`
}

/* Edges are drawn by sigma's line program, which does composite alpha — so
 * an edge's emphasis is its colour's own alpha, scaled here. */
function withAlphaFactor(color: string, factor: number, baseAlpha?: number): string {
  const [r, g, b, a] = parseColorChannels(color)
  return `rgba(${r},${g},${b},${(baseAlpha ?? a) * factor})`
}

/* The hue an edge of this type shows when it's coloured at all: the user's
 * own override from the old map settings first, then the curated palette. */
function edgeHue(type: string, overrides: Record<string, string>, colors: ThemeColors): string {
  const token = FOCUS_EDGE_TOKEN[type] ?? type
  return overrides[type] ?? colors.edgeType[token] ?? colors.edgeFallback
}

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
 * own — forceLink's spring is deliberately weak, so a single
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


/* The rectangle of the window the shell leaves uncovered, in viewport px:
 * between the left and right occupancy, below the capsule, above the
 * player's row. The camera has to know it — sigma has no idea the glass is
 * there, and a node fitted under a panel is visible but unreachable.
 *
 * Read from the live shell layout (through a ref), so opening a panel moves
 * where the next fit or fly lands without rebuilding the renderer. */
function freeArea(renderer: Sigma, layout: ShellLayout): { left: number; right: number; top: number; bottom: number } {
  const dims = renderer.getDimensions()
  return {
    left: layout.leftOccupancy,
    right: dims.width - layout.rightOccupancy,
    top: INSET + CAPSULE_HEIGHT + INSET,
    bottom: dims.height - layout.floatingBottom,
  }
}

/* Where a selected node should land: placed so the node and its card,
 * which opens NODE_CARD_OFFSET to the node's right and above it, sit
 * together in the middle of the free space. Clamped left when the free
 * strip is narrower than the pair. */
function flyLandingPoint(renderer: Sigma, layout: ShellLayout): { x: number; y: number } {
  const area = freeArea(renderer, layout)
  const pairWidth = NODE_CARD_OFFSET.x + NODE_CARD_WIDTH_PX
  const freeWidth = area.right - area.left
  const x = freeWidth >= pairWidth + 80 ? area.left + (freeWidth - pairWidth) / 2 : area.left + 40
  // The card rises NODE_CARD_OFFSET.y above the node and hangs about 140px
  // below it; centre that span, not the node.
  return { x, y: (area.top + area.bottom) / 2 - 50 }
}

/* The camera ratio that fits a set of nodes into FOCUS_FILL of the free
 * area. Sigma frames graph coordinates into a unit square, and at ratio r
 * one framed unit spans k/r viewport pixels — k measured here by asking
 * sigma to convert two points at ratio 1, so it stays right through sigma's
 * own padding and aspect handling. */
function ratioToFit(renderer: Sigma, graph: Graph, keys: Iterable<string>, layout: ShellLayout): number {
  const bbox = renderer.getCustomBBox() ?? renderer.getBBox()
  const normalize = createNormalizationFunction(bbox)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const key of keys) {
    if (!graph.hasNode(key)) continue
    const p = normalize({ x: graph.getNodeAttribute(key, 'x') as number, y: graph.getNodeAttribute(key, 'y') as number })
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return MAX_FOCUS_RATIO
  const unit = { cameraState: { x: 0.5, y: 0.5, ratio: 1, angle: 0 } }
  const a = renderer.viewportToFramedGraph({ x: 0, y: 0 }, unit)
  const b = renderer.viewportToFramedGraph({ x: 100, y: 100 }, unit)
  const pxPerUnitX = 100 / Math.max(1e-9, Math.abs(b.x - a.x))
  const pxPerUnitY = 100 / Math.max(1e-9, Math.abs(b.y - a.y))
  const area = freeArea(renderer, layout)
  const needed = Math.max(
    ((maxX - minX) * pxPerUnitX) / (FOCUS_FILL * Math.max(1, area.right - area.left)),
    ((maxY - minY) * pxPerUnitY) / (FOCUS_FILL * Math.max(1, area.bottom - area.top)),
  )
  return Math.min(MAX_FOCUS_RATIO, Math.max(MIN_FOCUS_RATIO, needed))
}

/* The initial fit and the "re-center" reframe pad the graph's bbox so that,
 * fitted edge to edge, its content lands inside the free area instead. A
 * rectangle, because sigma's bbox fit only understands one. */
function insetForShell(
  renderer: Sigma,
  bbox: { x: [number, number]; y: [number, number] },
  layout: ShellLayout,
): { x: [number, number]; y: [number, number] } {
  const dims = renderer.getDimensions()
  const area = freeArea(renderer, layout)
  const innerW = area.right - area.left
  const innerH = area.bottom - area.top
  if (innerW <= 0 || innerH <= 0) return bbox

  const bw = bbox.x[1] - bbox.x[0]
  const bh = bbox.y[1] - bbox.y[0]
  const padXLeft = (area.left / innerW) * bw
  const padXRight = ((dims.width - area.right) / innerW) * bw
  const padForScreenTop = (area.top / innerH) * bh
  const padForScreenBottom = ((dims.height - area.bottom) / innerH) * bh

  // Whether graph y grows up or down the screen is baked into sigma's
  // matrix, so ask rather than assume.
  const yAtScreenTop = renderer.viewportToGraph({ x: dims.width / 2, y: 0 }).y
  const yAtScreenBottom = renderer.viewportToGraph({ x: dims.width / 2, y: dims.height }).y
  const [padAtYMin, padAtYMax] =
    yAtScreenTop > yAtScreenBottom ? [padForScreenBottom, padForScreenTop] : [padForScreenTop, padForScreenBottom]

  return {
    x: [bbox.x[0] - padXLeft, bbox.x[1] + padXRight],
    y: [bbox.y[0] - padAtYMin, bbox.y[1] + padAtYMax],
  }
}

/* #127/H9: "the map spread out of view" recovery. A maxed-out repel slider
 * (or, less directly, a dragged-far outlier that robustBBox above already
 * knows to ignore) can push the graph's own mass entirely off screen — the
 * canvas then looks empty, not lost, with nothing on it to click "recenter"
 * on. rangesOverlap is the one genuinely pure piece of this (see
 * mapPresets.spec.ts's sibling for the rest of #127's pure logic); the two
 * below it need a live Sigma renderer for coordinate conversion and aren't
 * worth mocking one for. */

/** True when the two closed intervals share any point at all. */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

/** Screen-space rectangle, in this renderer's own viewport pixels, that a
 * graph-space bbox projects to right now. Four corners, not two — camera
 * angle is normally 0 here, but nothing about Sigma's camera model
 * guarantees that stays true, and min/max over all four is correct either
 * way. */
function graphViewportRect(
  renderer: Sigma,
  bbox: { x: [number, number]; y: [number, number] },
): { x: [number, number]; y: [number, number] } {
  const corners = [
    renderer.graphToViewport({ x: bbox.x[0], y: bbox.y[0] }),
    renderer.graphToViewport({ x: bbox.x[1], y: bbox.y[0] }),
    renderer.graphToViewport({ x: bbox.x[0], y: bbox.y[1] }),
    renderer.graphToViewport({ x: bbox.x[1], y: bbox.y[1] }),
  ]
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] }
}

/** True once the graph's own mass (robustBBox, not a stray outlier) has
 * drifted entirely off screen — checked only on the simulation's own `end`
 * event (see `end.outOfViewCheck` below), not every tick or every camera
 * pan. Sorting every node's x/y for robustBBox on every animation frame
 * would be real, needless cost, and "spread off screen" is a
 * physics-settling condition, not a pan gesture — panning the camera away
 * on purpose is a different thing and correctly doesn't trip this. */
function graphOutOfView(renderer: Sigma, graph: Graph): boolean {
  const bbox = robustBBox(graph)
  if (!bbox) return false
  const rect = graphViewportRect(renderer, bbox)
  const dims = renderer.getDimensions()
  return !rangesOverlap(rect.x, [0, dims.width]) || !rangesOverlap(rect.y, [0, dims.height])
}

/* A node's display attributes: a dot, sized and coloured by type. No x/y
 * here — position is syncGraph's job, and only for a node's first
 * appearance; after that it belongs to the live force simulation, and a
 * resync must never stomp it back to stale server truth. `nodeType` is
 * carried separately from sigma's display `type` because the reducers key
 * visibility, size multipliers and labels on the domain type. */
function nodeAttributes(node: GraphNode, size: number, colors: ThemeColors): Record<string, unknown> {
  return { label: node.title, size, color: colors.node[node.type] ?? colors.node.label, type: 'circle', nodeType: node.type }
}

// A node's starting position — server seed, or wherever the user last
// dropped it (persisted user_x/user_y). #46: a drop is a starting point, not
// a standing pin. Only consulted for a node's first appearance.
function initialPosition(node: GraphNode): { x: number; y: number } | null {
  const x = node.user_x ?? node.seed_x
  const y = node.user_y ?? node.seed_y
  if (x == null || y == null) return null
  return { x, y }
}

/* Updates the graphology instance in place to match the latest fetch —
 * add/update/remove, never drop-and-rebuild — so the renderer subscribed to
 * it never needs tearing down for a data refresh, and the camera never
 * resets under the user.
 *
 * Producer and engineer credits are opt-in (#24) and are left out of the
 * graph entirely when off, physics included: they're new to an
 * already-tuned map. The other "show" toggles only hide nodes at render
 * time (the node reducer), so hiding tracks doesn't change the shape of the
 * map, only what's drawn on it. */
function syncGraph(
  graph: Graph,
  nodes: GraphNode[],
  edges: GraphEdge[],
  showCreditNodes: boolean,
  sizeOf: (node: GraphNode) => number,
  colors: ThemeColors,
): void {
  const wantedNodes = new Map<string, GraphNode>()
  for (const node of nodes) {
    if (initialPosition(node) == null) continue // no position yet — nothing to plot
    if (node.type === 'credit' && !showCreditNodes) continue
    wantedNodes.set(nodeKey(node.id), node)
  }

  graph.forEachNode((key) => {
    if (!wantedNodes.has(key)) graph.dropNode(key)
  })
  for (const [key, node] of wantedNodes) {
    const attrs = nodeAttributes(node, sizeOf(node), colors)
    if (graph.hasNode(key)) {
      graph.mergeNodeAttributes(key, attrs) // never x/y — see nodeAttributes above
    } else {
      const pos = initialPosition(node)!
      graph.addNode(key, { ...attrs, x: pos.x, y: pos.y })
    }
  }

  // Keyed by (from, to, type): two nodes can share more than one relation,
  // and a plain Graph allows one edge per pair — hence the multigraph.
  const wantedEdgeKeys = new Set<string>()
  for (const edge of edges) {
    const from = nodeKey(edge.from_node)
    const to = nodeKey(edge.to_node)
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue
    const edgeKey = `${from}->${to}::${edge.type}`
    wantedEdgeKeys.add(edgeKey)
    if (graph.hasEdge(edgeKey)) continue
    // The colour here is only a pre-first-paint placeholder; the edge
    // reducer recomputes it every frame from relType and focus.
    graph.addEdgeWithKey(edgeKey, from, to, { size: EDGE_PX, color: colors.edge, relType: edge.type })
  }

  graph.forEachEdge((edgeKey) => {
    if (!wantedEdgeKeys.has(edgeKey)) graph.dropEdge(edgeKey)
  })
}

type Props = {
  selectedNodeId: number | null
  onSelectNode: (id: number | null) => void
  /** "details ›" on the node card: opens the right-hand details panel. */
  onOpenDetails: () => void
  playback: Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum' | 'playTracks' | 'status' | 'queueBusy'>
  onStats?: (stats: { nodes: number; edges: number }) => void
  /** Settings "hover-dim": a held hover focuses the hovered node's
   * neighbourhood the way a selection focuses a cluster. */
  dimOnHoverEnabled?: boolean
  /** Settings "reduced motion" — force-on only, layered over the OS's own. */
  reducedMotionForced?: boolean
  /** Map options "show": which node types are drawn. */
  showArtists: boolean
  showReleases: boolean
  showTracks: boolean
  /** Map options "show producers" (#24) — unlike the three above, this
   * gates whether credit nodes exist in the graph at all. */
  showCreditNodes: boolean
  /** Map options "artist labels". */
  showArtistLabels: boolean
  /** Map options "colour edges by type": type hues on every edge, not just
   * a selection's cluster. */
  colourEdgesByType: boolean
  /** The shipped map settings' per-type size multipliers (#29), edge
   * thickness and user edge colours. No v2 control writes them any more,
   * but a library that set them keeps them. */
  nodeSizeMultipliers: Record<string, number>
  edgeThicknessMultiplier: number
  edgeColorOverrides: Record<string, string>
  /** Map options "lock layout" — freezes the live simulation, keeps drag. */
  nodesLocked: boolean
  /** Map options' layout presets and sliders — live simulation inputs. */
  forceCenterStrength: number
  forceRepelStrength: number
  forceLinkStrength: number
  linkDistance: number
  /** #127/H9: the out-of-view notice's "restore defaults". */
  onRestoreDefaults?: () => void
  /** The map options popover's content, opened from the map toolbar. */
  mapOptions: ReactNode
  /** #136: tells the renderer to re-resolve every colour it draws. */
  theme: ResolvedTheme
}

export type CanvasHandle = {
  /** Selects nothing itself — animates the camera to frame the node's
   * cluster, landing the node where its card has room. Search results,
   * connection chips and worklist rows all come through here, so arriving
   * from anywhere leaves the map in the same place. */
  flyToNode: (nodeId: number) => void
}

type LabelKind = 'artist' | 'release' | 'credit'

/* What a selection or a held hover brings forward: a set of node keys, and
 * — for a selection — the cluster whose glow stays at full strength. */
type Focus = { keys: Set<string>; cluster: number | null }

/* A selected node focuses its whole cluster, plus its own neighbours (so a
 * producer, who has no cluster, focuses everything they produced). */
function focusFor(nodeId: number, graph: Graph | null, clusterOf: Map<number, number>, members: Map<number, string[]>): Focus {
  const key = nodeKey(nodeId)
  const cluster = clusterOf.get(nodeId) ?? null
  const keys = new Set<string>(cluster != null ? (members.get(cluster) ?? []) : [])
  keys.add(key)
  if (graph?.hasNode(key)) for (const neighbour of graph.neighbors(key)) keys.add(neighbour)
  return { keys, cluster }
}

/* Physics keeps nodes apart by their drawn radius plus this much, so dots in
 * a cluster sit close without overlapping. */
const COLLIDE_PADDING = 1.5

export default forwardRef<CanvasHandle, Props>(function Canvas(
  {
    selectedNodeId,
    onSelectNode,
    onOpenDetails,
    playback,
    onStats,
    dimOnHoverEnabled = true,
    reducedMotionForced = false,
    showArtists,
    showReleases,
    showTracks,
    showCreditNodes,
    showArtistLabels,
    colourEdgesByType,
    nodeSizeMultipliers,
    edgeThicknessMultiplier,
    edgeColorOverrides,
    nodesLocked,
    forceCenterStrength,
    forceRepelStrength,
    forceLinkStrength,
    linkDistance,
    onRestoreDefaults,
    mapOptions,
    theme,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const rendererRef = useRef<Sigma | null>(null)
  const simulationRef = useRef<ForceSimulationHandle | null>(null)
  const { nodes, edges, loading, byId } = useGraph()
  const scanStatus = useScanStatus()
  const layout = useShellLayout()
  const layoutRef = useRef(layout)

  // Cluster membership, recomputed only when the data changes, and the
  // reverse index (artist → member keys) the focus and the glows read.
  const clusters = useMemo(() => computeClusters(nodes, edges), [nodes, edges])
  const clusterMembers = useMemo(() => {
    const members = new Map<number, string[]>()
    for (const [id, artist] of clusters.clusterOf) {
      const list = members.get(artist) ?? []
      list.push(nodeKey(id))
      members.set(artist, list)
    }
    return members
  }, [clusters])
  const clustersRef = useRef(clusters)
  const clusterMembersRef = useRef(clusterMembers)
  const selectionFocusRef = useRef<Focus | null>(null)
  // Set by the renderer effect: re-evaluates which focus applies after the
  // selection changes from outside it.
  const applyFocusRef = useRef<() => void>(() => {})
  // Artist id → its cluster's glow colour, filled in as covers are sampled.
  const glowColorsRef = useRef(new Map<number, string>())

  // Shared by the imperative handle and a click on the map — both mean "go
  // look at this", and must land in the same place at the same zoom.
  const flyTo = useCallback((nodeId: number) => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    const key = nodeKey(nodeId)
    if (!graph || !renderer || !graph.hasNode(key)) return

    const attrs = graph.getNodeAttributes(key)
    const bbox = renderer.getCustomBBox() ?? renderer.getBBox()
    const { x, y } = createNormalizationFunction(bbox)({ x: attrs.x as number, y: attrs.y as number })

    const focus = focusFor(nodeId, graph, clustersRef.current.clusterOf, clusterMembersRef.current)
    const ratio = ratioToFit(renderer, graph, focus.keys, layoutRef.current)
    const landing = flyLandingPoint(renderer, layoutRef.current)

    // Distance in on-screen pixels, so a fly means the same at every zoom.
    const currentViewport = renderer.graphToViewport({ x: attrs.x as number, y: attrs.y as number })
    const distancePx = Math.hypot(currentViewport.x - landing.x, currentViewport.y - landing.y)
    const duration = osPrefersReducedMotion() || reducedMotionForcedRef.current ? 0 : flyToDurationForDistance(distancePx)

    // The camera centres whatever it points at, and the node isn't going to
    // the centre. Ask sigma which framed point would sit at the landing spot
    // with the camera centred on the node, then reflect the camera through
    // the node by that much.
    const camera = renderer.getCamera()
    const atLanding = renderer.viewportToFramedGraph(landing, { cameraState: { x, y, ratio, angle: camera.angle } })
    void camera.animate({ x: 2 * x - atLanding.x, y: 2 * y - atLanding.y, ratio }, { duration })
  }, [])

  useImperativeHandle(ref, () => ({ flyToNode: flyTo }), [flyTo])

  // Held in refs so effects below don't list them as dependencies — a parent
  // re-render must never tear down the renderer or reset the camera.
  const onSelectNodeRef = useRef(onSelectNode)
  const onStatsRef = useRef(onStats)
  const flyToRef = useRef(flyTo)
  const selectedNodeIdRef = useRef(selectedNodeId)
  const dimOnHoverEnabledRef = useRef(dimOnHoverEnabled)
  const reducedMotionForcedRef = useRef(reducedMotionForced)

  // Read every frame by the reducers and the label drawer. Refs, not state:
  // a slider drag fires continuously, and none of these may re-run the
  // renderer lifecycle effect.
  const liveRef = useRef({
    showArtists,
    showReleases,
    showTracks,
    showArtistLabels,
    colourEdgesByType,
    nodeSizeMultipliers,
    edgeThicknessMultiplier,
    edgeColorOverrides,
  })
  useEffect(() => {
    liveRef.current = {
      showArtists,
      showReleases,
      showTracks,
      showArtistLabels,
      colourEdgesByType,
      nodeSizeMultipliers,
      edgeThicknessMultiplier,
      edgeColorOverrides,
    }
    rendererRef.current?.refresh()
  }, [showArtists, showReleases, showTracks, showArtistLabels, colourEdgesByType, nodeSizeMultipliers, edgeThicknessMultiplier, edgeColorOverrides])

  // #136: theme changes are rare, so the palette is resolved once per change
  // rather than read from the DOM per node per frame.
  const themeColorsRef = useRef(resolveThemeColors())
  useEffect(() => {
    themeColorsRef.current = resolveThemeColors()
    const graph = graphRef.current
    // Base fills are baked into the graph at sync time; repaint them.
    graph?.forEachNode((key, attrs) => {
      graph.setNodeAttribute(key, 'color', themeColorsRef.current.node[attrs.nodeType as string] ?? themeColorsRef.current.node.label)
    })
    rendererRef.current?.refresh()
  }, [theme])

  // Opening or closing a panel changes where labels flip and where the next
  // fly lands; repaint so the right-edge label rule follows at once.
  useEffect(() => {
    layoutRef.current = layout
    rendererRef.current?.refresh()
  }, [layout])

  const nodesLockedRef = useRef(nodesLocked)
  useEffect(() => {
    nodesLockedRef.current = nodesLocked
    simulationRef.current?.setLocked(nodesLocked)
  }, [nodesLocked])

  useEffect(() => {
    simulationRef.current?.setParams({
      centerStrength: forceCenterStrength,
      repelStrength: forceRepelStrength,
      linkStrength: forceLinkStrength,
      linkDistance,
    })
  }, [forceCenterStrength, forceRepelStrength, forceLinkStrength, linkDistance])

  // The node the hover plate names — set only once the dwell has been held,
  // so the plate and the focus arrive as one response.
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null)

  // The renderer, as state, so the overlays re-subscribe once one exists.
  const [activeRenderer, setActiveRenderer] = useState<Sigma | null>(null)

  // #127/H9: set only on the simulation's own settle (see graphOutOfView).
  const [mapOutOfView, setMapOutOfView] = useState(false)
  const cancelSettleFitAnimRef = useRef<(() => void) | null>(null)

  // #127/H9: shared by the settle-time refit, the toolbar's fit button and
  // the out-of-view notice's "re-center".
  const reframeToRobustBBox = useCallback(() => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    if (!graph || !renderer) return
    const bbox = robustBBox(graph)
    if (!bbox) return
    const target = insetForShell(renderer, bbox, layoutRef.current)
    const from = renderer.getCustomBBox() ?? renderer.getBBox()
    cancelSettleFitAnimRef.current?.()
    cancelSettleFitAnimRef.current = animateBBox(
      renderer,
      from,
      target,
      SETTLE_REFIT_DURATION_MS,
      osPrefersReducedMotion() || reducedMotionForcedRef.current,
    )
    setMapOutOfView(false)
  }, [])

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

  // A selection focuses its cluster. Recomputed when the selection or the
  // clusters change, then handed to the renderer effect's focus logic.
  useEffect(() => {
    clustersRef.current = clusters
    clusterMembersRef.current = clusterMembers
    selectionFocusRef.current =
      selectedNodeId != null ? focusFor(selectedNodeId, graphRef.current, clusters.clusterOf, clusterMembers) : null
    applyFocusRef.current()
  }, [selectedNodeId, clusters, clusterMembers])

  // Renderer lifecycle — created once per mount, NOT on every data refresh
  // or settings change.
  useEffect(() => {
    if (!containerRef.current) return

    // multi: true — two nodes can hold more than one edge between them (a
    // produced_by and an engineered_by credit to the same person, say).
    const graph = new Graph({ multi: true })
    graphRef.current = graph

    const renderer = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      renderEdgeLabels: false,
      defaultEdgeType: 'line',
      defaultNodeType: 'circle',
      // Only the labels the node reducer forces are drawn: artists, credits,
      // and a focused cluster's records. Sigma's own pick (the biggest dots
      // that fit a density grid) would label arbitrary tracks.
      labelRenderedSizeThreshold: 1e9,
      // Edges are sub-pixel hairlines on purpose; sigma's default floor
      // would draw every one at 1.7px.
      minEdgeThickness: 0.1,
      // Focused nodes draw above the rest (the reducer's zIndex).
      zIndex: true,
      // Kept as a no-op on purpose: without an override sigma draws its own
      // black-on-white label box for hovered and dragged nodes.
      defaultDrawNodeHover: () => {},
    })
    rendererRef.current = renderer
    setActiveRenderer(renderer)

    // Focus state, read by the label pass and the reducers below; see the
    // focus comment further down for what each one means.
    let hoverFocus: Focus | null = null
    let hoverActive = false
    let currentFocus: Focus | null = null
    let focusProgress = 0
    let dwellTimeout: ReturnType<typeof setTimeout> | null = null
    let cancelFocusAnim: (() => void) | null = null

    /* Labels, drawn on sigma's label canvas. Rubik with a 4px round-join
     * halo in the canvas colour, so a label reads over edges and glows.
     * Artists 13/500 ink, offset right of the dot — or left, if the right
     * would run under the right-hand panel. Records 11/400 ink-2, credits
     * 11/400 ink-3. Out-of-focus labels at 45%.
     *
     * A real library is denser than any mock: featured artists cluster
     * around the people they featured with, and every one of them is an
     * artist node. So labels are placed greedily once per frame — focused
     * first, then artists before credits before records, bigger dots first
     * — and a label that would overlap one already placed is skipped. The
     * map stays legible at every zoom, and zooming in reveals the rest. */
    const LABEL_STYLE: Record<LabelKind, { size: number; weight: number; rank: number }> = {
      artist: { size: 13, weight: 500, rank: 0 },
      credit: { size: 11, weight: 400, rank: 1 },
      release: { size: 11, weight: 400, rank: 2 },
    }
    const LABEL_PAD = 3
    const widthCache = new Map<string, number>()
    const measure = (context: CanvasRenderingContext2D, kind: LabelKind, label: string) => {
      const cacheKey = `${kind}\u0000${label}`
      let width = widthCache.get(cacheKey)
      if (width == null) {
        const style = LABEL_STYLE[kind]
        context.font = `${style.weight} ${style.size}px 'Rubik Variable', Rubik, system-ui, sans-serif`
        width = context.measureText(label).width
        widthCache.set(cacheKey, width)
      }
      return width
    }
    const labelBox = (context: CanvasRenderingContext2D, kind: LabelKind, label: string, x: number, y: number, size: number) => {
      const style = LABEL_STYLE[kind]
      const width = measure(context, kind, label)
      const gap = size + 6
      let left = x + gap
      if (kind === 'artist') {
        const limit = renderer.getDimensions().width - layoutRef.current.rightOccupancy - 16
        if (left + width > limit) left = x - gap - width
      }
      return { left, baseline: y + style.size * 0.36, top: y - style.size * 0.6, width, height: style.size * 1.2 }
    }

    // Recomputed on the first label of each frame, dropped after the frame.
    let placedLabels: Set<string> | null = null
    renderer.on('afterRender', () => {
      placedLabels = null
    })
    const placeLabels = (context: CanvasRenderingContext2D): Set<string> => {
      const { width, height } = renderer.getDimensions()
      const candidates: { key: string; kind: LabelKind; label: string; x: number; y: number; size: number; focused: boolean }[] = []
      graph.forEachNode((key) => {
        const display = renderer.getNodeDisplayData(key) as (ReturnType<typeof renderer.getNodeDisplayData> & { labelKind?: LabelKind }) | undefined
        if (!display || display.hidden || !display.labelKind || !display.label) return
        const { x, y } = renderer.framedGraphToViewport(display)
        if (x < -200 || x > width + 200 || y < -20 || y > height + 20) return
        candidates.push({ key, kind: display.labelKind, label: display.label, x, y, size: renderer.scaleSize(display.size), focused: display.zIndex > 0 && currentFocus != null && focusProgress > 0 })
      })
      candidates.sort((a, b) => Number(b.focused) - Number(a.focused) || LABEL_STYLE[a.kind].rank - LABEL_STYLE[b.kind].rank || b.size - a.size)
      const placed = new Set<string>()
      const boxes: { left: number; top: number; right: number; bottom: number }[] = []
      for (const c of candidates) {
        const box = labelBox(context, c.kind, c.label, c.x, c.y, c.size)
        const rect = { left: box.left - LABEL_PAD, top: box.top - LABEL_PAD, right: box.left + box.width + LABEL_PAD, bottom: box.top + box.height + LABEL_PAD }
        if (boxes.some((o) => rect.left < o.right && rect.right > o.left && rect.top < o.bottom && rect.bottom > o.top)) continue
        boxes.push(rect)
        placed.add(c.key)
      }
      return placed
    }

    const drawLabel: NodeLabelDrawingFunction = (context, data) => {
      const kind = (data as unknown as { labelKind?: LabelKind }).labelKind
      if (!kind || !data.label) return
      placedLabels ??= placeLabels(context)
      if (!placedLabels.has(data.key)) return
      const colors = themeColorsRef.current
      const style = LABEL_STYLE[kind]
      const box = labelBox(context, kind, data.label, data.x, data.y, data.size)
      context.font = `${style.weight} ${style.size}px 'Rubik Variable', Rubik, system-ui, sans-serif`
      context.globalAlpha = (data as unknown as { labelAlpha?: number }).labelAlpha ?? 1
      context.lineJoin = 'round'
      context.lineWidth = 4
      context.strokeStyle = colors.halo
      context.strokeText(data.label, box.left, box.baseline)
      context.fillStyle = kind === 'artist' ? colors.ink : kind === 'release' ? colors.ink2 : colors.ink3
      context.fillText(data.label, box.left, box.baseline)
      context.globalAlpha = 1
    }
    renderer.setSetting('defaultDrawNodeLabel', drawLabel)

    // Obsidian-style live physics (the 2026-08-29 map rework). The tick
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
    //
    // #56: this used to call setCustomBBox directly, snapping straight from
    // the seed-spread framing to the settled one in a single frame — since
    // every node's screen position is renormalized against the bbox, not
    // just the camera, that snap read as the whole graph jittering rather
    // than as a deliberate camera move. animateBBox eases the same
    // renormalization across SETTLE_REFIT_DURATION_MS instead, so the end
    // framing is identical but arrives as one smooth reframe.
    let hasFitAfterSettle = false
    // True only for the one 'end' tick on which the line above just flipped
    // — read and cleared by end.outOfViewCheck immediately below, so that
    // listener doesn't grade this same settle against the stale
    // pre-reframe customBBox reframeToRobustBBox hasn't animated to yet.
    let justRanInitialFit = false
    sim.simulation.on('end.initialFit', () => {
      if (hasFitAfterSettle || graph.order === 0) return
      hasFitAfterSettle = true
      justRanInitialFit = true
      reframeToRobustBBox()
    })

    // #127/H9: "the map spread out of view" (see graphOutOfView's own
    // comment above for why this only ever runs here, on settle, and never
    // on a tick or a pan). Every settle after the first real one — a drag,
    // a force-slider change, a resync — is a candidate; the first is
    // skipped because end.initialFit (registered, and so run, just above)
    // already has its own answer for it.
    sim.simulation.on('end.outOfViewCheck', () => {
      if (justRanInitialFit) {
        justRanInitialFit = false
        return
      }
      if (!hasFitAfterSettle || graph.order === 0) return
      setMapOutOfView(graphOutOfView(renderer, graph))
    })

    /* Focus. A selection focuses its cluster; with nothing selected, a
     * hover held past the dwell (with the hover-dim setting on) focuses the
     * hovered node's neighbourhood. Whatever is focused
     * stays as it is; everything else recedes — nodes to 30%, labels to
     * 45%, edges to 60% of their usual faintness, other clusters' glows to
     * 35% — while the focused cluster's edges take their type colours.
     *
     * focusProgress crossfades that in and out over DIM_CROSSFADE_MS (MO-6)
     * rather than cutting, and only rises after HOVER_DWELL_MS of a held
     * hover, so sweeping the pointer across a dense cluster doesn't strobe
     * the map. currentFocus is kept through a fade-out so the reducers
     * still know what is fading. */

    const setFocusTarget = (target: number) => {
      cancelFocusAnim?.()
      cancelFocusAnim = animateScalar(
        focusProgress,
        target,
        DIM_CROSSFADE_MS,
        (v) => {
          focusProgress = v
          renderer.refresh()
        },
        osPrefersReducedMotion() || reducedMotionForcedRef.current,
        () => {
          if (target === 0) currentFocus = null
        },
      )
    }

    const applyFocus = () => {
      // A selection wins: it was a click, a hover is a passing glance — and
      // the pointer is still resting on the node the moment after it's
      // clicked, so a hover that won would undo the selection's focus.
      const next = selectionFocusRef.current ?? (hoverActive ? hoverFocus : null)
      if (next) {
        currentFocus = next
        if (focusProgress < 1) setFocusTarget(1)
        else renderer.refresh()
      } else if (currentFocus) {
        setFocusTarget(0)
      }
    }
    applyFocusRef.current = applyFocus

    const typeHidden = (type: string | undefined) => {
      const live = liveRef.current
      return (type === 'artist' && !live.showArtists) || (type === 'release' && !live.showReleases) || (type === 'recording' && !live.showTracks)
    }

    renderer.setSetting('nodeReducer', (node, data) => {
      const live = liveRef.current
      const type = data.nodeType as string
      if (typeHidden(type)) return { ...data, hidden: true }

      const size = (data.size as number) * (live.nodeSizeMultipliers[type] ?? 1)
      const focused = currentFocus == null || focusProgress <= 0 || currentFocus.keys.has(node)
      const t = focused ? 0 : focusProgress
      const colors = themeColorsRef.current
      const color = t > 0 ? mixToward(data.color as string, colors.canvas, (1 - UNFOCUSED_NODE_ALPHA) * t) : (data.color as string)

      // The selected node is named by its card, so it gets no label of its own.
      const selectedId = selectedNodeIdRef.current
      let labelKind: LabelKind | null = null
      if (selectedId == null || node !== nodeKey(selectedId)) {
        if (type === 'artist') labelKind = live.showArtistLabels ? 'artist' : null
        else if (type === 'credit') labelKind = 'credit'
        else if (type === 'release' && currentFocus != null && focusProgress > 0 && currentFocus.keys.has(node)) labelKind = 'release'
      }

      return {
        ...data,
        size,
        color,
        label: labelKind ? (data.label as string) : null,
        forceLabel: labelKind != null,
        labelKind,
        labelAlpha: 1 - (1 - UNFOCUSED_LABEL_ALPHA) * t,
        zIndex: focused ? 1 : 0,
      }
    })

    renderer.setSetting('edgeReducer', (edge, data) => {
      const live = liveRef.current
      const [source, target] = graph.extremities(edge)
      if (typeHidden(graph.getNodeAttribute(source, 'nodeType') as string) || typeHidden(graph.getNodeAttribute(target, 'nodeType') as string)) {
        return { ...data, hidden: true }
      }
      // Sigma scales edge width with zoom; dividing that back out keeps
      // every edge the same hairline on screen at any zoom.
      const scale = live.edgeThicknessMultiplier * Math.sqrt(renderer.getCamera().ratio)
      const relType = data.relType as string
      const colors = themeColorsRef.current
      const focusing = currentFocus != null && focusProgress > 0

      if (focusing && (currentFocus!.keys.has(source) || currentFocus!.keys.has(target))) {
        const hue = edgeHue(relType, live.edgeColorOverrides, colors)
        return { ...data, size: EDGE_FOCUSED_PX * scale, color: withAlphaFactor(hue, 1, FOCUSED_EDGE_ALPHA * focusProgress) }
      }
      const base = live.colourEdgesByType ? withAlphaFactor(edgeHue(relType, live.edgeColorOverrides, colors), 1, TYPED_EDGE_ALPHA) : colors.edge
      const color = focusing ? withAlphaFactor(base, 1 - (1 - UNFOCUSED_EDGE_ALPHA) * focusProgress) : base
      return { ...data, size: EDGE_PX * scale, color }
    })

    /* Cluster glows: a radial gradient of each artist's cover colour,
     * painted on a 2D canvas slipped in under sigma's edge layer. The radius
     * follows the v2 rule — min(w, h) × (0.08 + size × 0.012), growing
     * gently with zoom like the dots — but never much wider than the cluster
     * it sits behind, so a library of two hundred artists doesn't melt into
     * one wash. */
    const glowCanvas = renderer.createCanvas('glows', { beforeLayer: 'edges' })
    glowCanvas.style.position = 'absolute'
    glowCanvas.style.inset = '0'
    glowCanvas.style.pointerEvents = 'none'
    const glowContext = glowCanvas.getContext('2d')
    const drawGlows = () => {
      if (!glowContext) return
      const { width, height } = renderer.getDimensions()
      const dpr = window.devicePixelRatio || 1
      const pixelWidth = Math.round(width * dpr)
      const pixelHeight = Math.round(height * dpr)
      if (glowCanvas.width !== pixelWidth || glowCanvas.height !== pixelHeight) {
        glowCanvas.width = pixelWidth
        glowCanvas.height = pixelHeight
        glowCanvas.style.width = `${width}px`
        glowCanvas.style.height = `${height}px`
      }
      glowContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      glowContext.clearRect(0, 0, width, height)

      const colors = themeColorsRef.current
      const zoom = Math.sqrt(renderer.getCamera().ratio)
      const focusCluster = currentFocus != null && focusProgress > 0 ? currentFocus.cluster : null
      const shortSide = Math.min(width, height)
      for (const [artistId, hex] of glowColorsRef.current) {
        const key = nodeKey(artistId)
        const display = renderer.getNodeDisplayData(key)
        if (!display) continue
        const centre = renderer.framedGraphToViewport(display)
        let extent = 0
        for (const member of clusterMembersRef.current.get(artistId) ?? []) {
          const memberDisplay = renderer.getNodeDisplayData(member)
          if (!memberDisplay) continue
          const p = renderer.framedGraphToViewport(memberDisplay)
          extent = Math.max(extent, Math.hypot(p.x - centre.x, p.y - centre.y))
        }
        const size = graph.getNodeAttribute(key, 'size') as number
        const specRadius = (shortSide * (0.08 + size * 0.012)) / zoom
        const radius = Math.max(24, Math.min(specRadius, extent * 1.6 + 30))
        if (centre.x + radius < 0 || centre.x - radius > width || centre.y + radius < 0 || centre.y - radius > height) continue
        const dimmed = focusCluster != null && focusCluster !== artistId
        const alpha = colors.glowAlpha * (dimmed ? 1 - (1 - UNFOCUSED_GLOW_ALPHA) * focusProgress : 1)
        const gradient = glowContext.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius)
        gradient.addColorStop(0, withAlphaFactor(hex, 1, alpha))
        gradient.addColorStop(1, withAlphaFactor(hex, 1, 0))
        glowContext.fillStyle = gradient
        glowContext.beginPath()
        glowContext.arc(centre.x, centre.y, radius, 0, Math.PI * 2)
        glowContext.fill()
      }
    }
    renderer.on('afterRender', drawGlows)

    renderer.on('enterNode', ({ node }) => {
      if (dwellTimeout != null) clearTimeout(dwellTimeout)
      const keys = new Set(graph.neighbors(node))
      keys.add(node)
      hoverFocus = { keys, cluster: null }
      dwellTimeout = setTimeout(() => {
        dwellTimeout = null
        // The setting gates only the focus; the plate still names the node,
        // since that's wayfinding rather than the stronger "recede
        // everything else".
        if (dimOnHoverEnabledRef.current) {
          hoverActive = true
          applyFocus()
        }
        setHoveredNodeId(Number(node))
      }, HOVER_DWELL_MS)
    })
    renderer.on('leaveNode', () => {
      setHoveredNodeId(null)
      if (dwellTimeout != null) {
        // The dwell never engaged, so nothing was focused: nothing to undo.
        // This is what stops a sweep across a cluster from strobing it.
        clearTimeout(dwellTimeout)
        dwellTimeout = null
        return
      }
      if (hoverActive) {
        hoverActive = false
        applyFocus()
      }
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
      cancelFocusAnim?.()
      cancelSettleFitAnimRef.current?.()
      applyFocusRef.current = () => {}
      sim.simulation.stop()
      simulationRef.current = null
      renderer.kill()
      rendererRef.current = null
      graphRef.current = null
      setActiveRenderer(null)
    }
    // Deliberately [] — runs once per mount. Everything live is read
    // through refs; force params and lock have their own sync effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Data sync — updates the existing graph in place whenever fetched data
  // changes, without touching the renderer (which would reset the camera).
  useEffect(() => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    if (!graph || !renderer || loading) return

    const hadNoNodes = graph.order === 0
    const sizeOf = (node: GraphNode) => {
      switch (node.type) {
        case 'artist':
          return artistSize(clusters.releasesOf.get(node.id)?.length ?? 0)
        case 'release':
          return RELEASE_SIZE
        case 'recording':
          return RECORDING_SIZE
        case 'credit':
          return CREDIT_SIZE
        default:
          return OTHER_SIZE
      }
    }
    syncGraph(graph, nodes, edges, showCreditNodes, sizeOf, themeColorsRef.current)
    onStatsRef.current?.({ nodes: graph.order, edges: graph.size })

    // The same post-sync graph feeds the live simulation. Existing nodes
    // keep their live position; only a new node or a changed radius reheats.
    const simNodes: SimNodeInput[] = []
    graph.forEachNode((key, attrs) => {
      simNodes.push({ key, x: attrs.x as number, y: attrs.y as number, radius: (attrs.size as number) + COLLIDE_PADDING })
    })
    const simLinks: { source: string; target: string }[] = []
    graph.forEachEdge((_edgeKey, _attrs, source, target) => simLinks.push({ source, target }))
    simulationRef.current?.sync(simNodes, simLinks)

    // Fit the camera only on this renderer's first population — a
    // background refresh must never move the view out from under the user.
    if (hadNoNodes) {
      const bbox = robustBBox(graph)
      if (bbox) renderer.setCustomBBox(insetForShell(renderer, bbox, layoutRef.current))
    }
  }, [nodes, edges, loading, showCreditNodes, clusters])

  // Each artist's glow colour: the average of its records' cover colours
  // (eight at most — enough to find the mean), or its own photo's for an
  // artist with no records on the map. Sampled a few artists at a time and
  // cached across refetches; the map repaints in batches as they land.
  useEffect(() => {
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer != null) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        rendererRef.current?.refresh()
      }, 200)
    }
    const queue = nodes.filter((n) => n.type === 'artist' && !glowColorsRef.current.has(n.id))
    const work = async () => {
      while (!cancelled && queue.length > 0) {
        const artist = queue.shift()!
        const hashes = [
          ...new Set(
            (clusters.releasesOf.get(artist.id) ?? []).map((id) => byId.get(id)?.cover_hash).filter((h): h is string => h != null),
          ),
        ].slice(0, 8)
        if (hashes.length === 0 && artist.cover_hash) hashes.push(artist.cover_hash)
        if (hashes.length === 0) continue
        const sampled = await Promise.all(hashes.map((hash) => sampleCoverColor(hashCoverUrl(hash))))
        const mean = averageColors(sampled.filter((c): c is string => c != null))
        if (mean && !cancelled) {
          glowColorsRef.current.set(artist.id, mean)
          scheduleRefresh()
        }
      }
    }
    for (let i = 0; i < 4; i++) void work()
    return () => {
      cancelled = true
      if (refreshTimer != null) clearTimeout(refreshTimer)
    }
  }, [nodes, clusters, byId])

  const selectedNode = selectedNodeId != null ? byId.get(selectedNodeId) : undefined
  // A node showing its card doesn't also get a plate: the card says more.
  const hoveredNode = hoveredNodeId != null && hoveredNodeId !== selectedNodeId ? byId.get(hoveredNodeId) : undefined
  // Issue #85: whatever is playing, wherever it is — independent of both.
  const playingNodeId = playback.status.currentRecordingNodeId
  const playingNode = playingNodeId != null ? byId.get(playingNodeId) : undefined

  const counts = useMemo(() => {
    const byType = { artist: 0, release: 0, recording: 0, credit: 0 }
    for (const node of nodes) if (node.type in byType) byType[node.type as keyof typeof byType]++
    return byType
  }, [nodes])

  const reduced = () => osPrefersReducedMotion() || reducedMotionForcedRef.current
  const zoomBy = (direction: 'in' | 'out') => {
    const camera = rendererRef.current?.getCamera()
    if (!camera) return
    const duration = reduced() ? 0 : 180
    if (direction === 'in') void camera.animatedZoom({ duration })
    else void camera.animatedUnzoom({ duration })
  }
  const fitMap = () => {
    const camera = rendererRef.current?.getCamera()
    if (!camera) return
    reframeToRobustBBox()
    void camera.animatedReset({ duration: reduced() ? 0 : SETTLE_REFIT_DURATION_MS })
  }

  // Ordered error > empty: a failed scan is the more actionable thing to
  // say, and a scan that came back empty is the fallback.
  const showEmptyState = !loading && nodes.length === 0

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Above the map's own notices and chrome (z-10): a selection's card
       * must never sit under the first-scan card. */}
      <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
        {/* #23: the shift-drag marquee, sized by direct style writes. */}
        <div
          ref={marqueeRef}
          className="absolute top-0 left-0 rounded-[4px] border border-[var(--color-line-strong)] bg-[var(--color-wash)]"
          style={{ visibility: 'hidden' }}
        />
        {/* The one sign a group is multiselected: a surface around it. */}
        <div
          ref={multiSelectOutlineRef}
          className="absolute top-0 left-0 rounded-[12px] border border-[var(--color-line-strong)]"
          style={{ visibility: 'hidden' }}
        />
        {playingNode && <NodePlayingHalo key={playingNode.id} renderer={activeRenderer} nodeKey={nodeKey(playingNode.id)} />}
        {selectedNode && <SelectionRing key={selectedNode.id} renderer={activeRenderer} nodeKey={nodeKey(selectedNode.id)} />}
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
              node={selectedNode}
              nodeKey={nodeKey(selectedNode.id)}
              layout={layout}
              onOpenDetails={onOpenDetails}
              playback={playback}
            />
          </div>
        )}
      </div>

      {!showEmptyState && <MapLegend counts={counts} showProducers={showCreditNodes} />}
      {!showEmptyState && <MapToolbar onZoomIn={() => zoomBy('in')} onZoomOut={() => zoomBy('out')} onFit={fitMap} options={mapOptions} />}

      {scanStatus.error && showEmptyState ? (
        <MapNotice title="The scan stopped" body={scanStatus.error} actions={[{ label: 'Try again', onClick: scanStatus.retry, primary: true }]} />
      ) : showEmptyState ? (
        <MapNotice title={scanStatus.scanning ? 'Reading your library' : 'Nothing on the map yet'} body={
          scanStatus.scanning ? 'Nodes appear here as tracks are matched.' : 'Add a music folder in Settings and Legato draws the map from it.'
        } />
      ) : mapOutOfView ? (
        <MapNotice
          title="The map spread out of view"
          body="The layout pushed everything past the edge of the window."
          actions={[
            { label: 'Re-center', onClick: reframeToRobustBBox, primary: true },
            {
              label: 'Restore defaults',
              onClick: () => {
                onRestoreDefaults?.()
                // Optimistic: restoring balanced forces reliably pulls the
                // map back as it resettles, and the settle check puts this
                // notice back if that's ever wrong.
                setMapOutOfView(false)
              },
            },
          ]}
        />
      ) : null}
    </div>
  )
})
