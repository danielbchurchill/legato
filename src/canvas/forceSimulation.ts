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

/* Obsidian-style live physics for the combined graph (the 2026-08-29 map
 * rework). A plain module rather than a React hook: its lifetime has to
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

/* #274: how far physics reaches around a change to a map that's already at
 * rest. Everything further away is held where it is until the change has
 * settled. Two hops from a new track reaches its record and artist and their
 * other tracks: the cluster it joined. A plain reheat isn't enough, because
 * collide's push doesn't scale with alpha the way the other forces do, so a
 * map at rest at alpha 0.001 isn't at rest at 0.4. A global kick rearranged
 * the whole map, however small the change. */
const LOCAL_SETTLE_HOPS = 2

export type SimNodeInput = {
  key: string
  x: number
  y: number
  radius: number
  /** x/y is where this node came to rest on an earlier visit, saved by the
   * server (#274), rather than a seed or a starting guess. Only read on a
   * node's first sync. */
  atRest?: boolean
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
   *
   * #274: a first sync where every node arrives at rest runs no physics at
   * all, so a saved layout comes back exactly as it was saved. Otherwise a
   * node added or resized, or one that lost a neighbour, needs settling:
   * on a map already at rest only its neighbourhood moves (see
   * LOCAL_SETTLE_HOPS), and mid-settle the whole map gets a fresh kick as
   * before. A plain settings refresh that changes nothing is a no-op. */
  sync(nodes: SimNodeInput[], links: { source: string; target: string }[]): void
  /** True when the first nodes to arrive came, in whole or in part, from a
   * saved layout. Canvas.tsx's settle-time camera fit has nothing to do for
   * such a map: it was framed as it arrived, and whatever settles after
   * that is a local change the camera shouldn't chase. */
  openedOnSavedLayout(): boolean
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
  // be, regardless of whatever absolute coordinate scale seeded it. A map
  // that opens at its saved resting spots (#274) gets the same target its
  // last session had, since a map at rest has its centroid on the well.
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
  let openedOnSavedLayout = false
  // Nodes pinned in place (fx/fy) while a local settle runs, released when
  // it ends — see LOCAL_SETTLE_HOPS. Empty whenever the whole map is free.
  const held = new Set<string>()
  // Who neighboured whom as of the last sync, so a removed node's former
  // neighbours can still be found once its links are gone.
  let adjacency = new Map<string, string[]>()

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
    releaseHolds()
  })

  function restartUnlessLocked(): void {
    // Runs even while locked until the very first settle — see
    // hasEverSettled above.
    if (!locked || !hasEverSettled) simulation.restart()
  }

  function reheat(): void {
    releaseHolds()
    simulation.alpha(REHEAT_ALPHA)
    restartUnlessLocked()
  }

  function releaseHolds(): void {
    for (const key of held) {
      const node = nodesByKey.get(key)
      if (node) {
        node.fx = null
        node.fy = null
      }
    }
    held.clear()
  }

  // A kick that only moves what's within LOCAL_SETTLE_HOPS of `around`. A
  // second change before the first has settled widens the free area rather
  // than starting over.
  function settleLocally(around: Set<string>): void {
    const free = withinHops(around, LOCAL_SETTLE_HOPS)
    if (held.size === 0) {
      for (const [key, node] of nodesByKey) {
        // A node with fx already set is mid-drag; the drag owns its pin.
        if (free.has(key) || node.fx != null) continue
        node.fx = node.x
        node.fy = node.y
        held.add(key)
      }
    } else {
      for (const key of free) {
        if (!held.delete(key)) continue
        const node = nodesByKey.get(key)!
        node.fx = null
        node.fy = null
      }
    }
    simulation.alpha(REHEAT_ALPHA)
    restartUnlessLocked()
  }

  function withinHops(start: Set<string>, hops: number): Set<string> {
    const reached = new Set(start)
    let frontier = [...start]
    for (let hop = 0; hop < hops; hop++) {
      const next: string[] = []
      for (const key of frontier) {
        for (const neighbour of adjacency.get(key) ?? []) {
          if (reached.has(neighbour)) continue
          reached.add(neighbour)
          next.push(neighbour)
        }
      }
      frontier = next
    }
    return reached
  }

  function sync(wanted: SimNodeInput[], links: { source: string; target: string }[]): void {
    const firstPopulation = nodesByKey.size === 0
    if (firstPopulation && wanted.some((n) => n.atRest)) openedOnSavedLayout = true
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

    // Every node whose surroundings this sync changes: added, resized, or
    // left without a neighbour it had.
    const unsettled = new Set<string>()
    const wantedKeys = new Set(wanted.map((n) => n.key))

    for (const key of [...nodesByKey.keys()]) {
      if (!wantedKeys.has(key)) {
        nodesByKey.delete(key)
        held.delete(key)
        for (const neighbour of adjacency.get(key) ?? []) {
          if (wantedKeys.has(neighbour)) unsettled.add(neighbour)
        }
      }
    }

    for (const n of wanted) {
      const existing = nodesByKey.get(n.key)
      if (existing) {
        if (existing.radius !== n.radius) unsettled.add(n.key)
        existing.radius = n.radius
      } else {
        // fx/fy start unset — a node's persisted user_x/user_y is only ever
        // its *starting* x/y (baked into n.x/n.y before this is called, see
        // savedLayout.ts's startingPositions), not a standing pin (#46: dragging
        // used to set a permanent one; a drop is now just a starting point
        // like any server seed, free to move under real physics from here).
        // After this, only Canvas.tsx's drag handling (for one drag) and a
        // local settle (until it ends) ever set fx/fy on this object.
        nodesByKey.set(n.key, { id: n.key, x: n.x, y: n.y, radius: n.radius })
        // A saved resting spot only counts as settled when the whole map
        // arrives together. Joining a map that has moved on since, it's
        // just a good place to start.
        if (!(firstPopulation && n.atRest)) unsettled.add(n.key)
      }
    }

    const nodesArray = wanted.map((n) => nodesByKey.get(n.key)!)
    const linksArray: SimLink[] = links
      .filter((l) => nodesByKey.has(l.source) && nodesByKey.has(l.target))
      .map((l) => ({ source: l.source, target: l.target }))

    adjacency = new Map()
    const neighboursOf = (key: string) => {
      let list = adjacency.get(key)
      if (!list) adjacency.set(key, (list = []))
      return list
    }
    for (const l of linksArray) {
      neighboursOf(l.source as string).push(l.target as string)
      neighboursOf(l.target as string).push(l.source as string)
    }

    simulation.nodes(nodesArray)
    link.links(linksArray)

    if (firstPopulation && wanted.length > 0 && unsettled.size === 0) {
      // The saved layout, exactly as saved. alpha(0) rather than a bare
      // stop, so an unlock later has nothing left over to spend.
      simulation.alpha(0).stop()
      hasEverSettled = true
      return
    }
    if (unsettled.size === 0) return

    const mapAtRest = firstPopulation ? unsettled.size < wanted.length : held.size > 0 || simulation.alpha() < simulation.alphaMin()
    if (mapAtRest) settleLocally(unsettled)
    else reheat()
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

  return { simulation, nodesByKey, sync, openedOnSavedLayout: () => openedOnSavedLayout, setParams, setLocked }
}
