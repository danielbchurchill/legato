import { describe, expect, it } from 'vitest'
import { NEAR_TIE_PX, TAP_REACH_PX, pickTapTarget, type TapCandidate } from './tapPick'

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
