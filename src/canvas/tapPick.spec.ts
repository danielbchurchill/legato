import { describe, expect, it } from 'vitest'
import { MOUSE_REACH_PX, NEAR_TIE_PX, TAP_REACH_PX, pickMouseTarget, pickTapTarget, type TapCandidate } from './tapPick'

const viewport = { width: 390, height: 844 }
const tap = { x: 200, y: 400 }

// Radii as drawn at camera ratio 1 (Canvas.tsx).
const TRACK = 1.5
const RECORD = 2.6
const ARTIST = 9.5

/** A dot whose drawn edge is `gap` px to the right of the tap. */
const dot = (key: string, radius: number, gap: number, extra: Partial<TapCandidate> = {}): TapCandidate => ({
  key,
  x: tap.x + radius + gap,
  y: tap.y,
  radius,
  labelled: false,
  ...extra,
})

describe('pickTapTarget', () => {
  it('picks a node the tap lands inside', () => {
    expect(pickTapTarget(tap, [{ key: 'track', x: tap.x + 1, y: tap.y - 0.5, radius: TRACK, labelled: false }], viewport)).toBe('track')
  })

  it('picks a tiny node the tap misses, if it is within reach', () => {
    expect(pickTapTarget(tap, [dot('track', TRACK, 15)], viewport)).toBe('track')
    expect(pickTapTarget(tap, [dot('track', TRACK, TAP_REACH_PX)], viewport)).toBe('track')
  })

  it('picks nothing when no node is in reach', () => {
    expect(pickTapTarget(tap, [], viewport)).toBeNull()
    expect(pickTapTarget(tap, [dot('track', TRACK, TAP_REACH_PX + 0.5), dot('record', RECORD, 40)], viewport)).toBeNull()
  })

  it('picks the nearest of several nodes', () => {
    const left = { key: 'left', x: tap.x - 12, y: tap.y, radius: TRACK, labelled: false }
    expect(pickTapTarget(tap, [left, dot('right', TRACK, 3)], viewport)).toBe('right')
  })

  it('measures reach to the drawn edge, not the centre', () => {
    // Its centre is 30px away, but its edge only 20.5px.
    expect(pickTapTarget(tap, [{ key: 'artist', x: tap.x + 30, y: tap.y, radius: ARTIST, labelled: false }], viewport)).toBe('artist')
  })

  it('lets a larger node win a near tie', () => {
    expect(pickTapTarget(tap, [dot('track', TRACK, 1), dot('record', RECORD, 1 + NEAR_TIE_PX - 0.25)], viewport)).toBe('record')
  })

  it('lets the nearer node win once the larger one is more than the tie further away', () => {
    expect(pickTapTarget(tap, [dot('track', TRACK, 1), dot('record', RECORD, 1 + NEAR_TIE_PX + 0.25)], viewport)).toBe('track')
  })

  it('lets a labelled node win a near tie, even against a larger one', () => {
    const record = dot('record', RECORD, 1)
    const credit = (gap: number) => dot('credit', 2.4, gap, { labelled: true })
    expect(pickTapTarget(tap, [record, credit(1 + NEAR_TIE_PX - 0.25)], viewport)).toBe('credit')
    expect(pickTapTarget(tap, [record, credit(1 + NEAR_TIE_PX + 0.25)], viewport)).toBe('record')
  })

  it('takes the larger of two dots a tap lands inside both of', () => {
    const artist = { key: 'artist', x: tap.x + 6, y: tap.y, radius: ARTIST, labelled: false }
    expect(pickTapTarget(tap, [{ key: 'record', x: tap.x, y: tap.y, radius: RECORD, labelled: false }, artist], viewport)).toBe('artist')
  })

  it('ignores hidden nodes', () => {
    expect(pickTapTarget(tap, [dot('hidden', ARTIST, 0, { hidden: true }), dot('track', TRACK, 10)], viewport)).toBe('track')
    expect(pickTapTarget(tap, [dot('hidden', TRACK, 0, { hidden: true })], viewport)).toBeNull()
  })

  it('ignores nodes off screen, but not one partly on it', () => {
    const nearEdge = { x: 5, y: 400 }
    expect(pickTapTarget(nearEdge, [{ key: 'off', x: -2, y: 400, radius: TRACK, labelled: false }], viewport)).toBeNull()
    expect(pickTapTarget(nearEdge, [{ key: 'partly', x: -2, y: 400, radius: ARTIST, labelled: false }], viewport)).toBe('partly')
  })
})

