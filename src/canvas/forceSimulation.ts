import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

/* Obsidian-style live physics for the combined graph (2026-08-29 — see
 * Legato.md). A plain module rather than a React hook: its lifetime has to
 * exactly match the Sigma renderer/graphology Graph instance Canvas.tsx
 * already owns for the lifetime of one mount, not a hook's own render
 * cycle, so it's created and torn down inside that same effect.
 *
 * Node identity is stable across resyncs — d3-force mutates each node
 * object in place every tick (x, y, vx, vy, and fx/fy while pinned), so an
 * existing node has to keep the same object across a sync() call or its
 * velocity and pin state would reset on every data refresh. */

export type SimNode = SimulationNodeDatum & { id: string; radius: number }
type SimLink = SimulationLinkDatum<SimNode>

export type ForceParams = {
  centerStrength: number
  repelStrength: number
  linkStrength: number
  linkDistance: number
}

/* Graph-space breathing room beyond a node's own rendered radius — nodes
 * settle just short of touching rather than edge-to-edge, which reads as
 * "spaced apart" rather than "packed". Sigma's `size` and `x`/`y` share one
 * graph-space unit convention (both scale together under the camera), so a
 * collision radius taken straight from a node's rendered size guarantees
 * non-overlap at any zoom level with no separate unit conversion to keep
 * in sync — see Canvas.tsx's syncSimulation for where `radius` comes from. */
const COLLISION_PADDING = 2

/* A one-shot kick, not a held target — d3-force's own alphaDecay cools it
 * back to rest on its own over the next couple of seconds. alphaTarget is
 * reserved for drag (Canvas.tsx holds it elevated for the drag's duration),
 * so a slider change or a data refresh use this instead: nudge, then let
 * physics settle. */
const REHEAT_ALPHA = 0.4

export type SimNodeInput = {
  key: string
  x: number
  y: number
  radius: number
  /** Set for a node with a persisted user_x/user_y — pinned from the
   * moment it enters the simulation, and never cleared by a resync (only
   * Canvas.tsx's own drag handling ever changes a node's fx/fy after that,
   * by design — dragging pins permanently, "the user layer always wins"). */
  fx: number | null
  fy: number | null
}

export type ForceSimulationHandle = {
  simulation: Simulation<SimNode, SimLink>
  /** Live node objects, keyed the same as the graphology graph — read this
   * to find the object a drag needs to set fx/fy on directly. */
  nodesByKey: Map<string, SimNode>
  /** Reconciles the simulation's node/link arrays to match the graph's
   * current data (mirrors syncGraph's own add/update/remove diff).
   * Existing nodes keep their live x/y/vx/vy/fx/fy; only `radius` updates
   * in place (a nodes>images toggle changing a node's rendered size).
   * Reheats with a fresh kick when the node/link set actually changed or
   * any radius did — a plain settings refresh that changes neither is a
   * no-op here. */
  sync(nodes: SimNodeInput[], links: { source: string; target: string }[]): void
  /** Applies new force-strength/distance settings and gives the simulation
   * a fresh kick so the change is visible immediately — a slider with no
   * visible effect until you separately nudge a node would read as broken. */
  setParams(params: ForceParams): void
  /** Music Map settings "nodes > lock" — freezes the simulation (nothing
   * drifts on its own) without discarding it; sync/setParams still update
   * state underneath so a change made while locked takes visible effect
   * the moment it's unlocked, rather than being silently dropped. Dragging
   * a node while locked is still Canvas.tsx's job — it sets that one
   * node's fx/fy and graph x/y directly, bypassing the stopped simulation
   * entirely. */
  setLocked(locked: boolean): void
}

