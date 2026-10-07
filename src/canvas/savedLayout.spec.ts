import { describe, expect, it } from 'vitest'
import { movedSince, savedSpot, startingPositions } from './savedLayout'
import type { GraphEdge, GraphNode } from './useGraphData'

// #274: where a node joining the map starts, and what a settle has to save.

function node(id: number, fields: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'recording',
    title: `node ${id}`,
    mbid: null,
    canonical_duration_ms: null,
    seed_x: id * 1000,
    seed_y: -id * 1000,
    user_x: null,
    user_y: null,
    settled_x: null,
    settled_y: null,
    cover_hash: null,
    subtitle: null,
    ...fields,
  }
}

let edgeId = 1
function edge(from: number, to: number, type = 'performed_by'): GraphEdge {
  return { id: edgeId++, from_node: from, to_node: to, type, source: 'local', label: null, note: null }
}

const nothingPlaced = () => null

describe('savedSpot', () => {
  it("reads a drag's user position first, then the last resting spot", () => {
    expect(savedSpot(node(1, { user_x: 1, user_y: 2, settled_x: 3, settled_y: 4 }))).toEqual({ x: 1, y: 2 })
    expect(savedSpot(node(1, { settled_x: 3, settled_y: 4 }))).toEqual({ x: 3, y: 4 })
    expect(savedSpot(node(1))).toBeNull()
  })
})

describe('startingPositions', () => {
  it('starts a node at its saved resting spot, at rest', () => {
    const starts = startingPositions([node(1, { settled_x: 5, settled_y: 6 })], [], nothingPlaced)
    expect(starts.get(1)).toEqual({ x: 5, y: 6, atRest: true })
  })

  it('starts a node dragged before resting spots were saved at its drop, but not at rest', () => {
    const starts = startingPositions([node(1, { user_x: 7, user_y: 8 })], [], nothingPlaced)
    expect(starts.get(1)).toEqual({ x: 7, y: 8, atRest: false })
  })

  it('starts the whole map at its seeds when nothing is placed or saved: a first visit', () => {
    const starts = startingPositions([node(1), node(2), node(3)], [edge(2, 1), edge(3, 1)], nothingPlaced)
    expect(starts.get(1)).toEqual({ x: 1000, y: -1000, atRest: false })
    expect(starts.get(2)).toEqual({ x: 2000, y: -2000, atRest: false })
    expect(starts.get(3)).toEqual({ x: 3000, y: -3000, atRest: false })
  })

  it('starts a new track beside the artist and record it joins, not at its seed', () => {
    const placed = new Map([
      [10, { x: 100, y: 100 }],
      [20, { x: 120, y: 100 }],
    ])
    const starts = startingPositions([node(1)], [edge(1, 10), edge(1, 20, 'appears_on')], (id) => placed.get(id) ?? null)
    const start = starts.get(1)!
    expect(start.atRest).toBe(false)
    expect(Math.hypot(start.x - 110, start.y - 100)).toBeCloseTo(6)
  })

  it('places a new record beside its new tracks once they are placed beside their artist', () => {
    const starts = startingPositions(
      [node(1), node(2), node(5, { type: 'release' })],
      [edge(1, 10), edge(2, 10), edge(1, 5, 'appears_on'), edge(2, 5, 'appears_on')],
      (id) => (id === 10 ? { x: 0, y: 0 } : null),
    )
    const record = starts.get(5)!
    expect(Math.hypot(record.x, record.y)).toBeLessThan(20)
  })

  it('starts two new tracks beside the same neighbours apart from each other', () => {
    const starts = startingPositions([node(1), node(2)], [edge(1, 10), edge(2, 10)], () => ({ x: 0, y: 0 }))
    const a = starts.get(1)!
    const b = starts.get(2)!
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1)
  })

  it('starts a new artist with no placed neighbour at its seed', () => {
    const starts = startingPositions([node(1), node(2, { type: 'artist' })], [edge(1, 2)], () => null)
    expect(starts.get(2)).toEqual({ x: 2000, y: -2000, atRest: false })
  })

  it('gives the same answer for the same input', () => {
    const run = () =>
      startingPositions([node(1), node(2), node(3)], [edge(1, 10), edge(2, 1), edge(3, 2)], (id) => (id === 10 ? { x: 4, y: 4 } : null))
    expect(run()).toEqual(run())
  })
})

describe('movedSince', () => {
  it('sends a node never saved, and one that moved, but not one still where it was saved', () => {
    const saved = new Map([
      ['1', { x: 1, y: 1 }],
      ['2', { x: 2, y: 2 }],
    ])
    const current: [string, { x: number; y: number }][] = [
      ['1', { x: 1, y: 1 }],
      ['2', { x: 2, y: 2.0000001 }],
      ['3', { x: 3, y: 3 }],
    ]
    expect(movedSince(saved, current)).toEqual([
      { id: 2, x: 2, y: 2.0000001 },
      { id: 3, x: 3, y: 3 },
    ])
  })
})