describe('pickMouseTarget', () => {
  const desktop = { width: 1440, height: 900 }

  it('reaches less far than a finger, and still makes a track a 24px target', () => {
    expect(MOUSE_REACH_PX).toBeLessThan(TAP_REACH_PX)
    expect(2 * (MOUSE_REACH_PX + TRACK)).toBeGreaterThanOrEqual(24)
  })

  it('picks a node the pointer lands inside', () => {
    expect(pickMouseTarget(tap, [{ key: 'track', x: tap.x + 1, y: tap.y - 0.5, radius: TRACK, labelled: false }], desktop)).toBe('track')
  })

  it('picks a track the pointer misses, up to the reach past its edge', () => {
    expect(pickMouseTarget(tap, [dot('track', TRACK, 6)], desktop)).toBe('track')
    expect(pickMouseTarget(tap, [dot('track', TRACK, MOUSE_REACH_PX)], desktop)).toBe('track')
    expect(pickMouseTarget(tap, [dot('track', TRACK, MOUSE_REACH_PX + 0.5)], desktop)).toBeNull()
  })

  it('picks nothing where a finger would still pick, so a click there clears the selection', () => {
    const track = dot('track', TRACK, MOUSE_REACH_PX + 4)
    expect(pickTapTarget(tap, [track], desktop)).toBe('track')
    expect(pickMouseTarget(tap, [track], desktop)).toBeNull()
    expect(pickMouseTarget(tap, [], desktop)).toBeNull()
  })

  it('works in any direction from the pointer', () => {
    const at = (key: string, dx: number, dy: number): TapCandidate => ({
      key,
      x: tap.x + dx,
      y: tap.y + dy,
      radius: TRACK,
      labelled: false,
    })
    expect(pickMouseTarget(tap, [at('above', 0, -8)], desktop)).toBe('above')
    expect(pickMouseTarget(tap, [at('left', -8, 0)], desktop)).toBe('left')
    // 8px each way is 11.3px to the centre, 9.8px to the edge.
    expect(pickMouseTarget(tap, [at('diagonal', 8, 8)], desktop)).toBe('diagonal')
    expect(pickMouseTarget(tap, [at('far diagonal', 10, 10)], desktop)).toBeNull()
  })

  it('measures reach to the drawn edge, not the centre', () => {
    // Its centre is 19px away, but its edge only 9.5px.
    expect(pickMouseTarget(tap, [{ key: 'artist', x: tap.x + 19, y: tap.y, radius: ARTIST, labelled: false }], desktop)).toBe('artist')
  })

  it('picks the nearest of several nodes', () => {
    const left = { key: 'left', x: tap.x - 9, y: tap.y, radius: TRACK, labelled: false }
    expect(pickMouseTarget(tap, [left, dot('right', TRACK, 2)], desktop)).toBe('right')
  })

  it('breaks a near tie the way a tap does: labelled, then larger, then nearer', () => {
    expect(pickMouseTarget(tap, [dot('track', TRACK, 1), dot('record', RECORD, 1 + NEAR_TIE_PX - 0.25)], desktop)).toBe('record')
    expect(pickMouseTarget(tap, [dot('track', TRACK, 1), dot('record', RECORD, 1 + NEAR_TIE_PX + 0.25)], desktop)).toBe('track')
    const record = dot('record', RECORD, 1)
    expect(pickMouseTarget(tap, [record, dot('credit', 2.4, 1 + NEAR_TIE_PX - 0.25, { labelled: true })], desktop)).toBe('credit')
    expect(pickMouseTarget(tap, [dot('a', TRACK, 1), dot('b', TRACK, 2)], desktop)).toBe('a')
  })

  it('lets nothing past the reach win a tie, though a finger would take it', () => {
    const track = dot('track', TRACK, MOUSE_REACH_PX - 2)
    const credit = dot('credit', 2.4, MOUSE_REACH_PX + 1, { labelled: true })
    expect(pickMouseTarget(tap, [track, credit], desktop)).toBe('track')
    expect(pickTapTarget(tap, [track, credit], desktop)).toBe('credit')
  })

  it('ignores hidden nodes and nodes off screen', () => {
    expect(pickMouseTarget(tap, [dot('hidden', ARTIST, 0, { hidden: true }), dot('track', TRACK, 5)], desktop)).toBe('track')
    expect(pickMouseTarget({ x: 3, y: 400 }, [{ key: 'off', x: -2, y: 400, radius: TRACK, labelled: false }], desktop)).toBeNull()
  })
})
