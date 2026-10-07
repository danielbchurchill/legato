import { describe, expect, it } from 'vitest'
import { createForceSimulation, type SimNodeInput } from './forceSimulation'

// #46 ("Refine music map node control"): a dragged node used to get a
// permanent d3-force pin (.fx/.fy, never cleared) — it would never move
// again regardless of what happened to anything connected to it, which is
// the literal bug report. Canvas.tsx now clears a node's fx/fy on mouseup
// instead of leaving it set, via the same nodesByKey map a drag already
// used to set it — these tests exercise that mechanism directly, without a
// browser/DOM/Sigma renderer, which is what actually made the bug possible
// to reproduce without one.

function tick(sim: ReturnType<typeof createForceSimulation>, n: number): void {
  for (let i = 0; i < n; i++) sim.simulation.tick()
}

describe('createForceSimulation — drag pin release (#46)', () => {
  const nodes: SimNodeInput[] = [
    { key: 'a', x: 0, y: 0, radius: 5 },
    { key: 'b', x: 500, y: 0, radius: 5 },
  ]
  const links = [{ source: 'a', target: 'b' }]

  it('holds a node exactly in place while fx/fy is set, regardless of its linked neighbor moving', () => {
    const sim = createForceSimulation(() => {})
    sim.sync(nodes, links)

    const a = sim.nodesByKey.get('a')!
    const b = sim.nodesByKey.get('b')!
    a.fx = 0
    a.fy = 0
    b.fx = 2000 // simulates dragging b far away while a stays pinned
    b.fy = 2000
    tick(sim, 60)

    expect(a.x).toBe(0)
    expect(a.y).toBe(0)
  })

  it('lets a released node drift toward a neighbor that moves after the pin is cleared', () => {
    const sim = createForceSimulation(() => {})
    sim.sync(nodes, links)

    const a = sim.nodesByKey.get('a')!
    const b = sim.nodesByKey.get('b')!

    // Drag a into place, then release — Canvas.tsx's handleMouseUp recipe.
    a.fx = 0
    a.fy = 0
    a.fx = null
    a.fy = null

    // Now drag b far away and hold it there, same as before.
    b.fx = 2000
    b.fy = 2000
    tick(sim, 300)

    // a is no longer welded to (0, 0) — its own link to b, now sitting at
    // (2000, 2000), should have pulled it a meaningful distance from where
    // it started. This is exactly the behavior the old permanent pin made
    // impossible.
    const distanceMoved = Math.hypot(a.x! - 0, a.y! - 0)
    expect(distanceMoved).toBeGreaterThan(50)
  })

  it("a freshly-synced node starts with no pin at all — dropping it is a starting point, not a standing pin", () => {
    const sim = createForceSimulation(() => {})
    sim.sync(nodes, links)

    const a = sim.nodesByKey.get('a')!
    expect(a.fx).toBeUndefined()
    expect(a.fy).toBeUndefined()
  })
})

// #274: the map keeps its layout between visits. The client saves where the
// physics came to rest, and a visit that finds every node at a saved spot
// shows it as saved; a change to a map at rest moves only what's near it.
// These measure that with numbers rather than by eye.

type Library = { nodes: SimNodeInput[]; links: { source: string; target: string }[]; clusterOf: Map<string, string> }

// Six artists, two records each, six tracks a record, seeded the way
// server/src/layout/cluster.ts does: one cell per artist, tracks bunched
// near its middle, two per record on exactly the same point so d3's jiggle
// gets used. Records and artists sit at their tracks' centroid.
function library(): Library {
  const nodes: SimNodeInput[] = []
  const links: { source: string; target: string }[] = []
  const clusterOf = new Map<string, string>()
  let id = 1
  for (let a = 0; a < 6; a++) {
    const artist = String(id++)
    const cx = (a % 3) * 400
    const cy = Math.floor(a / 3) * 400
    nodes.push({ key: artist, x: cx, y: cy, radius: 6 })
    clusterOf.set(artist, artist)
    for (let r = 0; r < 2; r++) {
      const release = String(id++)
      nodes.push({ key: release, x: cx + r, y: cy - r, radius: 4 })
      clusterOf.set(release, artist)
      for (let t = 0; t < 6; t++) {
        const track = String(id++)
        const spread = t < 2 ? 0 : t
        nodes.push({ key: track, x: cx + spread, y: cy + r * 3, radius: 3 })
        clusterOf.set(track, artist)
        links.push({ source: track, target: release }, { source: track, target: artist })
      }
    }
  }
  return { nodes, links, clusterOf }
}

const PARAMS = { centerStrength: 0.03, repelStrength: 150, linkStrength: 0.15, linkDistance: 80 }

function newSim(): ReturnType<typeof createForceSimulation> {
  const sim = createForceSimulation(() => {})
  sim.setParams(PARAMS)
  return sim
}

// Runs to rest by hand, the way the real timer does it one frame at a time,
// then stops the timer so it can't add ticks of its own.
function settle(sim: ReturnType<typeof createForceSimulation>): void {
  while (sim.simulation.alpha() >= sim.simulation.alphaMin()) sim.simulation.tick()
  sim.simulation.stop()
}

function positions(sim: ReturnType<typeof createForceSimulation>): Map<string, { x: number; y: number }> {
  return new Map([...sim.nodesByKey].map(([key, n]) => [key, { x: n.x!, y: n.y! }]))
}

function savedLayout(): Map<string, { x: number; y: number }> {
  const { nodes, links } = library()
  const sim = newSim()
  sim.sync(nodes, links)
  settle(sim)
  return positions(sim)
}

