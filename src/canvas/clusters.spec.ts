import { describe, expect, it } from 'vitest'
import { computeClusters } from './clusters'

const nodes = [
  { id: 1, type: 'artist' },
  { id: 2, type: 'artist' },
  { id: 10, type: 'release' },
  { id: 11, type: 'release' },
  { id: 100, type: 'recording' },
  { id: 101, type: 'recording' },
  { id: 102, type: 'recording' },
  { id: 103, type: 'recording' },
  { id: 500, type: 'credit' },
]

describe('computeClusters', () => {
  it('puts an artist in its own cluster and a track with its first credited artist', () => {
    const { clusterOf } = computeClusters(nodes, [
      { id: 2, from_node: 100, to_node: 2, type: 'performed_by' },
      { id: 1, from_node: 100, to_node: 1, type: 'performed_by' },
    ])
    expect(clusterOf.get(1)).toBe(1)
    expect(clusterOf.get(100)).toBe(1)
  })

  it('gives a record to the artist most of its tracks belong to', () => {
    const { clusterOf, releasesOf } = computeClusters(nodes, [
      { id: 1, from_node: 100, to_node: 1, type: 'performed_by' },
      { id: 2, from_node: 101, to_node: 2, type: 'performed_by' },
      { id: 3, from_node: 102, to_node: 2, type: 'performed_by' },
      { id: 4, from_node: 100, to_node: 10, type: 'appears_on' },
      { id: 5, from_node: 101, to_node: 10, type: 'appears_on' },
      { id: 6, from_node: 102, to_node: 10, type: 'appears_on' },
    ])
    expect(clusterOf.get(10)).toBe(2)
    expect(releasesOf.get(2)).toEqual([10])
    expect(releasesOf.get(1)).toBeUndefined()
  })

  it('counts only tracks toward a record, not an artist drawn onto it by hand', () => {
    const { clusterOf } = computeClusters(nodes, [
      { id: 1, from_node: 100, to_node: 2, type: 'performed_by' },
      { id: 2, from_node: 100, to_node: 10, type: 'appears_on' },
      { id: 3, from_node: 1, to_node: 10, type: 'appears_on' },
    ])
    expect(clusterOf.get(10)).toBe(2)
  })

  it('breaks a tied vote toward the lower artist id', () => {
    const { clusterOf } = computeClusters(nodes, [
      { id: 1, from_node: 100, to_node: 2, type: 'performed_by' },
      { id: 2, from_node: 101, to_node: 1, type: 'performed_by' },
      { id: 3, from_node: 100, to_node: 11, type: 'appears_on' },
      { id: 4, from_node: 101, to_node: 11, type: 'appears_on' },
    ])
    expect(clusterOf.get(11)).toBe(1)
  })

  it('leaves credits and unattributed tracks out of every cluster', () => {
    const { clusterOf } = computeClusters(nodes, [{ id: 1, from_node: 103, to_node: 500, type: 'produced_by' }])
    expect(clusterOf.has(500)).toBe(false)
    expect(clusterOf.has(103)).toBe(false)
  })
})
