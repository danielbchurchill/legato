import { describe, expect, it } from 'vitest'
import {
  EDGE_SPEED,
  EDGE_ZONE,
  FULL_SWIPE_FRACTION,
  ROW_HEIGHT,
  SWIPE_ACTION_WIDTH,
  edgeScrollSpeed,
  holdBroken,
  moveEntry,
  reorderTarget,
  rowShift,
  swipeOffset,
  swipeRelease,
} from './queueGestures'
import { DRAG_SLOP, FLICK_VELOCITY } from './sheetGeometry'

describe('holdBroken', () => {
  it('lets a finger wander under the slop while it holds', () => {
    expect(holdBroken(DRAG_SLOP - 1, -(DRAG_SLOP - 1))).toBe(false)
  })

  it('gives the touch to a scroll, a swipe or the sheet once it moves past it', () => {
    expect(holdBroken(0, DRAG_SLOP)).toBe(true)
    expect(holdBroken(-DRAG_SLOP, 0)).toBe(true)
  })
})

describe('reorderTarget', () => {
  it('lands a lifted row a place on for every row height it has travelled, to the nearest', () => {
    expect(reorderTarget(1, ROW_HEIGHT * 2, 10)).toBe(3)
    expect(reorderTarget(5, -ROW_HEIGHT * 1.4, 10)).toBe(4)
    expect(reorderTarget(5, -ROW_HEIGHT * 1.6, 10)).toBe(3)
    expect(reorderTarget(2, ROW_HEIGHT * 0.4, 10)).toBe(2)
  })

  it('stops at the ends of the list', () => {
    expect(reorderTarget(1, -ROW_HEIGHT * 5, 10)).toBe(0)
    expect(reorderTarget(8, ROW_HEIGHT * 5, 10)).toBe(9)
  })
})

describe('rowShift', () => {
  it('slides the rows a row passes going down up a place', () => {
    expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 1, 3))).toEqual([0, 0, -ROW_HEIGHT, -ROW_HEIGHT, 0])
  })

  it('slides the rows it passes going up down a place', () => {
    expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 3, 1))).toEqual([0, ROW_HEIGHT, ROW_HEIGHT, 0, 0])
  })

  it('moves nothing while the row is over its own place', () => {
    expect([0, 1, 2].map((i) => rowShift(i, 1, 1))).toEqual([0, 0, 0])
  })
})

describe('moveEntry', () => {
  it('reorders as moveUpNext does', () => {
    expect(moveEntry(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveEntry(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })
})

describe('edgeScrollSpeed', () => {
  const top = 300
  const bottom = 800

  it('leaves the list still away from its edges', () => {
    expect(edgeScrollSpeed(550, top, bottom)).toBe(0)
    expect(edgeScrollSpeed(top + EDGE_ZONE, top, bottom)).toBe(0)
  })

  it('scrolls faster the nearer the edge, up at the top and down at the bottom', () => {
    expect(edgeScrollSpeed(top + EDGE_ZONE / 2, top, bottom)).toBeCloseTo(-EDGE_SPEED / 2)
    expect(edgeScrollSpeed(bottom - EDGE_ZONE / 2, top, bottom)).toBeCloseTo(EDGE_SPEED / 2)
  })

  it('tops out at the edge and past it', () => {
    expect(edgeScrollSpeed(top - 40, top, bottom)).toBe(-EDGE_SPEED)
    expect(edgeScrollSpeed(bottom + 40, top, bottom)).toBe(EDGE_SPEED)
  })
})

describe('swipeOffset', () => {
  it('follows the finger left', () => {
    expect(swipeOffset(0, -60, 380)).toBe(60)
  })

  it('carries on from open', () => {
    expect(swipeOffset(SWIPE_ACTION_WIDTH, -20, 380)).toBe(SWIPE_ACTION_WIDTH + 20)
    expect(swipeOffset(SWIPE_ACTION_WIDTH, 30, 380)).toBe(SWIPE_ACTION_WIDTH - 30)
  })

  it('never goes right of closed or past the row', () => {
    expect(swipeOffset(0, 50, 380)).toBe(0)
    expect(swipeOffset(0, -500, 380)).toBe(380)
  })
})

describe('swipeRelease', () => {
  const width = 380

  it('removes the row once swiped most of the way across', () => {
    expect(swipeRelease({ offset: width * FULL_SWIPE_FRACTION, velocity: 0, width })).toBe('remove')
    expect(swipeRelease({ offset: width * FULL_SWIPE_FRACTION, velocity: -FLICK_VELOCITY, width })).toBe('remove')
  })

  it('stays open once remove is half showing, and closes short of that', () => {
    expect(swipeRelease({ offset: SWIPE_ACTION_WIDTH / 2, velocity: 0, width })).toBe('open')
    expect(swipeRelease({ offset: SWIPE_ACTION_WIDTH / 2 - 1, velocity: 0, width })).toBe('closed')
  })

  it('opens on a flick left and closes on a flick right, whatever the distance', () => {
    expect(swipeRelease({ offset: 12, velocity: FLICK_VELOCITY, width })).toBe('open')
    expect(swipeRelease({ offset: 150, velocity: -FLICK_VELOCITY, width })).toBe('closed')
  })
})
