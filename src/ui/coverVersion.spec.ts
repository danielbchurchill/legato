// #461: a changed cover is asked for again once, on the nodes showing it.
import { describe, expect, it } from 'vitest'
import { applyCoverEvent, coverChanged, coverChanging, coverVersionOf as versionOf, withCoverVersion } from './coverVersion'

// Module state carries across tests, so each uses its own node ids.

describe('cover versions', () => {
  it("leaves a URL alone until its node's cover changes", () => {
    expect(withCoverVersion('/nodes/1/cover?size=thumb', 0)).toBe('/nodes/1/cover?size=thumb')
    expect(withCoverVersion('/nodes/1/cover?size=thumb', 2)).toBe('/nodes/1/cover?size=thumb&v=2')
  })

  it('bumps the nodes showing a cover once, however often the list names one', () => {
    applyCoverEvent({ kind: 'cover', nodeId: 10, nodeIds: [10, 11, 11, 12] })
    expect([10, 11, 12, 13].map(versionOf)).toEqual([1, 1, 1, 0])
  })

  it("ignores other enrichment, which doesn't change a cover", () => {
    applyCoverEvent({ kind: 'description', nodeId: 20 })
    expect(versionOf(20)).toBe(0)
  })

  // The server sends its event before it answers, so this device's own
  // change usually hears the event first.
  it("counts this device's change once when the server's event comes first", () => {
    coverChanging(30)
    applyCoverEvent({ kind: 'cover', nodeId: 30, nodeIds: [30, 31] })
    coverChanged(30, [30, 31])
    expect([30, 31].map(versionOf)).toEqual([1, 1])
  })

  it('and once when the answer comes first', () => {
    coverChanging(40)
    coverChanged(40, [40, 41])
    applyCoverEvent({ kind: 'cover', nodeId: 40, nodeIds: [40, 41] })
    expect([40, 41].map(versionOf)).toEqual([1, 1])
  })

  it('bumps nothing for a change that failed', () => {
    coverChanging(50)
    coverChanged(50, [], false)
    expect(versionOf(50)).toBe(0)
  })
})