export function createForceSimulation(onTick: () => void): ForceSimulationHandle {
  const nodesByKey = new Map<string, SimNode>()
  let locked = false
  // The gravity well's target — set once, to the seed layout's own centroid,
  // the first time real nodes arrive (see sync() below). NOT the literal
  // origin: server/src/layout/cluster.ts's seed coordinates are absolute
  // (a decade like 1990 becomes x≈79600 — DECADE_SPACING scaled off the
  // actual year, never intended to sit near (0,0)), so a hardcoded 0 target
  // pulled every node ~79,000 units on the very first tick — a huge
  // one-shot velocity spike that collapsed the whole graph into a
  // degenerate line before repulsion ever got a chance to act. Centering
  // gravity on the data's own centroid instead means the "pull toward the
  // middle" force is relative to the graph, exactly what it's supposed to
  // be, regardless of whatever absolute coordinate scale seeded it.
  let gravityCentered = false
  // Whether the simulation has ever reached its own natural rest (alpha
  // decayed below alphaMin) at least once. Locked never means "skip physics
  // outright" — a node's server seed position (cluster.ts, tuned for the
  // small pre-physics dot markers) overlaps everywhere at today's full art
  // size, and if `nodePositionsLocked` happens to already be true from a
  // previous session (a persisted setting) the very first time this graph
  // ever loads, freezing physics before it has settled even once would
  // leave that raw, heavily-overlapping seed frozen forever. See setLocked
  // and reheat below.
  let hasEverSettled = false

  const centerX = forceX<SimNode>(0)
  const centerY = forceY<SimNode>(0)
  const repel = forceManyBody<SimNode>()
  const link = forceLink<SimNode, SimLink>([]).id((d) => d.id)
  // iterations(1) (d3-force's default) only partially resolves overlap per
  // tick on a graph this dense — real library scale (381 nodes, one
  // artist's whole discography often seeded within MIN_NODE_DISTANCE of
  // each other by cluster.ts) visibly stayed overlapped well past settling
  // with it. 6 costs little at this node count and actually delivers
  // requirement #1 ("nothing overlaps").
  const collide = forceCollide<SimNode>((d) => d.radius + COLLISION_PADDING).iterations(6)

  const simulation = forceSimulation<SimNode>([])
    .force('center-x', centerX)
    .force('center-y', centerY)
    .force('repel', repel)
    .force('link', link)
    .force('collide', collide)
    .on('tick', onTick)
    // d3-force's own default alphaDecay reaches alphaMin in ~300 ticks
    // (~5s) — not long enough to fully untangle a real library's worth of
    // initially near-coincident same-artist nodes. Twice that gives
    // collide's iterations enough time to actually finish the job rather
    // than freezing mid-resolution once alpha crosses the threshold.
    .alphaDecay(1 - Math.pow(0.001, 1 / 600))

  simulation.on('end.trackSettled', () => {
    hasEverSettled = true
  })

  function reheat(): void {
    simulation.alpha(REHEAT_ALPHA)
    // Runs even while locked until the very first settle — see
    // hasEverSettled above.
    if (!locked || !hasEverSettled) simulation.restart()
  }

  function sync(wanted: SimNodeInput[], links: { source: string; target: string }[]): void {
    if (!gravityCentered && wanted.length > 0) {
      gravityCentered = true
      let sumX = 0
      let sumY = 0
      for (const n of wanted) {
        sumX += n.x
        sumY += n.y
      }
      centerX.x(sumX / wanted.length)
      centerY.y(sumY / wanted.length)
    }

    const wantedKeys = new Set(wanted.map((n) => n.key))
    let changed = wantedKeys.size !== nodesByKey.size

    for (const key of [...nodesByKey.keys()]) {
      if (!wantedKeys.has(key)) {
        nodesByKey.delete(key)
        changed = true
      }
    }

    for (const n of wanted) {
      const existing = nodesByKey.get(n.key)
      if (existing) {
        if (existing.radius !== n.radius) changed = true
        existing.radius = n.radius
      } else {
        nodesByKey.set(n.key, {
          id: n.key,
          x: n.x,
          y: n.y,
          radius: n.radius,
          fx: n.fx ?? undefined,
          fy: n.fy ?? undefined,
        })
        changed = true
      }
    }

    const nodesArray = wanted.map((n) => nodesByKey.get(n.key)!)
    const linksArray: SimLink[] = links
      .filter((l) => nodesByKey.has(l.source) && nodesByKey.has(l.target))
      .map((l) => ({ source: l.source, target: l.target }))

    simulation.nodes(nodesArray)
    link.links(linksArray)
    if (changed) reheat()
  }

  function setParams(params: ForceParams): void {
    centerX.strength(params.centerStrength)
    centerY.strength(params.centerStrength)
    repel.strength(-params.repelStrength)
    link.distance(params.linkDistance).strength(params.linkStrength)
    reheat()
  }

  function setLocked(next: boolean): void {
    locked = next
    // Don't stop a simulation that has never settled even once — see
    // hasEverSettled above. It'll reach alphaMin and stop itself
    // naturally; this only ever short-circuits an *already-settled* graph
    // being frozen back in place.
    if (locked && hasEverSettled) simulation.stop()
    else if (!locked) simulation.restart()
  }

  return { simulation, nodesByKey, sync, setParams, setLocked }
}