describe('createForceSimulation — a saved layout (#274)', () => {
  it('settles the same seeds to the same layout every time, to the bit', () => {
    expect(savedLayout()).toEqual(savedLayout())
  })

  it('opens a layout saved at rest exactly as saved, with no physics running', async () => {
    const saved = savedLayout()
    const { nodes, links } = library()
    const sim = newSim()
    sim.sync(nodes.map((n) => ({ ...n, ...saved.get(n.key)!, atRest: true })), links)

    expect(sim.openedOnSavedLayout()).toBe(true)
    expect(sim.simulation.alpha()).toBe(0)
    // Long enough for d3's own timer to have ticked several times if it
    // were still running.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(positions(sim)).toEqual(saved)
    for (const node of sim.nodesByKey.values()) expect(node.fx ?? null).toBeNull()
  })

  it('opens a locked map that was saved at rest the same way', () => {
    const saved = savedLayout()
    const { nodes, links } = library()
    const sim = newSim()
    sim.setLocked(true)
    sim.sync(nodes.map((n) => ({ ...n, ...saved.get(n.key)!, atRest: true })), links)
    sim.simulation.tick()
    sim.simulation.stop()
    expect(positions(sim)).toEqual(saved)
  })

  it('settles the whole map when nothing has been saved yet, as before', () => {
    const { nodes, links } = library()
    const sim = newSim()
    sim.sync(nodes, links)
    sim.simulation.stop()
    expect(sim.openedOnSavedLayout()).toBe(false)
    expect(sim.simulation.alpha()).toBeGreaterThan(sim.simulation.alphaMin())
    for (const node of sim.nodesByKey.values()) expect(node.fx).toBeUndefined()
  })

  // Three new tracks on the first artist's first record, started beside
  // that record the way savedLayout.ts's startingPositions places them.
  function openWithNewTracks(saved: Map<string, { x: number; y: number }>) {
    const { nodes, links } = library()
    const release = saved.get('2')!
    const added: SimNodeInput[] = [101, 102, 103].map((id) => ({
      key: String(id),
      x: release.x + Math.cos(id) * 6,
      y: release.y + Math.sin(id) * 6,
      radius: 3,
    }))
    const sim = newSim()
    sim.sync(
      [...nodes.map((n) => ({ ...n, ...saved.get(n.key)!, atRest: true })), ...added],
      [...links, ...added.flatMap((n) => [{ source: n.key, target: '2' }, { source: n.key, target: '1' }])],
    )
    settle(sim)
    return sim
  }

  it('moves only the cluster a few new tracks join, and leaves the rest of the map exactly where it was', () => {
    const saved = savedLayout()
    const { clusterOf } = library()
    const sim = openWithNewTracks(saved)
    const after = positions(sim)
    expect(sim.openedOnSavedLayout()).toBe(true)

    let clusterMoved = 0
    for (const [key, before] of saved) {
      const now = after.get(key)!
      if (clusterOf.get(key) === '1') clusterMoved = Math.max(clusterMoved, Math.hypot(now.x - before.x, now.y - before.y))
      else expect(now).toEqual(before)
    }
    expect(clusterMoved).toBeGreaterThan(0)

    // The new tracks found room: nothing overlaps them.
    for (const key of ['101', '102', '103']) {
      const a = sim.nodesByKey.get(key)!
      for (const [otherKey, b] of sim.nodesByKey) {
        if (otherKey === key) continue
        expect(Math.hypot(a.x! - b.x!, a.y! - b.y!)).toBeGreaterThanOrEqual(a.radius + b.radius)
      }
    }
  })

  it('settles the same change the same way on every visit', () => {
    const saved = savedLayout()
    expect(positions(openWithNewTracks(saved))).toEqual(positions(openWithNewTracks(saved)))
  })

  it('moves only what neighboured a removed track', () => {
    const saved = savedLayout()
    const { nodes, links, clusterOf } = library()
    const sim = newSim()
    sim.sync(nodes.map((n) => ({ ...n, ...saved.get(n.key)!, atRest: true })), links)

    // Track 3 is on the first artist's first record.
    sim.sync(
      nodes.filter((n) => n.key !== '3').map((n) => ({ ...n, ...saved.get(n.key)! })),
      links.filter((l) => l.source !== '3'),
    )
    settle(sim)

    const after = positions(sim)
    for (const [key, before] of saved) {
      if (key === '3' || clusterOf.get(key) === '1') continue
      expect(after.get(key)).toEqual(before)
    }
  })

  it('frees the whole map again once a local settle ends', async () => {
    const saved = savedLayout()
    const { nodes, links } = library()
    const sim = newSim()
    sim.sync(nodes.map((n) => ({ ...n, ...saved.get(n.key)!, atRest: true })), links)
    sim.sync(
      [...nodes.map((n) => ({ ...n, ...saved.get(n.key)! })), { key: '101', x: saved.get('2')!.x + 6, y: saved.get('2')!.y, radius: 3 }],
      [...links, { source: '101', target: '2' }],
    )
    expect(sim.nodesByKey.get('40')!.fx).toBe(saved.get('40')!.x)

    // A high alphaMin so d3's own timer reaches 'end' in a few frames.
    sim.simulation.alphaMin(0.35)
    await new Promise<void>((resolve) => sim.simulation.on('end.test', () => resolve()))
    for (const node of sim.nodesByKey.values()) expect(node.fx ?? null).toBeNull()
  })
})
