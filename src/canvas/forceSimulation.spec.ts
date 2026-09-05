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
